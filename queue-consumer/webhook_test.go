package main

import (
	"testing"
)

func TestParseWebhookBody_CompactArray(t *testing.T) {
	body := `[{"message":"a","level":"Info"},{"message":"b","level":"Error"}]`
	events, err := parseWebhookBody([]byte(body), "webhook", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2", len(events))
	}
	if events[0].Source != "webhook" || events[1].Source != "webhook" {
		t.Errorf("source = %q / %q, want webhook", events[0].Source, events[1].Source)
	}
	p0 := props(t, &events[0])
	p1 := props(t, &events[1])
	if p0["message"] != "a" {
		t.Errorf("event[0] message prop = %v", p0["message"])
	}
	if p1["message"] != "b" {
		t.Errorf("event[1] message prop = %v", p1["message"])
	}
	if events[0].Level != "Info" || events[1].Level != "Error" {
		t.Errorf("levels = %q / %q", events[0].Level, events[1].Level)
	}
}

func TestParseWebhookBody_PrettyPrintedArray(t *testing.T) {
	body := `[
  {
    "message": "pretty-one",
    "level": "Warning"
  },
  {
    "message": "pretty-two",
    "level": "Error"
  }
]`
	events, err := parseWebhookBody([]byte(body), "svc", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2", len(events))
	}
	p0 := props(t, &events[0])
	p1 := props(t, &events[1])
	if p0["message"] != "pretty-one" || p1["message"] != "pretty-two" {
		t.Errorf("messages = %v / %v", p0["message"], p1["message"])
	}
}

func TestParseWebhookBody_SingleObject(t *testing.T) {
	body := `{"message":"solo","level":"Information"}`
	events, err := parseWebhookBody([]byte(body), "solo-src", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	p := props(t, &events[0])
	if p["message"] != "solo" {
		t.Errorf("message = %v", p["message"])
	}
}

func TestParseWebhookBody_NDJSON(t *testing.T) {
	body := "{\"message\":\"line1\"}\n{\"message\":\"line2\"}\n"
	events, err := parseWebhookBody([]byte(body), "ndjson", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2", len(events))
	}
}

func TestParseWebhookBody_EmptyArray(t *testing.T) {
	events, err := parseWebhookBody([]byte(`[]`), "empty", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("got %d events, want 0", len(events))
	}
}

func TestParseWebhookBody_AllMalformedNDJSONIsError(t *testing.T) {
	body := "not-json\nalso-bad\n"
	events, err := parseWebhookBody([]byte(body), "bad", "")
	if err == nil {
		t.Fatal("expected error for 0 events with malformed lines")
	}
	if events != nil {
		t.Fatalf("expected nil events, got %d", len(events))
	}
}

func TestParseWebhookBody_ArrayWithNonObjects(t *testing.T) {
	body := `[{"message":"ok"},"skip-me",42,{"message":"also-ok"}]`
	events, err := parseWebhookBody([]byte(body), "mixed", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2", len(events))
	}
}

func TestParseWebhookBody_CloudflarePresetArray(t *testing.T) {
	body := `[{"EdgeStartTimestamp":1700000000000000000,"ClientRequestMethod":"GET","ClientRequestHost":"example.com","ClientRequestURI":"/","EdgeResponseStatus":200}]`
	events, err := parseWebhookBody([]byte(body), "cf", "cloudflare")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	if events[0].Source != "example.com" {
		t.Errorf("source = %q, want example.com", events[0].Source)
	}
	if events[0].Level != "Information" {
		t.Errorf("level = %q, want Information", events[0].Level)
	}
}
