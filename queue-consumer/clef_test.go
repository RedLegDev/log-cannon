package main

import (
	"encoding/json"
	"testing"
)

// props parses an event's Properties JSON into a map for assertions.
func props(t *testing.T, e *LogEvent) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal([]byte(e.Properties), &m); err != nil {
		t.Fatalf("properties not valid JSON: %v (%q)", err, e.Properties)
	}
	return m
}

func enrich() map[string]string {
	return map[string]string{
		"cf_asn":      "13335",
		"geo_country": "US",
		"geo_region":  "Florida",
		"geo_city":    "Lakeland",
		"cf_is_bot":   "false",
		"user_agent":  "Mozilla/5.0",
	}
}

// A browser beacon with no geo/network fields gets all of them backfilled.
func TestApplyEnrichment_BackfillsMissing(t *testing.T) {
	line := `{"@t":"2026-01-01T00:00:00Z","@mt":"beacon","page":"/read/1"}`
	e, err := parseCLEFLine(line, "web", enrich())
	if err != nil {
		t.Fatal(err)
	}
	p := props(t, e)
	for k, want := range enrich() {
		if got, _ := p[k].(string); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if p["page"] != "/read/1" {
		t.Errorf("original property clobbered: page = %v", p["page"])
	}
}

// A server-side caller that stamps its own geo/ASN is never overwritten.
func TestApplyEnrichment_NeverOverwrites(t *testing.T) {
	line := `{"@t":"2026-01-01T00:00:00Z","@mt":"m","cf_asn":"64500","geo_country":"DE","geo_city":"Berlin","cf_is_bot":"true"}`
	e, err := parseCLEFLine(line, "svc", enrich())
	if err != nil {
		t.Fatal(err)
	}
	p := props(t, e)
	if p["cf_asn"] != "64500" || p["geo_country"] != "DE" || p["geo_city"] != "Berlin" || p["cf_is_bot"] != "true" {
		t.Errorf("caller values overwritten: %+v", p)
	}
	// A field the caller didn't provide is still backfilled.
	if p["geo_region"] != "Florida" {
		t.Errorf("geo_region = %v, want Florida", p["geo_region"])
	}
}

// Empty-string and null values are treated as absent and get filled.
func TestApplyEnrichment_FillsEmptyAndNull(t *testing.T) {
	line := `{"@t":"2026-01-01T00:00:00Z","@mt":"m","geo_country":"","geo_city":null}`
	e, err := parseCLEFLine(line, "svc", enrich())
	if err != nil {
		t.Fatal(err)
	}
	p := props(t, e)
	if p["geo_country"] != "US" {
		t.Errorf("empty geo_country not filled: %v", p["geo_country"])
	}
	if p["geo_city"] != "Lakeland" {
		t.Errorf("null geo_city not filled: %v", p["geo_city"])
	}
}

// No enrichment map (server payloads that carry none) is a clean no-op.
func TestApplyEnrichment_NilIsNoop(t *testing.T) {
	line := `{"@t":"2026-01-01T00:00:00Z","@mt":"m","only":"field"}`
	e, err := parseCLEFLine(line, "svc", nil)
	if err != nil {
		t.Fatal(err)
	}
	p := props(t, e)
	if len(p) != 1 || p["only"] != "field" {
		t.Errorf("nil enrich changed properties: %+v", p)
	}
}
