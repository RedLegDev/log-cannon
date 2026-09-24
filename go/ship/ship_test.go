package ship

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestNew_DisabledWithoutConfig(t *testing.T) {
	if New(Config{}) != nil {
		t.Fatal("expected nil client")
	}
	if New(Config{URL: "https://logs.example.com"}) != nil {
		t.Fatal("expected nil without key")
	}
	if New(Config{APIKey: "k"}) != nil {
		t.Fatal("expected nil without url")
	}
}

func TestEmit_PostsCLEF(t *testing.T) {
	var gotBody string
	var gotKey string
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path != "/ingest/clef" {
			t.Errorf("path = %s", r.URL.Path)
		}
		gotKey = r.Header.Get("X-Api-Key")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	c := New(Config{URL: srv.URL, APIKey: "test-key"})
	c.Emit(Event{
		Timestamp: time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC),
		Level:     "Warning",
		Template:  "Slow poll: pull {PullMs} ms",
		Props:     map[string]any{"PullMs": 42, "Messages": 3},
	})
	c.Close()

	if hits.Load() != 1 {
		t.Fatalf("hits = %d", hits.Load())
	}
	if gotKey != "test-key" {
		t.Fatalf("key = %q", gotKey)
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(gotBody)), &obj); err != nil {
		t.Fatalf("body not JSON: %v (%q)", err, gotBody)
	}
	if obj["@l"] != "Warning" {
		t.Fatalf("@l = %v", obj["@l"])
	}
	if obj["@mt"] != "Slow poll: pull {PullMs} ms" {
		t.Fatalf("@mt = %v", obj["@mt"])
	}
	if obj["PullMs"].(float64) != 42 {
		t.Fatalf("PullMs = %v", obj["PullMs"])
	}
	if !strings.HasSuffix(gotBody, "\n") {
		t.Fatal("CLEF body must be newline-terminated")
	}
}

func TestEmit_NilIsNoop(t *testing.T) {
	var c *Client
	c.Emit(Event{Template: "x"})
	c.Close()
}

func TestEmit_DropsWhenSaturated(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-block
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	c := New(Config{URL: srv.URL, APIKey: "k"})
	// Fill the in-flight cap; each hangs until we unblock.
	for i := 0; i < maxInFlight; i++ {
		c.Emit(Event{Template: "hold"})
	}
	// Give goroutines a moment to take sem slots.
	time.Sleep(20 * time.Millisecond)
	c.Emit(Event{Template: "overflow"})
	if c.Dropped() != 1 {
		t.Fatalf("dropped = %d, want 1", c.Dropped())
	}
	close(block)
	c.Close()
}

func TestTeeWriter(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	c := New(Config{URL: srv.URL, APIKey: "k"})
	var buf strings.Builder
	tw := &TeeWriter{W: &buf, Client: c}
	_, _ = tw.Write([]byte("hello worker\n"))
	c.Close()
	if buf.String() != "hello worker\n" {
		t.Fatalf("stdout = %q", buf.String())
	}
	if hits.Load() != 1 {
		t.Fatalf("hits = %d", hits.Load())
	}
}

func TestThrottle(t *testing.T) {
	th := NewThrottle(50 * time.Millisecond)
	if !th.Allow() {
		t.Fatal("first should allow")
	}
	if th.Allow() {
		t.Fatal("second within interval should deny")
	}
	time.Sleep(55 * time.Millisecond)
	if !th.Allow() {
		t.Fatal("after interval should allow")
	}
}
