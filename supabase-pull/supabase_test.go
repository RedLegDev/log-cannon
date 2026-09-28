package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// limitedServer answers 429 for the first `limited` requests, then a page in
// the shape the real endpoint returns (timestamp with no zone, as observed
// 2026-09-28).
func limitedServer(t *testing.T, limited int) (*httptest.Server, *int) {
	t.Helper()
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls <= limited {
			w.Header().Set("Retry-After", "21")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"message":"ThrottlerException: Too Many Requests"}`))
			return
		}
		_, _ = w.Write([]byte(`{"result":[{"id":"83fdbffb-7ef2-49b1-900e-694b1f3920e6","timestamp":"2026-09-28T19:25:55.000000","event_message":"m","severity_text":"INFO","log_attributes":{}}],"error":null}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func TestRateLimitWaitsRetryAfterThenSucceeds(t *testing.T) {
	srv, calls := limitedServer(t, 2)
	api := newSupabaseAPI(srv.URL, "tok")
	var waits []time.Duration
	api.sleep = func(_ context.Context, d time.Duration) error { waits = append(waits, d); return nil }

	rows, err := api.Query(context.Background(), "ref", "auth_logs", Cursor{Timestamp: t0}, t0, t0.Add(time.Minute), 500)

	if err != nil {
		t.Fatal(err)
	}
	if *calls != 3 || len(waits) != 2 || waits[0] != 22*time.Second {
		t.Fatalf("calls=%d waits=%v, want 3 calls and two 22s waits (Retry-After 21 + 1s)", *calls, waits)
	}
	want := time.Date(2026, 9, 28, 19, 25, 55, 0, time.UTC)
	if len(rows) != 1 || !rows[0].Timestamp.Equal(want) {
		t.Fatalf("rows = %+v, want one row at %s", rows, want)
	}
}

func TestRateLimitGivesUpAfterRetries(t *testing.T) {
	srv, calls := limitedServer(t, 1000)
	api := newSupabaseAPI(srv.URL, "tok")
	api.sleep = func(context.Context, time.Duration) error { return nil }

	_, err := api.Query(context.Background(), "ref", "auth_logs", Cursor{Timestamp: t0}, t0, t0.Add(time.Minute), 500)

	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("err = %v, want ErrRateLimited", err)
	}
	if *calls != maxRateLimitRetries+1 {
		t.Fatalf("made %d calls, want %d", *calls, maxRateLimitRetries+1)
	}
}

func TestRetryAfter(t *testing.T) {
	for in, want := range map[string]time.Duration{
		"21": 22 * time.Second, "": time.Minute, "junk": time.Minute, "600": 90 * time.Second,
	} {
		if got := retryAfter(in); got != want {
			t.Errorf("retryAfter(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestTransientFailuresRetryThenReport(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()
	api := newSupabaseAPI(srv.URL, "tok")
	var waits []time.Duration
	api.sleep = func(_ context.Context, d time.Duration) error { waits = append(waits, d); return nil }

	_, err := api.Query(context.Background(), "ref", "auth_logs", Cursor{Timestamp: t0}, t0, t0.Add(time.Minute), 500)

	if err == nil || calls != transientRetries+1 || len(waits) != transientRetries {
		t.Fatalf("err=%v calls=%d waits=%v, want a 502 error after %d retries", err, calls, waits, transientRetries)
	}
}

func TestClientErrorsAreNotRetried(t *testing.T) {
	for _, status := range []int{http.StatusBadRequest, http.StatusUnauthorized} {
		calls := 0
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls++
			w.WriteHeader(status)
		}))
		api := newSupabaseAPI(srv.URL, "tok")
		api.sleep = func(context.Context, time.Duration) error { t.Fatal("slept on a client error"); return nil }
		if _, err := api.Query(context.Background(), "ref", "auth_logs", Cursor{Timestamp: t0}, t0, t0.Add(time.Minute), 500); err == nil || calls != 1 {
			t.Errorf("HTTP %d: err=%v calls=%d, want one call and an error", status, err, calls)
		}
		srv.Close()
	}
}

func TestBackendErrorIn200IsRetried(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			_, _ = w.Write([]byte(`{"result":[],"error":"Backend error! Retry your query. Please contact support if this continues."}`))
			return
		}
		_, _ = w.Write([]byte(`{"result":[],"error":null}`))
	}))
	defer srv.Close()
	api := newSupabaseAPI(srv.URL, "tok")
	api.sleep = func(context.Context, time.Duration) error { return nil }

	if _, err := api.Query(context.Background(), "ref", "auth_logs", Cursor{Timestamp: t0}, t0, t0.Add(time.Minute), 500); err != nil || calls != 2 {
		t.Fatalf("err=%v calls=%d, want success on the retry", err, calls)
	}
}
