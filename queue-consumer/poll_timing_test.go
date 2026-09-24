package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/logaggregator/ship"
)

func TestMaybeShipPollTiming_OnlyWhenSlow(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		body, _ := io.ReadAll(r.Body)
		var obj map[string]any
		if err := json.Unmarshal([]byte(strings.TrimSpace(string(body))), &obj); err != nil {
			t.Errorf("bad CLEF: %v", err)
		}
		if obj["@l"] != "Warning" {
			t.Errorf("@l = %v", obj["@l"])
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	c := &Consumer{
		shipper:      ship.New(ship.Config{URL: srv.URL, APIKey: "k"}),
		slowMs:       time.Second,
		pollThrottle: ship.NewThrottle(0), // no throttle
	}

	// Fast poll — no ship.
	c.maybeShipPollTiming(2, 5, 10*time.Millisecond, 5*time.Millisecond, 20*time.Millisecond, 5*time.Millisecond, nil)
	if hits.Load() != 0 {
		t.Fatalf("fast poll shipped %d events", hits.Load())
	}

	// Slow insert — ship.
	c.maybeShipPollTiming(2, 5, 10*time.Millisecond, 5*time.Millisecond, 1500*time.Millisecond, 5*time.Millisecond, nil)
	c.shipper.Close()
	if hits.Load() != 1 {
		t.Fatalf("slow poll shipped %d events, want 1", hits.Load())
	}
}

func TestMaybeShipPollTiming_ErrorEvenWhenFast(t *testing.T) {
	var level string
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		body, _ := io.ReadAll(r.Body)
		var obj map[string]any
		_ = json.Unmarshal([]byte(strings.TrimSpace(string(body))), &obj)
		level, _ = obj["@l"].(string)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	c := &Consumer{
		shipper:      ship.New(ship.Config{URL: srv.URL, APIKey: "k"}),
		slowMs:       time.Second,
		pollThrottle: ship.NewThrottle(0),
	}
	c.maybeShipPollTiming(3, 10, 50*time.Millisecond, 10*time.Millisecond, 200*time.Millisecond, 0, errors.New("flush boom"))
	c.shipper.Close()
	if hits.Load() != 1 {
		t.Fatalf("error poll shipped %d, want 1", hits.Load())
	}
	if level != "Error" {
		t.Fatalf("@l = %q, want Error", level)
	}
}

func TestMaybeShipPollTiming_Throttle(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	c := &Consumer{
		shipper:      ship.New(ship.Config{URL: srv.URL, APIKey: "k"}),
		slowMs:       time.Millisecond,
		pollThrottle: ship.NewThrottle(time.Hour),
	}
	slow := 10 * time.Millisecond
	c.maybeShipPollTiming(1, 1, slow, slow, slow, slow, nil)
	c.maybeShipPollTiming(1, 1, slow, slow, slow, slow, errors.New("again"))
	c.shipper.Close()
	if hits.Load() != 1 {
		t.Fatalf("throttled ships = %d, want 1", hits.Load())
	}
}

func TestMaybeShipPollTiming_DisabledWithoutShipper(t *testing.T) {
	c := &Consumer{slowMs: time.Millisecond}
	c.maybeShipPollTiming(1, 1, time.Second, 0, 0, 0, nil) // must not panic
}
