package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// slowQueue is a queue whose every pull takes pullDelay and returns one fresh
// message — the shape of a degraded Queues API, where the round trip, not the
// work, is the cost.
type slowQueue struct {
	pullDelay   time.Duration
	ackDelay    time.Duration
	pulls       atomic.Int32
	inflight    atomic.Int32
	maxInflight atomic.Int32
	ackLeases   atomic.Int32
}

func (q *slowQueue) RoundTrip(r *http.Request) (*http.Response, error) {
	if err := r.Context().Err(); err != nil {
		return nil, err
	}
	body := func(s string) *http.Response {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(s)), Header: make(http.Header)}
	}
	if strings.HasSuffix(r.URL.Path, "/ack") {
		time.Sleep(q.ackDelay)
		var req QueueAckRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		q.ackLeases.Add(int32(len(req.Acks)))
		return body(`{"success":true}`), nil
	}

	n := q.inflight.Add(1)
	defer q.inflight.Add(-1)
	for {
		m := q.maxInflight.Load()
		if n <= m || q.maxInflight.CompareAndSwap(m, n) {
			break
		}
	}
	select {
	case <-time.After(q.pullDelay):
	case <-r.Context().Done():
		return nil, r.Context().Err()
	}
	i := q.pulls.Add(1)
	inner, _ := json.Marshal(map[string]any{
		"source": "S", "format": "clef",
		"body": base64.StdEncoding.EncodeToString([]byte(`{"@t":"2026-01-01T00:00:00Z","@mt":"hi"}`)),
	})
	out, _ := json.Marshal(map[string]any{"result": map[string]any{"messages": []map[string]any{{
		"id": fmt.Sprintf("m%d", i), "lease_id": fmt.Sprintf("l%d", i), "body": string(inner),
	}}}})
	return body(string(out)), nil
}

func slowQueueConsumer(q *slowQueue) *Consumer {
	return &Consumer{
		conn: &stubConn{}, accountID: "a", queueID: "qq", apiToken: "t",
		httpClient: &http.Client{Transport: q}, batchSize: 100,
	}
}

// The point of #111 stage 2: with N workers, Queues round trips are paid in
// parallel rather than in series.
func TestPollWorkers_PullsOverlap(t *testing.T) {
	q := &slowQueue{pullDelay: 100 * time.Millisecond}
	c := slowQueueConsumer(q)

	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	c.run(ctx, 10*time.Millisecond, 3)

	if got := q.maxInflight.Load(); got != 3 {
		t.Errorf("at most %d pulls were in flight at once with 3 workers, want 3", got)
	}
}

// 1 is the default and must stay the single serial loop.
func TestPollWorkers_OneWorkerIsSerial(t *testing.T) {
	q := &slowQueue{pullDelay: 30 * time.Millisecond}
	c := slowQueueConsumer(q)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	c.run(ctx, time.Millisecond, 1)

	if got := q.maxInflight.Load(); got != 1 {
		t.Errorf("%d pulls in flight with one worker — the default is no longer serial", got)
	}
	if q.pulls.Load() < 2 {
		t.Errorf("only %d pulls in 200ms — the loop is not polling", q.pulls.Load())
	}
}

// drainAcks closes the ack channel, so run must not return while any worker
// can still hand off an ack: that send would panic on a closed channel. And
// every flushed message must still be acked, or the shutdown duplicates it.
// Run with -race.
func TestPollWorkers_ShutdownJoinsWorkersBeforeDrain(t *testing.T) {
	q := &slowQueue{pullDelay: 5 * time.Millisecond, ackDelay: 20 * time.Millisecond}
	c := slowQueueConsumer(q)
	c.startAckWorker(2)

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	c.run(ctx, time.Millisecond, 4)
	if ctx.Err() == nil {
		t.Fatal("run returned before the context was cancelled")
	}
	if n := q.inflight.Load(); n != 0 {
		t.Fatalf("run returned with %d pulls still in flight — it did not join its workers", n)
	}
	pulledAtReturn := q.pulls.Load()
	c.drainAcks()

	// A worker that outlived run would keep polling here, and its next ack
	// handoff would panic on the closed channel.
	time.Sleep(50 * time.Millisecond)
	if got := q.pulls.Load(); got != pulledAtReturn {
		t.Fatalf("%d pulls happened after run returned — a worker outlived it", got-pulledAtReturn)
	}

	// Every pull that returned was flushed; each one's single lease must be
	// acked, inline or by the drain. A pull cancelled mid-flight never returns
	// a message, so it does not count.
	if pulled, acked := q.pulls.Load(), q.ackLeases.Load(); acked != pulled {
		t.Errorf("acked %d of %d pulled messages — the rest would be redelivered and duplicated", acked, pulled)
	}
}

func TestPollWorkers_Clamp(t *testing.T) {
	for _, tc := range []struct{ in, want int }{{-3, 1}, {0, 1}, {1, 1}, {4, 4}, {10, 10}, {11, 10}, {999, 10}} {
		if got := clampPollWorkers(tc.in); got != tc.want {
			t.Errorf("clampPollWorkers(%d) = %d, want %d", tc.in, got, tc.want)
		}
	}
}
