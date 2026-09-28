package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestToEventKeepsThePollerPropertyNames(t *testing.T) {
	r := Row{
		ID:        "0d3c-uuid",
		Timestamp: time.Date(2026, 9, 28, 17, 55, 0, 6_123_000, time.UTC),
		Message:   "hello",
		Severity:  "ERROR",
		Attributes: map[string]any{
			"request.path":            "/auth/v1/token",
			"parsed.error_severity":   "LOG",
			"metadata-host":           "db-x",
			"empty":                   "",
			"nil":                     nil,
			"id":                      "attribute-id-must-not-win",
			"parsed.session_line_num": json.Number("169342"),
			".leading.and.trailing.":  "trimmed",
		},
	}

	e := toEvent(Project{Ref: "jlyw", Source: "readerful-supabase"}, "postgres_logs", r)

	var props map[string]any
	if err := json.Unmarshal([]byte(e.Properties), &props); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"Source":                     "readerful-supabase",
		"LogTable":                   "postgres_logs",
		"ProjectRef":                 "jlyw",
		"sb_id":                      "0d3c-uuid",
		"sb_request_path":            "/auth/v1/token",
		"sb_parsed_error_severity":   "LOG",
		"sb_metadata_host":           "db-x",
		"sb_parsed_session_line_num": float64(169342),
		"sb_leading_and_trailing":    "trimmed",
	}
	if len(props) != len(want) {
		t.Fatalf("properties = %v, want exactly %v", props, want)
	}
	for k, v := range want {
		if props[k] != v {
			t.Errorf("%s = %#v, want %#v", k, props[k], v)
		}
	}
	if e.Source != "readerful-supabase" || e.Level != "Error" || e.Message != "hello" {
		t.Errorf("source=%q level=%q message=%q", e.Source, e.Level, e.Message)
	}
	// MurmurHash3 x86_32("hello", seed 0) = 0x248bfa47, the value
	// queue-consumer's computeEventType gives a template-less "hello".
	if e.EventType != "0x248bfa47" {
		t.Errorf("event type = %s, want 0x248bfa47", e.EventType)
	}
}

func TestMapLevel(t *testing.T) {
	for in, want := range map[string]string{
		"PANIC": "Fatal", "fatal": "Fatal", "error": "Error", "WARNING": "Warning",
		"log": "Information", "notice": "Information", "debug": "Debug", "trace": "Verbose",
		"": "Information", "something-new": "Information",
	} {
		if got := mapLevel(in); got != want {
			t.Errorf("mapLevel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseResponseTimestampFormats(t *testing.T) {
	body := `{"result":[
		{"id":"a","timestamp":"2026-09-28 17:55:00.006123","event_message":"m1","severity_text":"LOG","log_attributes":{"k":"v"}},
		{"id":"b","timestamp":"2026-09-28T17:55:00.006123Z","event_message":"m2"},
		{"id":"c","timestamp":1790618100006123,"event_message":"m3"}
	]}`
	rows, err := parseResponse([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 9, 28, 17, 55, 0, 6_123_000, time.UTC)
	for i, r := range rows[:2] {
		if !r.Timestamp.Equal(want) {
			t.Errorf("row %d timestamp = %s, want %s", i, r.Timestamp, want)
		}
	}
	if got := rows[2].Timestamp; !got.Equal(time.UnixMicro(1790618100006123)) {
		t.Errorf("epoch-micros row = %s", got)
	}
	if rows[0].Attributes["k"] != "v" || rows[0].Severity != "LOG" {
		t.Errorf("row 0 = %+v", rows[0])
	}
}

func TestParseResponseSurfacesAPIErrors(t *testing.T) {
	if _, err := parseResponse([]byte(`{"result":[],"error":{"message":"bad sql"}}`)); err == nil || !strings.Contains(err.Error(), "bad sql") {
		t.Fatalf("err = %v, want the API's error", err)
	}
	if _, err := parseResponse([]byte(`{"result":[{"id":"x","timestamp":"yesterday"}]}`)); err == nil {
		t.Fatal("an unparseable timestamp must fail the page, not drop the row")
	}
}

func TestBuildSQLKeyset(t *testing.T) {
	ts := time.Date(2026, 9, 28, 17, 55, 0, 6_123_000, time.UTC)

	first := buildSQL("auth_logs", Cursor{Timestamp: ts}, 500)
	if !strings.Contains(first, "timestamp >= toDateTime64('2026-09-28 17:55:00.006123', 6, 'UTC')") {
		t.Errorf("first page SQL: %s", first)
	}
	next := buildSQL("auth_logs", Cursor{Timestamp: ts, ID: "o'id"}, 500)
	for _, frag := range []string{
		"source = 'auth_logs'",
		"(timestamp > toDateTime64('2026-09-28 17:55:00.006123', 6, 'UTC') OR (timestamp = toDateTime64('2026-09-28 17:55:00.006123', 6, 'UTC') AND id > 'o\\'id'))",
		"ORDER BY timestamp ASC, id ASC LIMIT 500",
	} {
		if !strings.Contains(next, frag) {
			t.Errorf("keyset SQL missing %q:\n%s", frag, next)
		}
	}
}

func TestParseProjects(t *testing.T) {
	got, err := parseProjects(" ref1=one-supabase , ref2=two-supabase,")
	if err != nil || len(got) != 2 || got[1] != (Project{Ref: "ref2", Source: "two-supabase"}) {
		t.Fatalf("got %v, %v", got, err)
	}
	if got, err := parseProjects(""); err != nil || len(got) != 0 {
		t.Fatalf("empty: %v, %v", got, err)
	}
	for _, bad := range []string{"noequals", "ref=", "=src", "r=a,r=b"} {
		if _, err := parseProjects(bad); err == nil {
			t.Errorf("parseProjects(%q) accepted", bad)
		}
	}
}
