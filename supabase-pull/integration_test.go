package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
)

// TestIntegrationAgainstClickHouse runs the real store and the real HTTP
// client against a ClickHouse built from ./clickhouse. The fake Supabase
// endpoint executes the worker's own SQL against a ClickHouse table shaped
// like the unified logs stream, so the query dialect and keyset are exercised
// for real, not re-implemented.
//
//	docker build -t lc-ch ./clickhouse
//	docker run -d --rm -p 127.0.0.1:19000:9000 -p 127.0.0.1:18123:8123 lc-ch
//	SUPABASE_PULL_IT_CLICKHOUSE=127.0.0.1:19000 SUPABASE_PULL_IT_HTTP=http://127.0.0.1:18123 go test -run Integration ./...
//
// It drops and recreates logs.events, so never point it at a real instance.
func TestIntegrationAgainstClickHouse(t *testing.T) {
	addr, httpURL := os.Getenv("SUPABASE_PULL_IT_CLICKHOUSE"), os.Getenv("SUPABASE_PULL_IT_HTTP")
	if addr == "" || httpURL == "" {
		t.Skip("set SUPABASE_PULL_IT_CLICKHOUSE and SUPABASE_PULL_IT_HTTP to run")
	}
	ctx := context.Background()
	conn, err := clickhouse.Open(&clickhouse.Options{Addr: []string{addr}, Auth: clickhouse.Auth{Database: "logs", Username: "default"}})
	if err != nil {
		t.Fatal(err)
	}
	exec := func(q string) {
		t.Helper()
		if err := conn.Exec(ctx, q); err != nil {
			t.Fatalf("%v\n%s", err, q)
		}
	}
	exec("TRUNCATE TABLE logs.events")
	exec("DROP DATABASE IF EXISTS sbfake")
	exec("CREATE DATABASE sbfake")
	exec(`CREATE TABLE sbfake.logs (id String, timestamp DateTime64(6, 'UTC'), event_message String,
		severity_text String, source String, log_attributes Map(String, String)) ENGINE = MergeTree ORDER BY timestamp`)

	now := time.Now().UTC().Truncate(time.Second)
	sbRows := func(prefix string, start time.Time, step time.Duration, n int, wholeSeconds bool) {
		var vals []string
		for i := 0; i < n; i++ {
			ts := start.Add(time.Duration(i) * step)
			if wholeSeconds {
				ts = ts.Truncate(time.Second)
			}
			vals = append(vals, fmt.Sprintf("('%s-%05d', '%s', '%s msg %d', 'ERROR', 'auth_logs', map('request.path','/p','empty',''))",
				prefix, i, ts.Format("2006-01-02 15:04:05.000000"), prefix, i))
		}
		exec("INSERT INTO sbfake.logs VALUES " + strings.Join(vals, ","))
	}

	// What the Python poller already wrote: 10 minutes of auth rows, stamped
	// in whole seconds, source column Wagner-Server, no sb_id.
	sbRows("legacy", now.Add(-10*time.Minute), 240*time.Millisecond, 2000, true)
	exec(fmt.Sprintf(`INSERT INTO logs.events (timestamp, level, message, source, properties, inserted_at)
		SELECT timestamp, 'Error', event_message, 'Wagner-Server',
		  '{"Source":"it-supabase","LogTable":"auth_logs","ProjectRef":"itref","sb_request_path":"/p"}', now64(3)
		FROM sbfake.logs WHERE timestamp < '%s'`, now.Add(-2*time.Minute).Format("2006-01-02 15:04:05")))
	// The rows the poller had not reached yet.
	sbRows("new", now.Add(-2*time.Minute+time.Millisecond), 100*time.Millisecond, 1100, true)

	var windows []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sbp_test" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		q := r.URL.Query()
		windows = append(windows, q.Get("iso_timestamp_start")+"/"+q.Get("iso_timestamp_end"))
		window := fmt.Sprintf("(SELECT * FROM sbfake.logs WHERE timestamp BETWEEN parseDateTime64BestEffort('%s', 6) AND parseDateTime64BestEffort('%s', 6)) AS logs",
			q.Get("iso_timestamp_start"), q.Get("iso_timestamp_end"))
		sql := strings.Replace(q.Get("sql"), "FROM logs", "FROM "+window, 1) + " FORMAT JSON"
		resp, err := http.Post(httpURL+"/?"+url.Values{"query": {sql}}.Encode(), "text/plain", nil)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			http.Error(w, string(body), 400)
			return
		}
		var out struct {
			Data json.RawMessage `json:"data"`
		}
		_ = json.Unmarshal(body, &out)
		fmt.Fprintf(w, `{"result":%s}`, out.Data)
	}))
	defer srv.Close()

	cfg := Config{
		Projects: []Project{{Ref: "itref", Source: "it-supabase"}}, Tables: []string{"auth_logs"},
		Overlap: 5 * time.Minute, MaxLookback: 72 * time.Hour, PageSize: 500, MaxPagesPerTable: 50,
	}
	store := &clickhouseStore{conn: conn}

	run := func(apiToken string) TableResult {
		t.Helper()
		res := NewPuller(newSupabaseAPI(srv.URL, apiToken), store, cfg).Run(ctx)
		return res[0]
	}
	counts := func() (total, distinct, legacy uint64) {
		t.Helper()
		row := conn.QueryRow(ctx, `SELECT count(), uniqExactIf(JSONExtractString(properties,'sb_id'), JSONExtractString(properties,'sb_id') != ''),
			countIf(source = 'Wagner-Server') FROM logs.events WHERE JSONExtractString(properties,'Source') = 'it-supabase'`)
		if err := row.Scan(&total, &distinct, &legacy); err != nil {
			t.Fatal(err)
		}
		return
	}
	_, _, legacyRows := counts()

	// Cutover: resumes from the poller's rows by the Source property.
	res := run("sbp_test")
	if res.Error != "" {
		t.Fatalf("cutover run: %s", res.Error)
	}
	total, distinct, _ := counts()
	if total-legacyRows != distinct || distinct != 1100 {
		t.Fatalf("after cutover: %d rows (%d legacy), %d distinct sb_ids; want exactly the 1100 new rows once", total, legacyRows, distinct)
	}
	if res.Skipped == 0 {
		t.Fatal("cutover run skipped nothing; the overlap should have re-read poller rows")
	}

	// Stop, more logs arrive, restart with a fresh process.
	sbRows("later", now.Add(time.Second), 50*time.Millisecond, 700, false)
	res = run("sbp_test")
	if res.Error != "" || res.Inserted != 700 {
		t.Fatalf("restart run: inserted %d, err %q; want 700", res.Inserted, res.Error)
	}
	if total, distinct, _ = counts(); total-legacyRows != distinct || distinct != 1800 {
		t.Fatalf("after restart: %d non-legacy rows, %d distinct sb_ids; want 1800 each", total-legacyRows, distinct)
	}

	// The stored row matches what the alerts read.
	var level, source, props string
	if err := conn.QueryRow(ctx, `SELECT level, source, properties FROM logs.events
		WHERE JSONExtractString(properties,'sb_id') = 'later-00000'`).Scan(&level, &source, &props); err != nil {
		t.Fatal(err)
	}
	if level != "Error" || source != "it-supabase" || !strings.Contains(props, `"sb_request_path":"/p"`) || strings.Contains(props, "sb_empty") {
		t.Fatalf("row: level=%s source=%s props=%s", level, source, props)
	}

	// A refused token reports an auth failure and writes nothing.
	res = run("wrong")
	if !res.AuthFailed {
		t.Fatalf("bad token: %+v", res)
	}
	t.Logf("windows queried: %d; legacy rows %d", len(windows), legacyRows)
}
