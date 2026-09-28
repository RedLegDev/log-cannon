package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// maxQueryWindow stays under the logs endpoint's 24-hour cap on
// iso_timestamp_start..iso_timestamp_end. A longer catch-up walks windows.
const maxQueryWindow = 23 * time.Hour

// Row is one row of the Supabase unified logs stream.
type Row struct {
	ID         string
	Timestamp  time.Time
	Message    string
	Severity   string
	Attributes map[string]any
}

// Cursor is a keyset position: the next page holds rows strictly after
// (Timestamp, ID). An empty ID means "from Timestamp inclusive". Keying on the
// id as well as the timestamp is what lets a page boundary fall inside a run of
// equal timestamps — auth_logs stamps whole seconds — without looping or
// skipping.
type Cursor struct {
	Timestamp time.Time
	ID        string
}

type LogAPI interface {
	// Query returns up to limit rows of table after cur, inside [from, to],
	// ordered by (timestamp, id).
	Query(ctx context.Context, ref, table string, cur Cursor, from, to time.Time, limit int) ([]Row, error)
}

// The logs endpoint allows 10 requests per window per project and answers
// 429 with Retry-After beyond that. Steady state is one request per table per
// run, well inside it; a catch-up of many pages is not, so a 429 waits and
// retries rather than failing the table.
//
// The endpoint also fails transiently — 502, 504, 500, timeouts, and DNS
// failures on the host, all seen in the retired poller's log — so those get
// a couple of short retries before the table is counted as failed.
const (
	maxRateLimitWait    = 90 * time.Second
	maxRateLimitRetries = 5
	transientRetries    = 2
	transientWait       = 5 * time.Second
)

// errBackend is the endpoint's own "Backend error! Retry your query", which
// arrives as HTTP 200 with an error body and clears on retry (seen in prod
// 2026-09-28). It is retried like a 5xx.
var errBackend = errors.New("supabase logs backend error")

// ErrRateLimited is a 429 that outlasted the retries.
var ErrRateLimited = errors.New("supabase logs API rate limit")

// ErrAuth marks a PAT the API refused. It is not transient, so it is reported
// separately from a failed request.
var ErrAuth = errors.New("supabase rejected the access token")

type supabaseAPI struct {
	baseURL string
	token   string
	http    *http.Client
	sleep   func(context.Context, time.Duration) error
}

func newSupabaseAPI(baseURL, token string) *supabaseAPI {
	return &supabaseAPI{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    &http.Client{Timeout: 30 * time.Second},
		sleep:   sleepCtx,
	}
}

func (a *supabaseAPI) Query(ctx context.Context, ref, table string, cur Cursor, from, to time.Time, limit int) ([]Row, error) {
	params := url.Values{
		"sql":                 {buildSQL(table, cur, limit)},
		"iso_timestamp_start": {from.UTC().Truncate(time.Second).Format("2006-01-02T15:04:05Z")},
		"iso_timestamp_end":   {to.UTC().Add(time.Second - 1).Truncate(time.Second).Format("2006-01-02T15:04:05Z")},
	}
	endpoint := fmt.Sprintf("%s/v1/projects/%s/analytics/endpoints/logs?%s", a.baseURL, url.PathEscape(ref), params.Encode())

	limited, transient := 0, 0
	for {
		status, header, body, err := a.get(ctx, endpoint)
		var wait time.Duration
		switch {
		case ctx.Err() != nil:
			return nil, ctx.Err()
		case status == http.StatusTooManyRequests:
			if limited == maxRateLimitRetries {
				return nil, fmt.Errorf("%w: still limited after %d retries", ErrRateLimited, limited)
			}
			limited++
			wait = retryAfter(header.Get("Retry-After"))
		case err != nil || status >= 500:
			if transient == transientRetries {
				if err != nil {
					return nil, err
				}
				return checkResponse(status, body)
			}
			transient++
			wait = transientWait
		default:
			rows, err := checkResponse(status, body)
			if !errors.Is(err, errBackend) || transient == transientRetries {
				return rows, err
			}
			transient++
			wait = transientWait
		}
		if err := a.sleep(ctx, wait); err != nil {
			return nil, err
		}
	}
}

func (a *supabaseAPI) get(ctx context.Context, endpoint string) (int, http.Header, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	req.Header.Set("User-Agent", "log-cannon-supabase-pull/1.0")

	resp, err := a.http.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	return resp.StatusCode, resp.Header, body, err
}

// retryAfter reads the seconds form of Retry-After, which is what the logs
// endpoint sends, plus a second of slack, bounded. Anything unreadable waits a
// full minute.
func retryAfter(v string) time.Duration {
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n <= 0 {
		return time.Minute
	}
	return min(time.Duration(n)*time.Second+time.Second, maxRateLimitWait)
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func checkResponse(status int, body []byte) ([]Row, error) {
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return nil, fmt.Errorf("%w (HTTP %d)", ErrAuth, status)
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("supabase logs API returned HTTP %d: %s", status, snippet(body))
	}
	return parseResponse(body)
}

func buildSQL(table string, cur Cursor, limit int) string {
	ts := "toDateTime64('" + cur.Timestamp.UTC().Format("2006-01-02 15:04:05.000000") + "', 6, 'UTC')"
	where := "timestamp >= " + ts
	if cur.ID != "" {
		where = fmt.Sprintf("(timestamp > %s OR (timestamp = %s AND id > '%s'))", ts, ts, sqlEscape(cur.ID))
	}
	return fmt.Sprintf(
		"SELECT id, timestamp, event_message, severity_text, log_attributes FROM logs "+
			"WHERE source = '%s' AND %s ORDER BY timestamp ASC, id ASC LIMIT %d",
		sqlEscape(table), where, limit,
	)
}

func sqlEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(s)
}

func parseResponse(body []byte) ([]Row, error) {
	var resp struct {
		Result []map[string]any `json:"result"`
		Error  any              `json:"error"`
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&resp); err != nil {
		return nil, fmt.Errorf("decode supabase logs response: %w", err)
	}
	if resp.Error != nil {
		b, _ := json.Marshal(resp.Error)
		if strings.Contains(string(b), "Retry your query") {
			return nil, fmt.Errorf("%w: %s", errBackend, snippet(b))
		}
		return nil, fmt.Errorf("supabase logs API error: %s", snippet(b))
	}

	rows := make([]Row, 0, len(resp.Result))
	for _, r := range resp.Result {
		ts, err := parseTimestamp(r["timestamp"])
		if err != nil {
			// Without a timestamp the row cannot be placed or deduplicated, and
			// skipping it silently would hide a format change. Fail the page.
			return nil, fmt.Errorf("row %v: %w", r["id"], err)
		}
		row := Row{
			ID:        stringOf(r["id"]),
			Timestamp: ts,
			Message:   stringOf(r["event_message"]),
			Severity:  stringOf(r["severity_text"]),
		}
		if attrs, ok := r["log_attributes"].(map[string]any); ok {
			row.Attributes = attrs
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// parseTimestamp accepts what the endpoint has returned over time: an ISO
// string, ClickHouse's "YYYY-MM-DD HH:MM:SS.ffffff", or epoch microseconds.
func parseTimestamp(v any) (time.Time, error) {
	switch t := v.(type) {
	case json.Number:
		us, err := strconv.ParseInt(t.String(), 10, 64)
		if err != nil {
			return time.Time{}, fmt.Errorf("bad timestamp %q", t)
		}
		return time.UnixMicro(us).UTC(), nil
	case string:
		s := strings.TrimSpace(t)
		for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05.999999999", "2006-01-02T15:04:05.999999999"} {
			if parsed, err := time.Parse(layout, s); err == nil {
				return parsed.UTC(), nil
			}
		}
		return time.Time{}, fmt.Errorf("bad timestamp %q", s)
	}
	return time.Time{}, fmt.Errorf("missing timestamp")
}

func stringOf(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case json.Number:
		return t.String()
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}
