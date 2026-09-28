package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	chcol "github.com/ClickHouse/clickhouse-go/v2/lib/column"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// --- minimal driver.Conn: only PrepareBatch is exercised ---

type stubConn struct {
	batches  int
	failOnce bool // first batch fails at append, later ones succeed (poison isolation)
	failAll  bool
	failSend bool // batch appends fine but Send fails — an *uncertain* write
}

func (c *stubConn) PrepareBatch(ctx context.Context, query string, opts ...driver.PrepareBatchOption) (driver.Batch, error) {
	c.batches++
	b := &fullBatch{failSend: c.failSend}
	if c.failAll || (c.failOnce && c.batches == 1) {
		b.failAppend = true
	}
	return b, nil
}
func (c *stubConn) Contributors() []string                                     { return nil }
func (c *stubConn) ServerVersion() (*driver.ServerVersion, error)              { return nil, nil }
func (c *stubConn) Select(context.Context, any, string, ...any) error          { return nil }
func (c *stubConn) Query(context.Context, string, ...any) (driver.Rows, error) { return nil, nil }
func (c *stubConn) QueryRow(context.Context, string, ...any) driver.Row        { return nil }
func (c *stubConn) Exec(context.Context, string, ...any) error                 { return nil }
func (c *stubConn) QueryFormat(context.Context, string, string, ...any) (io.ReadCloser, error) {
	return nil, nil
}
func (c *stubConn) InsertFormat(context.Context, string, string, io.Reader) error { return nil }
func (c *stubConn) AsyncInsert(context.Context, string, bool, ...any) error       { return nil }
func (c *stubConn) Ping(context.Context) error                                    { return nil }
func (c *stubConn) Stats() driver.Stats                                           { return driver.Stats{} }
func (c *stubConn) Close() error                                                  { return nil }

type fullBatch struct {
	failAppend bool
	failSend   bool
	sent       bool
	rows       int
}

func (b *fullBatch) Append(v ...any) error {
	if b.failAppend {
		return errors.New("cannot convert value for column 9")
	}
	b.rows++
	return nil
}
func (b *fullBatch) AppendStruct(any) error        { return nil }
func (b *fullBatch) Abort() error                  { b.sent = true; return nil }
func (b *fullBatch) Column(int) driver.BatchColumn { return nil }
func (b *fullBatch) Flush() error                  { return nil }
func (b *fullBatch) Send() error {
	b.sent = true
	if b.failSend {
		return errors.New("write: connection reset by peer")
	}
	return nil
}
func (b *fullBatch) IsSent() bool               { return b.sent }
func (b *fullBatch) Rows() int                  { return b.rows }
func (b *fullBatch) Columns() []chcol.Interface { return nil }
func (b *fullBatch) Close() error               { return nil }

// --- a queue that serves one pull of N messages, and counts acks ---

type queueTransport struct {
	pulls     atomic.Int32
	ackCalls  atomic.Int32
	ackLeases atomic.Int32
	ackStatus int
	messages  int
	ackDelay  time.Duration
}

func (q *queueTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	// A real transport fails a request whose context is already dead. Without
	// this the stub cannot tell a live context from a cancelled one, and a
	// shutdown bug that abandons acks would pass its own test.
	if err := r.Context().Err(); err != nil {
		return nil, err
	}
	body := func(s string) *http.Response {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(s)), Header: make(http.Header)}
	}
	switch {
	case strings.HasSuffix(r.URL.Path, "/pull"):
		if q.pulls.Add(1) > 1 {
			return body(`{"result":{"messages":[]}}`), nil
		}
		inner, _ := json.Marshal(map[string]any{
			"source": "S", "format": "clef",
			"body": base64.StdEncoding.EncodeToString([]byte(`{"@t":"2026-01-01T00:00:00Z","@mt":"hi"}`)),
		})
		msgs := make([]map[string]any, 0, q.messages)
		for i := 0; i < q.messages; i++ {
			msgs = append(msgs, map[string]any{
				"id": "m" + string(rune('a'+i)), "lease_id": "l" + string(rune('a'+i)),
				"body": string(inner),
			})
		}
		out, _ := json.Marshal(map[string]any{"result": map[string]any{"messages": msgs}})
		return body(string(out)), nil
	case strings.HasSuffix(r.URL.Path, "/ack"):
		if q.ackDelay > 0 {
			time.Sleep(q.ackDelay)
		}
		q.ackCalls.Add(1)
		var req QueueAckRequest
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &req)
		q.ackLeases.Add(int32(len(req.Acks)))
		st := q.ackStatus
		if st == 0 {
			st = 200
		}
		return &http.Response{StatusCode: st, Body: http.NoBody, Header: make(http.Header)}, nil
	}
	return body(`{}`), nil
}

func testConsumer(conn driver.Conn, q *queueTransport) *Consumer {
	return &Consumer{
		conn: conn, accountID: "a", queueID: "qq", apiToken: "t",
		httpClient: &http.Client{Transport: q}, batchSize: 100,
	}
}

// #116 at the poll level: the events are durable, the ack fails, and poll must
// NOT report a clean cycle — otherwise the redelivery duplicates them silently.
func TestPoll_FailedAckAfterSuccessfulFlushFailsThePoll(t *testing.T) {
	old := ackRetryBaseDelay
	ackRetryBaseDelay = time.Millisecond
	defer func() { ackRetryBaseDelay = old }()

	q := &queueTransport{messages: 2, ackStatus: 500}
	c := testConsumer(&stubConn{}, q)

	err := c.poll(context.Background())
	if err == nil {
		t.Fatal("poll reported success after the ack failed — the pull will be redelivered and duplicated (#116)")
	}
	if !strings.Contains(err.Error(), "durable") {
		t.Errorf("error should say the events are already durable, got %q", err)
	}
	if got := q.ackCalls.Load(); got != int32(ackMaxAttempts) {
		t.Errorf("ack attempted %d times, want %d", got, ackMaxAttempts)
	}
}

// #80 collateral: one poison event must not cost every co-pulled message.
// Cloudflare discards after max_retries with no DLQ, so failing the whole pull
// repeatedly would delete all of them.
func TestPoll_AppendFailureIsolatesToTheBadMessage(t *testing.T) {
	q := &queueTransport{messages: 3}
	// First (combined) batch fails at append; the per-message retries succeed.
	c := testConsumer(&stubConn{failOnce: true}, q)

	if err := c.poll(context.Background()); err != nil {
		t.Fatalf("poll should have recovered by isolating, got %v", err)
	}
	// 3 messages each re-flushed individually and acked.
	if got := q.ackLeases.Load(); got != 3 {
		t.Errorf("acked %d leases, want 3 — good messages must not be held hostage by a poison sibling", got)
	}
}

func TestPoll_EveryMessageFailingIndividuallyStillFailsThePoll(t *testing.T) {
	q := &queueTransport{messages: 2}
	c := testConsumer(&stubConn{failAll: true}, q)

	if err := c.poll(context.Background()); err == nil {
		t.Fatal("every message failed to insert but poll reported success — that is silent loss (#80)")
	}
	if got := q.ackLeases.Load(); got != 0 {
		t.Errorf("acked %d leases despite inserting nothing, want 0", got)
	}
}

func TestAckBudgetPlusFlushFitsInsideTheLease(t *testing.T) {
	lease := time.Duration(visibilityTimeoutMs) * time.Millisecond
	if flushTimeout+ackTotalBudget >= lease {
		t.Fatalf("flush %s + ack budget %s >= %s lease: the ack can still be retrying when Cloudflare redelivers, which is the duplicate window #116 exists to close",
			flushTimeout, ackTotalBudget, lease)
	}
}

// The isolation path is safe ONLY after an append failure, where nothing was
// sent. A Send failure is an uncertain write: re-inserting message by message
// could duplicate rows that actually landed. So a failed Send must leave the
// whole pull unacked for redelivery, and must NOT be retried individually.
func TestPoll_SendFailureIsNotIsolated(t *testing.T) {
	q := &queueTransport{messages: 3}
	conn := &stubConn{failSend: true}
	c := testConsumer(conn, q)

	if err := c.poll(context.Background()); err == nil {
		t.Fatal("a failed Send reported success")
	}
	if got := q.ackLeases.Load(); got != 0 {
		t.Errorf("acked %d leases after an uncertain write, want 0", got)
	}
	// One combined batch only. More would mean the pull was retried per message,
	// risking duplicates for rows the failed Send may already have committed.
	if conn.batches != 1 {
		t.Errorf("prepared %d batches, want 1 — a Send failure must not trigger per-message retries", conn.batches)
	}
}
