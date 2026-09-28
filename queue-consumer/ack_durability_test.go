package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// --- #80: a dropped event must fail the batch, never report success ---

type stubBatch struct {
	failOn   int // 1-based index of the append that fails; 0 = none fail
	appends  int
	aborted  bool
	appended int
}

func (b *stubBatch) Append(v ...any) error {
	b.appends++
	if b.failOn != 0 && b.appends == b.failOn {
		return errors.New("type mismatch for column 9")
	}
	b.appended++
	return nil
}
func (b *stubBatch) Abort() error { b.aborted = true; return nil }

func events(n int) []LogEvent {
	out := make([]LogEvent, n)
	for i := range out {
		out[i] = LogEvent{Timestamp: time.Now().Add(-time.Minute), Level: "Information", Source: "S", Properties: "{}"}
	}
	return out
}

func TestAppendAll_OneFailureFailsTheWholeBatch(t *testing.T) {
	b := &stubBatch{failOn: 2}
	err := appendAll(b, events(3), time.Now())
	if err == nil {
		t.Fatal("append failure returned nil — poll() would ack a pull whose events are not all in ClickHouse (#80)")
	}
	if !strings.Contains(err.Error(), "1/3") {
		t.Errorf("error should name how many were dropped, got %q", err)
	}
	if !b.aborted {
		t.Error("batch was not aborted, so a retry would double-insert the rows that did append")
	}
}

func TestAppendAll_AllFailuresFailToo(t *testing.T) {
	// The original bug: every append fails, flushBatch logs and returns nil, and
	// poll() acks the entire pull having inserted nothing.
	b := &stubBatch{failOn: 1}
	if err := appendAll(b, events(1), time.Now()); err == nil {
		t.Fatal("an all-fail batch returned nil — this is the silent total-loss path in #80")
	}
}

func TestAppendAll_CleanBatchSucceedsAndAppendsEverything(t *testing.T) {
	b := &stubBatch{}
	if err := appendAll(b, events(5), time.Now()); err != nil {
		t.Fatalf("clean batch returned %v", err)
	}
	if b.appended != 5 {
		t.Errorf("appended %d/5", b.appended)
	}
	if b.aborted {
		t.Error("clean batch must not be aborted")
	}
}

func TestAppendAll_ClampsFutureTimestamps(t *testing.T) {
	now := time.Now()
	var seen time.Time
	b := &stubBatch{}
	capture := &capturingBatch{stubBatch: b, onFirst: func(v []any) { seen = v[0].(time.Time) }}
	ev := events(1)
	ev[0].Timestamp = now.Add(time.Hour)
	if err := appendAll(capture, ev, now); err != nil {
		t.Fatal(err)
	}
	if seen.After(now) {
		t.Errorf("future timestamp %v was not clamped to %v", seen, now)
	}
}

type capturingBatch struct {
	*stubBatch
	onFirst func([]any)
	done    bool
}

func (c *capturingBatch) Append(v ...any) error {
	if !c.done {
		c.done = true
		c.onFirst(v)
	}
	return c.stubBatch.Append(v...)
}

// --- #116: a failed ack must be retried, and must not report a clean poll ---

type stubTransport struct {
	calls   atomic.Int32
	failFor int32 // fail this many calls, then succeed
}

func (s *stubTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	n := s.calls.Add(1)
	if n <= s.failFor {
		return &http.Response{StatusCode: 500, Body: http.NoBody, Header: make(http.Header)}, nil
	}
	return &http.Response{StatusCode: 200, Body: http.NoBody, Header: make(http.Header)}, nil
}

func consumerWithTransport(tr http.RoundTripper) *Consumer {
	return &Consumer{accountID: "a", queueID: "q", apiToken: "t", httpClient: &http.Client{Transport: tr}}
}

func TestAckWithRetry_RecoversAfterTransientFailures(t *testing.T) {
	old := ackRetryBaseDelay
	ackRetryBaseDelay = time.Millisecond
	defer func() { ackRetryBaseDelay = old }()

	tr := &stubTransport{failFor: 2}
	c := consumerWithTransport(tr)
	if err := c.ackWithRetry(context.Background(), []QueueAck{{LeaseID: "l1"}}); err != nil {
		t.Fatalf("should have recovered on attempt 3, got %v", err)
	}
	if got := tr.calls.Load(); got != 3 {
		t.Errorf("made %d ack calls, want 3", got)
	}
}

func TestAckWithRetry_GivesUpAndReportsAfterMaxAttempts(t *testing.T) {
	old := ackRetryBaseDelay
	ackRetryBaseDelay = time.Millisecond
	defer func() { ackRetryBaseDelay = old }()

	tr := &stubTransport{failFor: 1000}
	c := consumerWithTransport(tr)
	err := c.ackWithRetry(context.Background(), []QueueAck{{LeaseID: "l1"}})
	if err == nil {
		t.Fatal("a permanently failing ack returned nil — poll() would report a clean cycle that is about to duplicate (#116)")
	}
	if got := tr.calls.Load(); got != ackMaxAttempts {
		t.Errorf("made %d attempts, want %d", got, ackMaxAttempts)
	}
}
