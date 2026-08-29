package main

import (
	"testing"
	"time"
)

func TestEffectiveLastTriggered(t *testing.T) {
	db := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	mem := db.Add(2 * time.Minute)
	zero := time.Time{}

	if got := effectiveLastTriggered(db, mem); !got.Equal(mem) {
		t.Errorf("prefer newer mem: got %v want %v", got, mem)
	}
	if got := effectiveLastTriggered(mem, db); !got.Equal(mem) {
		t.Errorf("prefer newer db: got %v want %v", got, mem)
	}
	if got := effectiveLastTriggered(db, zero); !got.Equal(db) {
		t.Errorf("zero mem falls back to db: got %v want %v", got, db)
	}
	if got := effectiveLastTriggered(zero, mem); !got.Equal(mem) {
		t.Errorf("zero db uses mem: got %v want %v", got, mem)
	}
}

func TestDeriveService(t *testing.T) {
	cases := map[string]string{
		"MyApp - Database Failures": "myapp",
		"AcmeCorp Errors":           "acmecorp",
		"plain":                     "plain",
	}
	for in, want := range cases {
		if got := deriveService(in); got != want {
			t.Errorf("deriveService(%q) = %q, want %q", in, got, want)
		}
	}
}
