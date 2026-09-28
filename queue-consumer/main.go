package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/logaggregator/ship"
)

// QueuePayload mirrors the TypeScript QueuePayload from the Workers.
// Queue lease and ack-retry budget. The retry sequence must finish well inside
// the lease: once the visibility timeout elapses the messages are redelivered
// and retrying the ack is pointless (refs #116).
//
// Budget: waits of 1s + 3s plus three ack calls. Acks have been measured at
// ~2.4s each under Queues degradation, so worst case is roughly 11s.
//
// That fits inside either lease this queue might apply, which is the reason it
// is this conservative. The pull below requests 120s, and the per-request value
// is what governs — confirmed indirectly, since the requested batch_size of 100
// also overrides the queue's configured 10 (pulls of 50 have been observed).
// But the queue's own consumer settings say visibility_timeout_ms = 30000, and
// an 11s budget is comfortably inside 30s too, so the retry cannot outlive the
// lease even if that assumption is ever wrong.
const (
	visibilityTimeoutMs = 120000
	ackMaxAttempts      = 3
	flushTimeout        = 60 * time.Second

	// Ceiling on the WHOLE ack-retry sequence, enforced by a context deadline
	// rather than by summing the backoff. httpClient has a 30s timeout, so three
	// unbounded attempts plus backoff could reach ~94s; with the flush already
	// allowed 60s of the lease, the retry could still be running when Cloudflare
	// redelivers — creating exactly the duplicate window #116 exists to shrink.
	// flushTimeout + ackTotalBudget must stay under the lease; a test asserts it.
	ackTotalBudget = 15 * time.Second
)

// maxSafeAckDepth bounds how many acks may be waiting.
//
// A queued job waits behind everything ahead of it and then needs its own turn.
// Channel capacity D means up to D buffered jobs *plus* one already in flight,
// so a job that hands off successfully completes at worst (D+1)*ackTotalBudget
// later. Add the flush that already consumed part of the lease, and too deep a
// queue starts acking a message *after* its lease has expired — by which point
// Cloudflare has redelivered it, the ack is worthless, and the batch is
// inserted twice. That is precisely the failure moving the ack off the critical
// path is meant to be worth avoiding.
//
// So the depth is arithmetic, not taste:
//
//	flushTimeout + (depth+1)*ackTotalBudget < lease
//
// At the current constants (120s lease, 60s flush, 15s ack budget) that is 2,
// leaving 15s of margin.
func maxSafeAckDepth() int {
	remaining := visibilityTimeoutMs*time.Millisecond - flushTimeout
	d := int(remaining/ackTotalBudget) - 2
	if d < 1 {
		return 1
	}
	return d
}

// ackDrainGrace is how long a shutdown waits for already-handed-off acks.
// Derived, not chosen: the worker can hold maxSafeAckDepth() buffered jobs plus
// one in flight, each up to ackTotalBudget. A grace shorter than that abandons
// acks whose events are already in ClickHouse, which duplicates them on the
// next start rather than losing them.
//
// docker-compose.yml must give the service a stop_grace_period at least this
// long, or Docker SIGKILLs mid-drain and the code's own patience is fiction.
func ackDrainGrace() time.Duration {
	return time.Duration(maxSafeAckDepth()+1)*ackTotalBudget + 5*time.Second
}

// Overridden in tests so they do not sleep the real backoff.
var ackRetryBaseDelay = time.Second

type QueuePayload struct {
	Format      string `json:"format"` // "clef", "webhook", "otlp-logs", "otlp-traces"
	Source      string `json:"source"`
	Body        string `json:"body"` // base64-encoded raw request body
	ContentType string `json:"contentType"`
	Preset      string `json:"preset,omitempty"`
	// Enrich holds request-scoped Cloudflare geo/network context captured at
	// the edge (cf_asn, geo_*, cf_is_bot, user_agent). Applied as event
	// properties, filling only keys an event doesn't already carry. Currently
	// set on the CLEF path only.
	Enrich map[string]string `json:"enrich,omitempty"`
}

// QueuePullResponse is the Cloudflare Queue pull API response.
type QueuePullResponse struct {
	Success bool `json:"success"`
	Result  struct {
		Messages []QueueMessage `json:"messages"`
	} `json:"result"`
}

type QueueMessage struct {
	ID      string          `json:"id"`
	Body    json.RawMessage `json:"body"`
	LeaseID string          `json:"lease_id"`
}

type QueueAckRequest struct {
	Acks []QueueAck `json:"acks"`
}

type QueueAck struct {
	LeaseID string `json:"lease_id"`
}

func main() {
	// Cloudflare config
	cfAccountID := requireEnv("CF_ACCOUNT_ID")
	cfQueueID := requireEnv("CF_QUEUE_ID")
	cfAPIToken := requireEnv("CF_API_TOKEN")

	// ClickHouse config
	chHost := getEnv("CLICKHOUSE_HOST", "clickhouse")
	chPort := getEnv("CLICKHOUSE_PORT", "9000")
	chDatabase := getEnv("CLICKHOUSE_DATABASE", "logs")
	chUser := getEnv("CLICKHOUSE_USER", "default")
	chPassword := getEnv("CLICKHOUSE_PASSWORD", "")

	pollInterval := 1 * time.Second
	batchSize := 100 // max messages per pull

	// Optional CLEF shipping to Log Cannon. Absent URL/key → disabled; never
	// required to start. The consumer does *not* tee every log.Printf (that
	// would amplify a drain stall into more queue traffic); it only ships
	// thresholded per-poll phase timings below.
	shipper := ship.FromEnv()
	if shipper != nil {
		log.Println("CLEF shipping enabled (LOG_CANNON_INGEST_URL + LOG_CANNON_API_KEY)")
	} else {
		log.Println("CLEF shipping disabled (set LOG_CANNON_INGEST_URL and LOG_CANNON_API_KEY to enable)")
	}
	defer shipper.Close()

	// Depth of the async ack queue. 0 — the default — keeps acking synchronous,
	// which is byte-for-byte the behaviour that predates #111. Above 0 the ack
	// moves off the poll's critical path and the poll returns before it lands.
	//
	// Off by default on purpose: with it on, poll() reports a clean cycle before
	// the queue has acknowledged, so a failing ack surfaces asynchronously (a
	// log line plus a CLEF Error) rather than as the poll's own error. That is a
	// real change to how a duplicate-producing failure is noticed. Turn it on
	// deliberately — pushing to main redeploys the consumer.
	asyncAckDepth := envInt("ASYNC_ACK_DEPTH", 0)

	slowMs := envDurationMs("POLL_SLOW_MS", 1000)
	telemetryMin := envDurationMs("POLL_TELEMETRY_MIN_INTERVAL_MS", 10_000)

	// Connect to ClickHouse
	var conn driver.Conn
	var err error
	for i := 0; i < 30; i++ {
		conn, err = clickhouse.Open(&clickhouse.Options{
			Addr: []string{fmt.Sprintf("%s:%s", chHost, chPort)},
			Auth: clickhouse.Auth{
				Database: chDatabase,
				Username: chUser,
				Password: chPassword,
			},
			Settings: clickhouse.Settings{
				"max_execution_time": 60,
			},
			DialTimeout:     10 * time.Second,
			MaxOpenConns:    10,
			MaxIdleConns:    5,
			ConnMaxLifetime: time.Hour,
		})
		if err == nil {
			if err = conn.Ping(context.Background()); err == nil {
				break
			}
		}
		log.Printf("Waiting for ClickHouse... (%d/30): %v", i+1, err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		log.Fatalf("Failed to connect to ClickHouse: %v", err)
	}
	log.Println("Connected to ClickHouse")

	consumer := &Consumer{
		conn:         conn,
		accountID:    cfAccountID,
		queueID:      cfQueueID,
		apiToken:     cfAPIToken,
		httpClient:   &http.Client{Timeout: 30 * time.Second},
		batchSize:    batchSize,
		shipper:      shipper,
		slowMs:       slowMs,
		pollThrottle: ship.NewThrottle(telemetryMin),
	}

	// Graceful shutdown
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Println("Shutting down...")
		cancel()
	}()

	if asyncAckDepth > 0 {
		consumer.startAckWorker(asyncAckDepth)
		log.Printf("Async ack enabled (depth %d): polls return before the ack lands", asyncAckDepth)
	}

	log.Printf("Starting queue consumer (poll every %s, batch size %d, slow≥%s)", pollInterval, batchSize, slowMs)
	consumer.run(ctx, pollInterval)

	// After run returns the context is already cancelled, so this must not use
	// it — the events are durable and an abandoned ack duplicates them.
	consumer.drainAcks()
}

type Consumer struct {
	conn         driver.Conn
	accountID    string
	queueID      string
	apiToken     string
	httpClient   *http.Client
	batchSize    int
	shipper      *ship.Client
	slowMs       time.Duration
	pollThrottle *ship.Throttle

	// nil when acking is synchronous (the default). See startAckWorker.
	ackCh chan ackJob
	ackWG sync.WaitGroup
}

func (c *Consumer) run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := c.poll(ctx); err != nil {
				log.Printf("Poll error: %v", err)
			}
		}
	}
}

func (c *Consumer) poll(ctx context.Context) error {
	pullStart := time.Now()
	messages, err := c.pullMessages(ctx)
	pullMs := time.Since(pullStart)
	if err != nil {
		pullErr := fmt.Errorf("pull: %w", err)
		c.maybeShipPollTiming(0, 0, pullMs, 0, 0, 0, pullErr)
		return pullErr
	}
	if len(messages) == 0 {
		return nil
	}

	log.Printf("Pulled %d messages from queue in %s", len(messages), pullMs.Round(time.Millisecond))

	var allEvents []LogEvent
	var deadLetterAcks []QueueAck    // Corrupt/unparseable — ack unconditionally
	var processed []processedMessage // Parsed OK — ack only after their events land

	parseStart := time.Now()
	for _, msg := range messages {
		// The HTTP pull API may double-encode the body as a JSON string.
		// Unwrap it if needed before deserializing into QueuePayload.
		rawBody := msg.Body
		if len(rawBody) > 0 && rawBody[0] == '"' {
			var unwrapped string
			if err := json.Unmarshal(rawBody, &unwrapped); err == nil {
				rawBody = json.RawMessage(unwrapped)
			}
		}

		var payload QueuePayload
		if err := json.Unmarshal(rawBody, &payload); err != nil {
			log.Printf("Failed to unmarshal message %s: %v", msg.ID, err)
			deadLetterAcks = append(deadLetterAcks, QueueAck{LeaseID: msg.LeaseID})
			continue
		}

		// Decode base64 body
		rawBody, err := base64.StdEncoding.DecodeString(payload.Body)
		if err != nil {
			log.Printf("Failed to decode base64 body for message %s: %v", msg.ID, err)
			deadLetterAcks = append(deadLetterAcks, QueueAck{LeaseID: msg.LeaseID})
			continue
		}

		events, err := c.processPayload(payload, rawBody)
		if err != nil {
			log.Printf("Failed to process message %s (format=%s): %v", msg.ID, payload.Format, err)
			deadLetterAcks = append(deadLetterAcks, QueueAck{LeaseID: msg.LeaseID})
			continue
		}

		allEvents = append(allEvents, events...)
		processed = append(processed, processedMessage{
			id:     msg.ID,
			ack:    QueueAck{LeaseID: msg.LeaseID},
			events: events,
		})
	}
	parseMs := time.Since(parseStart)

	// Always ack dead-letter messages so they don't block the queue
	var deadAckMs time.Duration
	if len(deadLetterAcks) > 0 {
		log.Printf("Acking %d dead-letter messages (corrupt/unparseable)", len(deadLetterAcks))
		ackStart := time.Now()
		if err := c.ackWithRetry(ctx, deadLetterAcks); err != nil {
			// Unlike the good-ack path this does not duplicate anything: a
			// redelivered corrupt message is simply dead-lettered again.
			log.Printf("Warning: failed to ack %d dead-letter messages: %v", len(deadLetterAcks), err)
		}
		deadAckMs = time.Since(ackStart)
	}

	// Batch insert into ClickHouse with a timeout safely under the visibility window
	var insertMs time.Duration
	goodAcks := acksOf(processed)
	if len(allEvents) > 0 {
		flushCtx, flushCancel := context.WithTimeout(ctx, flushTimeout)
		defer flushCancel()
		insertStart := time.Now()
		err := c.flushBatch(flushCtx, allEvents)

		// A deterministic append failure (bad type, oversized row) would
		// otherwise cost the whole pull: nothing is acked, Cloudflare redelivers,
		// the same event fails again, and at max_retries — 3 on this queue, with
		// no dead-letter queue configured — every co-pulled message is discarded.
		// That is far worse collateral than the single silent drop #80 removed.
		// So retry one message at a time: only the message holding the bad event
		// goes unacked, and it is the only thing that can be discarded.
		//
		// Deliberately not done for a Send failure. That write is *uncertain*, so
		// re-inserting could duplicate rows; the whole pull is left unacked and
		// redelivered instead, which is the pre-existing behaviour.
		if err != nil && errors.Is(err, errAppendFailed) {
			log.Printf("Flush failed while appending (%v) — retrying %d messages individually", err, len(processed))
			var failed int
			goodAcks, failed = c.flushIsolated(flushCtx, processed)
			if failed == len(processed) {
				insertMs = time.Since(insertStart)
				flushErr := fmt.Errorf("flush %d events, and all %d messages failed individually: %w", len(allEvents), failed, err)
				c.maybeShipPollTiming(len(messages), len(allEvents), pullMs, parseMs, insertMs, deadAckMs, flushErr)
				return flushErr
			}
			log.Printf("Isolated flush: %d/%d messages landed, %d left unacked for redelivery", len(goodAcks), len(processed), failed)
		} else if err != nil {
			insertMs = time.Since(insertStart)
			flushErr := fmt.Errorf("flush %d events: %w", len(allEvents), err)
			// Don't ack good messages if insert failed — they will be redelivered.
			// Still ship phase timings so a stalled insert is visible for #111.
			c.maybeShipPollTiming(len(messages), len(allEvents), pullMs, parseMs, insertMs, deadAckMs, flushErr)
			return flushErr
		}
		insertMs = time.Since(insertStart)
		log.Printf("Inserted %d events into ClickHouse in %s", len(allEvents), insertMs.Round(time.Millisecond))
	}

	// Acknowledge successfully processed messages only after flush succeeds.
	//
	// These events are already durable, so a failed ack is not a lost write — it
	// is a duplicate one (refs #116). The lease expires after
	// visibilityTimeoutMs, Cloudflare redelivers, and the next poll inserts
	// every one of them again with a fresh `id`. Nothing dedupes. So: retry
	// inside the lease window, and if it still fails, report the poll as failed
	// rather than returning a clean cycle that is about to duplicate.
	var ackMs time.Duration
	var ackAsync bool
	if len(goodAcks) > 0 {
		ackStart := time.Now()
		job := ackJob{acks: goodAcks, messages: len(messages), events: len(allEvents),
			pull: pullMs, parse: parseMs, ins: insertMs}

		if c.ackCh != nil {
			select {
			case c.ackCh <- job:
				// Off the critical path. AckMs now measures the handoff, not the
				// round trip, so TotalMs stops including it — that is the point
				// of #111, and AckAsync is what makes the two regimes
				// distinguishable in logs.events.
				ackAsync = true
			default:
				// The worker is behind. Ack synchronously rather than drop the
				// job or let the queue grow without bound: a dropped ack is a
				// guaranteed duplicate, and an unbounded backlog would push the
				// ack past the lease and duplicate anyway.
				log.Printf("Ack queue full (%d pending); acking synchronously", cap(c.ackCh))
				c.runAck(job)
			}
			ackMs = time.Since(ackStart)
		} else {
			ackCtx, ackCancel := context.WithTimeout(ctx, ackTotalBudget)
			err := c.ackWithRetry(ackCtx, goodAcks)
			ackCancel()
			ackMs = time.Since(ackStart)
			if err != nil {
				ackErr := fmt.Errorf(
					"ack %d messages after successful flush: %w — events are durable, so redelivery will duplicate them",
					len(goodAcks), err,
				)
				c.maybeShipPollTiming(len(messages), len(allEvents), pullMs, parseMs, insertMs, ackMs+deadAckMs, ackErr)
				return ackErr
			}
		}
	}
	ackMs += deadAckMs

	c.maybeShipPollTiming(len(messages), len(allEvents), pullMs, parseMs, insertMs, ackMs, nil, ackAsync)
	return nil
}

// maybeShipPollTiming ships a CLEF event when a poll is slow or failed.
// Throttled so a sustained stall/failure does not answer itself with more
// queue traffic. Stdout timings above are always emitted.
//
// POLL_SLOW_MS <= 0 disables CLEF shipping from the consumer entirely.
// Failures ship even when under the threshold (still throttled); successes
// only when total >= POLL_SLOW_MS.
func (c *Consumer) maybeShipPollTiming(messages, events int, pull, parse, insert, ack time.Duration, pollErr error, async ...bool) {
	if c.shipper == nil || c.slowMs <= 0 {
		return
	}
	total := pull + parse + insert + ack
	if pollErr == nil && total < c.slowMs {
		return
	}
	if c.pollThrottle != nil && !c.pollThrottle.Allow() {
		return
	}
	props := map[string]any{
		"Messages": messages,
		"Events":   events,
		"PullMs":   pull.Milliseconds(),
		"ParseMs":  parse.Milliseconds(),
		"InsertMs": insert.Milliseconds(),
		"AckMs":    ack.Milliseconds(),
		"TotalMs":  total.Milliseconds(),
	}
	// Present, and true, only when the ack was handed off — so an event from
	// the default synchronous path is byte-identical to one from before #111.
	if len(async) > 0 && async[0] {
		props["AckAsync"] = true
	}
	if pollErr != nil {
		props["Error"] = pollErr.Error()
		c.shipper.Error(
			"Queue poll failed after {TotalMs} ms: {Error} — pull {PullMs} ms, parse {ParseMs} ms, insert {InsertMs} ms, ack {AckMs} ms ({Messages} messages, {Events} events)",
			props,
		)
		return
	}
	c.shipper.Warn(
		"Slow queue poll: {Messages} messages, {Events} events — pull {PullMs} ms, parse {ParseMs} ms, insert {InsertMs} ms, ack {AckMs} ms (total {TotalMs} ms)",
		props,
	)
}

func (c *Consumer) processPayload(payload QueuePayload, rawBody []byte) ([]LogEvent, error) {
	switch payload.Format {
	case "clef":
		return parseCLEFBody(rawBody, payload.Source, payload.Enrich)
	case "webhook":
		return parseWebhookBody(rawBody, payload.Source, payload.Preset)
	case "otlp-logs":
		return parseOTLPLogs(rawBody, payload.Source, payload.ContentType)
	case "otlp-traces":
		return parseOTLPTraces(rawBody, payload.Source, payload.ContentType)
	default:
		return nil, fmt.Errorf("unknown format: %s", payload.Format)
	}
}

// ackJob is a flush that has already succeeded, waiting only for its ack. The
// phase timings ride along so a failure can still be reported with the context
// of the poll it came from, long after poll() has returned.
type ackJob struct {
	acks             []QueueAck
	messages, events int
	pull, parse, ins time.Duration
}

// startAckWorker moves acking off the poll's critical path (refs #111). The ack
// is ~half of a poll cycle — 1.2s of 2.5s at rest, 2.4s of 5s while Cloudflare
// Queues is degraded — and the poll cannot start the next pull until it lands,
// so throughput tracks Queues latency instead of the work being done.
//
// Safe against early redelivery: a message stays leased for
// visibilityTimeoutMs whether or not its ack has arrived, so the next pull
// cannot return it. The lease is what bounds this, not the ack.
func (c *Consumer) startAckWorker(depth int) {
	if max := maxSafeAckDepth(); depth > max {
		log.Printf("ASYNC_ACK_DEPTH %d exceeds the %d that fits inside the message lease; using %d", depth, max, max)
		depth = max
	}
	c.ackCh = make(chan ackJob, depth)
	c.ackWG.Add(1)
	go func() {
		defer c.ackWG.Done()
		for job := range c.ackCh {
			c.runAck(job)
		}
	}()
}

// drainAcks stops accepting acks and waits for the queued ones. Deliberately
// not tied to the shutdown context — see ackDrainGrace.
func (c *Consumer) drainAcks() {
	if c.ackCh == nil {
		return
	}
	close(c.ackCh)
	done := make(chan struct{})
	go func() { c.ackWG.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(ackDrainGrace()):
		log.Printf("Shutdown: gave up waiting for pending acks after %s; those messages will be redelivered and duplicated", ackDrainGrace())
	}
}

// runAck performs the ack and reports a failure. On the async path poll() has
// already returned success, so this log/CLEF pair is the only signal that a
// batch is about to be duplicated — it is why the ack may be moved off the
// critical path but never made fire-and-forget.
func (c *Consumer) runAck(job ackJob) {
	ctx, cancel := context.WithTimeout(context.Background(), ackTotalBudget)
	defer cancel()
	start := time.Now()
	if err := c.ackWithRetry(ctx, job.acks); err != nil {
		ackErr := fmt.Errorf(
			"ack %d messages after successful flush: %w — events are durable, so redelivery will duplicate them",
			len(job.acks), err,
		)
		log.Printf("%v", ackErr)
		c.maybeShipPollTiming(job.messages, job.events, job.pull, job.parse, job.ins, time.Since(start), ackErr)
	}
}

// processedMessage keeps a message's events with its ack so a failed flush can
// be narrowed to the messages that actually caused it (refs #80).
type processedMessage struct {
	id     string
	ack    QueueAck
	events []LogEvent
}

func acksOf(msgs []processedMessage) []QueueAck {
	acks := make([]QueueAck, 0, len(msgs))
	for _, m := range msgs {
		acks = append(acks, m.ack)
	}
	return acks
}

// flushIsolated re-inserts a failed pull one message at a time. Returns the acks
// for messages whose events all landed, and how many did not. Safe only after an
// append failure, where nothing was sent.
func (c *Consumer) flushIsolated(ctx context.Context, msgs []processedMessage) ([]QueueAck, int) {
	acks := make([]QueueAck, 0, len(msgs))
	failed := 0
	for _, m := range msgs {
		if len(m.events) == 0 {
			acks = append(acks, m.ack)
			continue
		}
		if err := c.flushBatch(ctx, m.events); err != nil {
			log.Printf("Message %s: %d events could not be inserted, leaving unacked: %v", m.id, len(m.events), err)
			failed++
			continue
		}
		acks = append(acks, m.ack)
	}
	return acks, failed
}

// errAppendFailed marks a flush that failed while appending, before anything was
// sent. That distinction matters: nothing reached ClickHouse, so the events can
// safely be retried one message at a time. A Send failure is an *uncertain*
// write and must not be retried that way.
var errAppendFailed = errors.New("append failed")

// batchAppender is the part of driver.Batch that appendAll needs. Narrowed so
// the append-failure path — the one that must never be reported as success
// (refs #80) — is testable without a ClickHouse connection.
type batchAppender interface {
	Append(v ...any) error
	Abort() error
}

// appendAll appends every event, or fails. There is no partial success: an ack
// means "these events are in ClickHouse", so a dropped event has to fail the
// batch rather than let poll() ack the pull (refs #80). The batch is aborted
// rather than partially sent, so a retry starts clean instead of double-
// inserting the rows that did append.
func appendAll(batch batchAppender, events []LogEvent, now time.Time) error {
	dropped := 0
	var firstAppendErr error
	for i, e := range events {
		ts := e.Timestamp
		if ts.After(now) {
			ts = now
		}
		if err := batch.Append(
			ts,
			e.Level,
			e.MessageTemplate,
			e.Message,
			e.Exception,
			e.EventType,
			e.Source,
			e.Properties,
			// Ingest lag is measured against this, not against timestamp, which
			// the client stamps. Supplied explicitly because the column's default
			// is the epoch sentinel — see clickhouse/init/010_events_inserted_at.sql.
			now,
		); err != nil {
			log.Printf("Append failed for event %d/%d (source=%s): %v", i+1, len(events), e.Source, err)
			dropped++
			if firstAppendErr == nil {
				firstAppendErr = err
			}
			continue
		}
	}

	if dropped > 0 {
		if err := batch.Abort(); err != nil {
			log.Printf("Warning: aborting batch after %d append failures: %v", dropped, err)
		}
		return fmt.Errorf("%w: %d/%d events (first: %v)", errAppendFailed, dropped, len(events), firstAppendErr)
	}
	return nil
}

func (c *Consumer) flushBatch(ctx context.Context, events []LogEvent) error {
	batch, err := c.conn.PrepareBatch(ctx,
		"INSERT INTO logs.events (timestamp, level, message_template, message, exception, event_type, source, properties, inserted_at)")
	if err != nil {
		return err
	}

	if err := appendAll(batch, events, time.Now()); err != nil {
		return err
	}

	return batch.Send()
}

// --- Cloudflare Queue API ---

func (c *Consumer) pullMessages(ctx context.Context) ([]QueueMessage, error) {
	url := fmt.Sprintf(
		"https://api.cloudflare.com/client/v4/accounts/%s/queues/%s/messages/pull",
		c.accountID, c.queueID,
	)

	body, _ := json.Marshal(map[string]interface{}{
		"visibility_timeout_ms": visibilityTimeoutMs,
		"batch_size":            c.batchSize,
	})

	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.apiToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("pull API returned %d: %s", resp.StatusCode, string(respBody))
	}

	var pullResp QueuePullResponse
	if err := json.NewDecoder(resp.Body).Decode(&pullResp); err != nil {
		return nil, err
	}

	return pullResp.Result.Messages, nil
}

// ackWithRetry retries a failed ack inside the message lease. Attempts are
// spaced so the whole sequence finishes well short of visibilityTimeoutMs —
// past that the messages are redelivered and retrying stops being useful.
func (c *Consumer) ackWithRetry(ctx context.Context, acks []QueueAck) error {
	backoff := ackRetryBaseDelay
	var err error
	for attempt := 1; attempt <= ackMaxAttempts; attempt++ {
		if err = c.ackMessages(ctx, acks); err == nil {
			if attempt > 1 {
				log.Printf("Acked %d messages on attempt %d", len(acks), attempt)
			}
			return nil
		}
		if attempt == ackMaxAttempts {
			break
		}
		log.Printf("Ack attempt %d/%d for %d messages failed (%v), retrying in %s",
			attempt, ackMaxAttempts, len(acks), err, backoff)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff *= 3
	}
	return fmt.Errorf("after %d attempts: %w", ackMaxAttempts, err)
}

func (c *Consumer) ackMessages(ctx context.Context, acks []QueueAck) error {
	url := fmt.Sprintf(
		"https://api.cloudflare.com/client/v4/accounts/%s/queues/%s/messages/ack",
		c.accountID, c.queueID,
	)

	body, _ := json.Marshal(QueueAckRequest{Acks: acks})

	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.apiToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("ack API returned %d: %s", resp.StatusCode, string(respBody))
	}

	return nil
}

// --- Helpers ---

func requireEnv(key string) string {
	val := os.Getenv(key)
	if val == "" {
		log.Fatalf("Required environment variable %s is not set", key)
	}
	return val
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

func envInt(key string, defaultVal int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
		log.Printf("Invalid %s=%q; using %d", key, v, defaultVal)
	}
	return defaultVal
}

func envDurationMs(key string, defaultMs int) time.Duration {
	raw := os.Getenv(key)
	if raw == "" {
		return time.Duration(defaultMs) * time.Millisecond
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		log.Printf("Invalid %s=%q, defaulting to %d", key, raw, defaultMs)
		return time.Duration(defaultMs) * time.Millisecond
	}
	return time.Duration(n) * time.Millisecond
}

// Blank import guard to ensure types are used.
var _ = strings.TrimSpace
