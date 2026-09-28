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

// ErrAuth marks a PAT the API refused. It is not transient, so it is reported
// separately from a failed request.
var ErrAuth = errors.New("supabase rejected the access token")

type supabaseAPI struct {
	baseURL string
	token   string
	http    *http.Client
}

func newSupabaseAPI(baseURL, token string) *supabaseAPI {
	return &supabaseAPI{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

func (a *supabaseAPI) Query(ctx context.Context, ref, table string, cur Cursor, from, to time.Time, limit int) ([]Row, error) {
	params := url.Values{
		"sql":                 {buildSQL(table, cur, limit)},
		"iso_timestamp_start": {from.UTC().Truncate(time.Second).Format("2006-01-02T15:04:05Z")},
		"iso_timestamp_end":   {to.UTC().Add(time.Second - 1).Truncate(time.Second).Format("2006-01-02T15:04:05Z")},
	}
	endpoint := fmt.Sprintf("%s/v1/projects/%s/analytics/endpoints/logs?%s", a.baseURL, url.PathEscape(ref), params.Encode())

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	req.Header.Set("User-Agent", "log-cannon-supabase-pull/1.0")

	resp, err := a.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, fmt.Errorf("%w (HTTP %d)", ErrAuth, resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("supabase logs API returned HTTP %d: %s", resp.StatusCode, snippet(body))
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
		"SELECT id, timestamp, event_message, severity_text, source, log_attributes FROM logs "+
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
