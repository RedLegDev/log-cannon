// Package ship posts CLEF events to a Log Cannon ingest Worker over HTTPS.
//
// The Go services use this the same way any other client does: POST /ingest/clef
// with an X-Api-Key header. The key's registry name becomes logs.events.source.
//
// Shipping is best-effort and never fails the caller's work. Absent URL or key
// yields a no-op Client so a service starts and runs with shipping disabled.
package ship

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultTimeout = 5 * time.Second
	// Cap in-flight posts so a stalled ingest cannot pile up goroutines
	// against a service that is itself trying to drain work.
	maxInFlight = 8
)

// Client posts CLEF lines to LOG_CANNON_INGEST_URL. A nil *Client is safe:
// every method is a no-op.
type Client struct {
	url        string
	apiKey     string
	httpClient *http.Client

	sem       chan struct{}
	wg        sync.WaitGroup
	dropCount atomic.Uint64
}

// Config holds the optional shipping endpoint. Empty URL or APIKey disables.
type Config struct {
	URL    string
	APIKey string
}

// FromEnv reads LOG_CANNON_INGEST_URL and LOG_CANNON_API_KEY. Returns nil when
// either is unset. A nil *Client is safe to call (every method is a no-op).
func FromEnv() *Client {
	return New(Config{
		URL:    os.Getenv("LOG_CANNON_INGEST_URL"),
		APIKey: os.Getenv("LOG_CANNON_API_KEY"),
	})
}

// New returns nil when URL or APIKey is empty.
func New(cfg Config) *Client {
	url := strings.TrimRight(strings.TrimSpace(cfg.URL), "/")
	key := strings.TrimSpace(cfg.APIKey)
	if url == "" || key == "" {
		return nil
	}
	return &Client{
		url:    url,
		apiKey: key,
		httpClient: &http.Client{
			Timeout: defaultTimeout,
		},
		sem: make(chan struct{}, maxInFlight),
	}
}

// Close waits for in-flight posts (bounded). Safe on nil.
func (c *Client) Close() {
	if c == nil {
		return
	}
	c.wg.Wait()
}

// Dropped returns how many events were skipped because the in-flight cap was
// full. Useful in tests; production callers ignore it.
func (c *Client) Dropped() uint64 {
	if c == nil {
		return 0
	}
	return c.dropCount.Load()
}

// Event is one CLEF object. @t / @l / @mt are required for a useful row;
// other fields become properties (and render into the message when named in @mt).
type Event struct {
	Timestamp time.Time
	Level     string // Information, Warning, Error, …
	Template  string // CLEF @mt
	Props     map[string]any
}

// Emit queues a CLEF post and returns immediately. Nil client or a full
// in-flight queue drops the event; neither case returns an error to the caller.
func (c *Client) Emit(e Event) {
	if c == nil {
		return
	}
	select {
	case c.sem <- struct{}{}:
	default:
		c.dropCount.Add(1)
		return
	}
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		defer func() { <-c.sem }()
		if err := c.post(e); err != nil {
			// Never escalate: the platform must keep draining even when its
			// own telemetry cannot ship. Write straight to stderr — not
			// log.Printf — so a TeeWriter install cannot re-enter shipping.
			_, _ = fmt.Fprintf(os.Stderr, "ship: drop CLEF event: %v\n", err)
		}
	}()
}

// Info / Warn / Error are thin Emit wrappers with a fixed level.
func (c *Client) Info(template string, props map[string]any) {
	c.Emit(Event{Level: "Information", Template: template, Props: props})
}

func (c *Client) Warn(template string, props map[string]any) {
	c.Emit(Event{Level: "Warning", Template: template, Props: props})
}

func (c *Client) Error(template string, props map[string]any) {
	c.Emit(Event{Level: "Error", Template: template, Props: props})
}

func (c *Client) post(e Event) error {
	ts := e.Timestamp
	if ts.IsZero() {
		ts = time.Now().UTC()
	}
	obj := map[string]any{
		"@t":  ts.UTC().Format(time.RFC3339Nano),
		"@l":  clefLevel(e.Level),
		"@mt": e.Template,
	}
	for k, v := range e.Props {
		if k == "" || strings.HasPrefix(k, "@") {
			continue
		}
		obj[k] = v
	}
	body, err := json.Marshal(obj)
	if err != nil {
		return err
	}
	body = append(body, '\n')

	endpoint := c.url + "/ingest/clef"
	ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/vnd.serilog.clef")
	req.Header.Set("X-Api-Key", c.apiKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("ingest returned %d", resp.StatusCode)
	}
	return nil
}

// TeeWriter writes every log line to an underlying Writer (usually os.Stderr)
// and also ships it as a CLEF Information event. Used by alert-worker and
// retention-worker, whose volume is low. The queue-consumer must not tee —
// its per-poll lines would feed the feedback loop described in the ingest
// Worker's [observability] comment; it ships only thresholded timing events.
type TeeWriter struct {
	W      io.Writer
	Client *Client
	Level  string // default Information
}

func (t *TeeWriter) Write(p []byte) (int, error) {
	n, err := t.W.Write(p)
	if t.Client == nil || n == 0 {
		return n, err
	}
	msg := strings.TrimRight(string(p[:n]), "\r\n")
	if msg == "" {
		return n, err
	}
	t.Client.Emit(Event{
		Level:    clefLevel(t.Level),
		Template: "{Message}",
		Props:    map[string]any{"Message": msg},
	})
	return n, err
}

func clefLevel(level string) string {
	if level == "" {
		return "Information"
	}
	return level
}

// InstallStdLog replaces the default log package output with a TeeWriter when
// shipping is enabled. Call once at process start. Returns the client (possibly
// nil) so the caller can Close on shutdown.
func InstallStdLog() *Client {
	c := FromEnv()
	if c == nil {
		return nil
	}
	log.SetOutput(&TeeWriter{W: os.Stderr, Client: c})
	return c
}
