package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/logaggregator/ship"
)

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// The point of #111 stage 1: poll() must return without waiting for the ack,
// and the ack must still happen.
func TestAsyncAck_PollReturnsBeforeTheAckLands(t *testing.T) {
	q := &queueTransport{messages: 2, ackDelay: 300 * time.Millisecond}
	c := testConsumer(&stubConn{}, q)
	c.startAckWorker(4)
	defer c.drainAcks()

	start := time.Now()
	if err := c.poll(context.Background()); err != nil {
		t.Fatalf("poll: %v", err)
	}
	elapsed := time.Since(start)

	if elapsed > 150*time.Millisecond {
		t.Errorf("poll took %s — it waited for the %s ack instead of handing it off", elapsed, q.ackDelay)
	}
	if got := q.ackLeases.Load(); got != 0 {
		t.Errorf("ack already completed (%d leases) — the handoff did not happen", got)
	}
	waitFor(t, "the async ack to land", func() bool { return q.ackLeases.Load() == 2 })
}

// A dropped ack is a guaranteed duplicate, so a full queue must fall back to
// acking inline rather than discarding the job or growing without bound.
func TestAsyncAck_FullQueueFallsBackToSynchronous(t *testing.T) {
	q := &queueTransport{messages: 1, ackDelay: 400 * time.Millisecond}
	c := testConsumer(&stubConn{}, q)
	c.startAckWorker(1)
	defer c.drainAcks()

	// Occupy the worker and fill the single slot.
	c.ackCh <- ackJob{acks: []QueueAck{{LeaseID: "x"}}}
	c.ackCh <- ackJob{acks: []QueueAck{{LeaseID: "y"}}}

	start := time.Now()
	if err := c.poll(context.Background()); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if time.Since(start) < 300*time.Millisecond {
		t.Error("poll returned early with a full ack queue — the job was dropped rather than acked inline")
	}
}

// SIGTERM cancels the main context. Pending acks must NOT be abandoned: the
// events are already in ClickHouse, so an abandoned ack duplicates them.
func TestAsyncAck_ShutdownDrainsPendingAcks(t *testing.T) {
	q := &queueTransport{messages: 3, ackDelay: 200 * time.Millisecond}
	c := testConsumer(&stubConn{}, q)
	c.startAckWorker(4)

	ctx, cancel := context.WithCancel(context.Background())
	if err := c.poll(ctx); err != nil {
		t.Fatalf("poll: %v", err)
	}
	cancel() // the shutdown path: context dead, ack still in flight

	c.drainAcks()

	if got := q.ackLeases.Load(); got != 3 {
		t.Errorf("drained %d of 3 leases — the rest would be redelivered and duplicated", got)
	}
}

// poll() has already returned success by the time an async ack fails, so the
// CLEF Error is the only signal the batch is about to be duplicated. Asserted
// on the real shipping path rather than a test hook.
func TestAsyncAck_FailureIsStillReported(t *testing.T) {
	old := ackRetryBaseDelay
	ackRetryBaseDelay = time.Millisecond
	defer func() { ackRetryBaseDelay = old }()

	var hits atomic.Int32
	var body atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var obj map[string]any
		_ = json.Unmarshal([]byte(strings.TrimSpace(string(raw))), &obj)
		if obj["@l"] == "Error" {
			hits.Add(1)
			body.Store(string(raw))
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	q := &queueTransport{messages: 1, ackStatus: 500}
	c := testConsumer(&stubConn{}, q)
	c.shipper = ship.New(ship.Config{URL: srv.URL, APIKey: "k"})
	c.slowMs = time.Second
	c.pollThrottle = ship.NewThrottle(0)
	c.startAckWorker(4)

	if err := c.poll(context.Background()); err != nil {
		t.Fatalf("poll should succeed — the flush worked, the ack is off the critical path now: %v", err)
	}
	c.drainAcks()
	c.shipper.Close()

	if hits.Load() != 1 {
		t.Fatalf("an async ack failure shipped %d Error events — silence here means nothing warns that the batch is about to duplicate", hits.Load())
	}
	if s, _ := body.Load().(string); !strings.Contains(s, "durable") {
		t.Errorf("report should say the events are already durable, got %q", s)
	}
}

// Depth 0 is the default and must be exactly the pre-#111 behaviour.
func TestAsyncAck_DisabledByDefaultStillAcksInline(t *testing.T) {
	q := &queueTransport{messages: 2}
	c := testConsumer(&stubConn{}, q)
	if c.ackCh != nil {
		t.Fatal("ack channel exists without startAckWorker")
	}
	if err := c.poll(context.Background()); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if got := q.ackLeases.Load(); got != 2 {
		t.Errorf("acked %d leases inline, want 2", got)
	}
}

// The ack queue is bounded by arithmetic, not taste: a job waiting behind a
// full queue must still get to ack before its message's lease expires, or the
// batch is redelivered and inserted twice.
func TestAsyncAck_DepthFitsInsideTheLease(t *testing.T) {
	lease := time.Duration(visibilityTimeoutMs) * time.Millisecond
	d := maxSafeAckDepth()
	// Stated independently of maxSafeAckDepth's own arithmetic, or this just
	// asserts that the helper agrees with itself. Capacity d means d buffered
	// jobs PLUS one in flight, so a handed-off job completes at worst
	// (d+1)*budget after the flush.
	worst := flushTimeout + time.Duration(d+1)*ackTotalBudget
	if worst >= lease {
		t.Fatalf("flush %s + (%d buffered + 1 in flight) x %s = %s, which reaches the %s lease — the last ack could land after redelivery",
			flushTimeout, d, ackTotalBudget, worst, lease)
	}
}

// The shutdown grace must cover the same worst case, or a drain that "succeeds"
// still abandons acks whose events are already durable.
func TestAsyncAck_DrainGraceCoversTheWorstCase(t *testing.T) {
	worst := time.Duration(maxSafeAckDepth()+1) * ackTotalBudget
	if ackDrainGrace() < worst {
		t.Fatalf("drain grace %s < worst-case %s (%d buffered + 1 in flight x %s)",
			ackDrainGrace(), worst, maxSafeAckDepth(), ackTotalBudget)
	}
}

func TestAsyncAck_OverlargeDepthIsClamped(t *testing.T) {
	c := &Consumer{}
	c.startAckWorker(999)
	defer c.drainAcks()
	if got := cap(c.ackCh); got != maxSafeAckDepth() {
		t.Errorf("depth 999 produced capacity %d, want it clamped to %d", got, maxSafeAckDepth())
	}
}
