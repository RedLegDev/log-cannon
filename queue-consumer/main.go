package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// QueuePayload mirrors the TypeScript QueuePayload from the Workers.
type QueuePayload struct {
	Format      string `json:"format"`      // "clef", "webhook", "otlp-logs", "otlp-traces"
	Source      string `json:"source"`
	Body        string `json:"body"`         // base64-encoded raw request body
	ContentType string `json:"contentType"`
	Preset      string `json:"preset,omitempty"`
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
		conn:        conn,
		accountID:   cfAccountID,
		queueID:     cfQueueID,
		apiToken:    cfAPIToken,
		httpClient:  &http.Client{Timeout: 30 * time.Second},
		batchSize:   batchSize,
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

	log.Printf("Starting queue consumer (poll every %s, batch size %d)", pollInterval, batchSize)
	consumer.run(ctx, pollInterval)
}

type Consumer struct {
	conn       driver.Conn
	accountID  string
	queueID    string
	apiToken   string
	httpClient *http.Client
	batchSize  int
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
	messages, err := c.pullMessages(ctx)
	if err != nil {
		return fmt.Errorf("pull: %w", err)
	}
	if len(messages) == 0 {
		return nil
	}

	log.Printf("Pulled %d messages from queue", len(messages))

	var allEvents []LogEvent
	var deadLetterAcks []QueueAck // Corrupt/unparseable — ack unconditionally
	var goodAcks []QueueAck       // Successfully processed — ack only after flush

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
		goodAcks = append(goodAcks, QueueAck{LeaseID: msg.LeaseID})
	}

	// Always ack dead-letter messages so they don't block the queue
	if len(deadLetterAcks) > 0 {
		log.Printf("Acking %d dead-letter messages (corrupt/unparseable)", len(deadLetterAcks))
		if err := c.ackMessages(ctx, deadLetterAcks); err != nil {
			log.Printf("Warning: failed to ack %d dead-letter messages: %v", len(deadLetterAcks), err)
		}
	}

	// Batch insert into ClickHouse
	if len(allEvents) > 0 {
		if err := c.flushBatch(ctx, allEvents); err != nil {
			// Don't ack good messages if insert failed — they will be redelivered
			return fmt.Errorf("flush %d events: %w", len(allEvents), err)
		}
		log.Printf("Inserted %d events into ClickHouse", len(allEvents))
	}

	// Acknowledge successfully processed messages only after flush succeeds
	if len(goodAcks) > 0 {
		if err := c.ackMessages(ctx, goodAcks); err != nil {
			log.Printf("Warning: failed to ack %d messages after successful flush: %v", len(goodAcks), err)
		}
	}

	return nil
}

func (c *Consumer) processPayload(payload QueuePayload, rawBody []byte) ([]LogEvent, error) {
	switch payload.Format {
	case "clef":
		return parseCLEFBody(rawBody, payload.Source)
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

func (c *Consumer) flushBatch(ctx context.Context, events []LogEvent) error {
	batch, err := c.conn.PrepareBatch(ctx,
		"INSERT INTO logs.events (timestamp, level, message_template, message, exception, event_type, source, properties)")
	if err != nil {
		return err
	}

	now := time.Now()
	for _, e := range events {
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
		); err != nil {
			return err
		}
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
		"visibility_timeout_ms": 30000,
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

// Blank import guard to ensure types are used.
var _ = strings.TrimSpace
