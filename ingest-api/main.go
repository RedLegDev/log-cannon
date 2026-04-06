package main

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

type LogEvent struct {
	ID              string
	Timestamp       time.Time
	Level           string
	MessageTemplate string
	Message         string
	Exception       string
	EventType       string
	Source          string
	Properties      string
}

type APIKey struct {
	APIKey  string
	Name    string
	Enabled uint8
}

type Server struct {
	conn          driver.Conn
	apiKeys       map[string]APIKey
	apiKeysMu     sync.RWMutex
	eventBatch    []LogEvent
	batchMu       sync.Mutex
	lastFlush     time.Time
	discoveryMode bool
	droppedEvents atomic.Int64
	flushedEvents atomic.Int64
}

func main() {
	host := getEnv("CLICKHOUSE_HOST", "clickhouse")
	port := getEnv("CLICKHOUSE_PORT", "9000")
	database := getEnv("CLICKHOUSE_DATABASE", "logs")
	user := getEnv("CLICKHOUSE_USER", "default")
	password := getEnv("CLICKHOUSE_PASSWORD", "")
	serverPort := getEnv("PORT", "8080")

	var conn driver.Conn
	var err error

	// Retry connection to ClickHouse
	for i := 0; i < 30; i++ {
		conn, err = clickhouse.Open(&clickhouse.Options{
			Addr: []string{fmt.Sprintf("%s:%s", host, port)},
			Auth: clickhouse.Auth{
				Database: database,
				Username: user,
				Password: password,
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

	discoveryMode := os.Getenv("DISCOVERY_MODE") == "true"
	if discoveryMode {
		log.Println("DISCOVERY MODE ENABLED - unknown API keys will be auto-provisioned")
	}

	server := &Server{
		conn:          conn,
		apiKeys:       make(map[string]APIKey),
		eventBatch:    make([]LogEvent, 0, 1000),
		lastFlush:     time.Now(),
		discoveryMode: discoveryMode,
	}

	// Load API keys
	if err := server.loadAPIKeys(); err != nil {
		log.Printf("Warning: Failed to load API keys: %v", err)
	}

	// Start background flusher
	go server.backgroundFlusher()

	// Start API key reloader
	go server.apiKeyReloader()

	http.HandleFunc("/health", server.handleHealth)
	http.HandleFunc("/ingest/clef", server.handleIngest)
	http.HandleFunc("/ingest/webhook", server.handleWebhook)
	http.HandleFunc("/ingest/otlp/logs", server.handleOTLPLogs)
	http.HandleFunc("/ingest/otlp/traces", server.handleOTLPTraces)

	// Aliases for backward compatibility
	http.HandleFunc("/api/events/raw", server.handleIngest)  // Seq/Serilog clients
	http.HandleFunc("/v1/logs", server.handleOTLPLogs)       // OTel SDK standard path
	http.HandleFunc("/v1/traces", server.handleOTLPTraces)   // OTel SDK standard path

	log.Printf("Starting ingest API on port %s", serverPort)
	log.Fatal(http.ListenAndServe(":"+serverPort, nil))
}

func (s *Server) loadAPIKeys() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	rows, err := s.conn.Query(ctx,
		"SELECT api_key, name, enabled FROM logs.api_keys")
	if err != nil {
		return err
	}
	defer rows.Close()

	keys := make(map[string]APIKey)
	for rows.Next() {
		var k APIKey
		if err := rows.Scan(&k.APIKey, &k.Name, &k.Enabled); err != nil {
			return err
		}
		keys[k.APIKey] = k
	}

	s.apiKeysMu.Lock()
	s.apiKeys = keys
	s.apiKeysMu.Unlock()

	log.Printf("Loaded %d API keys", len(keys))
	return nil
}

func (s *Server) apiKeyReloader() {
	ticker := time.NewTicker(30 * time.Second)
	for range ticker.C {
		if err := s.loadAPIKeys(); err != nil {
			log.Printf("Failed to reload API keys: %v", err)
		}
	}
}

func (s *Server) discoverAPIKey(apiKey string) (*APIKey, error) {
	// Acquire write lock first to prevent race conditions
	s.apiKeysMu.Lock()

	// Check again if key was added by another goroutine while we waited
	if existing, ok := s.apiKeys[apiKey]; ok {
		s.apiKeysMu.Unlock()
		return &existing, nil
	}

	// Generate source name from key prefix
	prefix := apiKey
	if len(prefix) > 8 {
		prefix = prefix[:8]
	}
	name := fmt.Sprintf("discovered-%s", prefix)

	// Insert into database
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := s.conn.Exec(ctx, `
		INSERT INTO logs.api_keys (api_key, name, enabled)
		VALUES ($1, $2, 1)
	`, apiKey, name)
	if err != nil {
		s.apiKeysMu.Unlock()
		return nil, fmt.Errorf("failed to insert discovered key: %w", err)
	}

	// Add to in-memory cache (we already hold the lock)
	newKey := APIKey{
		APIKey:  apiKey,
		Name:    name,
		Enabled: 1,
	}
	s.apiKeys[apiKey] = newKey
	s.apiKeysMu.Unlock()

	return &newKey, nil
}

func (s *Server) backgroundFlusher() {
	ticker := time.NewTicker(time.Second)
	for range ticker.C {
		s.batchMu.Lock()
		if len(s.eventBatch) > 0 && time.Since(s.lastFlush) >= time.Second {
			batch := s.eventBatch
			s.eventBatch = make([]LogEvent, 0, 1000)
			s.lastFlush = time.Now()
			s.batchMu.Unlock()

			if err := s.flushBatch(batch); err != nil {
				log.Printf("Failed to flush batch: %v", err)
			}
		} else {
			s.batchMu.Unlock()
		}
	}
}

func (s *Server) flushBatch(events []LogEvent) error {
	if len(events) == 0 {
		return nil
	}

	const maxRetries = 3
	var lastErr error
	for attempt := range maxRetries {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * time.Second)
		}

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		batch, err := s.conn.PrepareBatch(ctx,
			"INSERT INTO logs.events (timestamp, level, message_template, message, exception, event_type, source, properties)")
		if err != nil {
			cancel()
			lastErr = err
			log.Printf("Flush attempt %d/%d: PrepareBatch error: %v", attempt+1, maxRetries, err)
			continue
		}

		for _, e := range events {
			if err := batch.Append(
				e.Timestamp,
				e.Level,
				e.MessageTemplate,
				e.Message,
				e.Exception,
				e.EventType,
				e.Source,
				e.Properties,
			); err != nil {
				cancel()
				lastErr = err
				log.Printf("Flush attempt %d/%d: Append error: %v", attempt+1, maxRetries, err)
				continue
			}
		}

		if err := batch.Send(); err != nil {
			cancel()
			lastErr = err
			log.Printf("Flush attempt %d/%d: Send error: %v", attempt+1, maxRetries, err)
			continue
		}

		cancel()
		s.flushedEvents.Add(int64(len(events)))
		return nil
	}

	s.droppedEvents.Add(int64(len(events)))
	return fmt.Errorf("flush failed after %d attempts (%d events dropped): %w", maxRetries, len(events), lastErr)
}

// validateAPIKey checks the provided API key against known keys using
// constant-time comparison. In discovery mode, unknown keys are auto-provisioned.
// Returns the source name associated with the key, or an error.
func (s *Server) validateAPIKey(apiKey string) (string, error) {
	s.apiKeysMu.RLock()
	var matchedKey *APIKey
	for key, k := range s.apiKeys {
		if subtle.ConstantTimeCompare([]byte(key), []byte(apiKey)) == 1 {
			matchedKey = &k
			break
		}
	}
	s.apiKeysMu.RUnlock()

	if matchedKey == nil || matchedKey.Enabled == 0 {
		if s.discoveryMode && matchedKey == nil {
			newKey, err := s.discoverAPIKey(apiKey)
			if err != nil {
				return "", fmt.Errorf("failed to auto-provision key: %w", err)
			}
			log.Printf("DISCOVERY: Auto-provisioned API key as source=%s", newKey.Name)
			return newKey.Name, nil
		}
		return "", fmt.Errorf("invalid or disabled API key")
	}

	return matchedKey.Name, nil
}

// addEventsToBatch appends events to the internal batch and flushes if the
// batch reaches 1000 events.
func (s *Server) addEventsToBatch(events []LogEvent) {
	// Clamp future timestamps to now (defense against misconfigured clients)
	now := time.Now()
	for i := range events {
		if events[i].Timestamp.After(now) {
			events[i].Timestamp = now
		}
	}
	s.batchMu.Lock()
	s.eventBatch = append(s.eventBatch, events...)
	shouldFlush := len(s.eventBatch) >= 1000
	if shouldFlush {
		batch := s.eventBatch
		s.eventBatch = make([]LogEvent, 0, 1000)
		s.lastFlush = time.Now()
		s.batchMu.Unlock()

		if err := s.flushBatch(batch); err != nil {
			log.Printf("Failed to flush batch: %v", err)
		}
	} else {
		s.batchMu.Unlock()
	}
}

func setCORSHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Seq-ApiKey, X-Api-Key, Authorization")
}

// extractAPIKey extracts an API key from the request, checking multiple sources:
// 1. X-Api-Key header (preferred)
// 2. X-Seq-ApiKey header (backward compatibility with Seq/Serilog clients)
// 3. apiKey query parameter
// 4. Authorization: Bearer header
func extractAPIKey(r *http.Request) string {
	if key := r.Header.Get("X-Api-Key"); key != "" {
		return key
	}
	if key := r.Header.Get("X-Seq-ApiKey"); key != "" {
		return key
	}
	if key := r.URL.Query().Get("apiKey"); key != "" {
		return key
	}
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	return ""
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	dropped := s.droppedEvents.Load()
	flushed := s.flushedEvents.Load()
	if err := s.conn.Ping(ctx); err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":         "error",
			"error":          err.Error(),
			"flushed_events": flushed,
			"dropped_events": dropped,
		})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":         "ok",
		"flushed_events": flushed,
		"dropped_events": dropped,
	})
}

func (s *Server) handleIngest(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Limit request body size to prevent memory exhaustion
	r.Body = http.MaxBytesReader(w, r.Body, 32<<20) // 32 MB

	// Extract API key
	apiKey := extractAPIKey(r)
	if apiKey == "" {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]string{"Error": "API key required"})
		return
	}

	source, err := s.validateAPIKey(apiKey)
	if err != nil {
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{"Error": "Invalid or disabled API key"})
		return
	}

	// Parse CLEF events
	scanner := bufio.NewScanner(r.Body)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // 1MB max line
	lineNum := 0
	events := make([]LogEvent, 0)

	for scanner.Scan() {
		lineNum++
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		event, err := parseCLEFLine(line, source)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"Error": fmt.Sprintf("Line %d: %v", lineNum, err)})
			return
		}

		if event != nil {
			events = append(events, *event)
		}
	}

	if err := scanner.Err(); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"Error": fmt.Sprintf("Failed to read body: %v", err)})
		return
	}

	// Add events to batch
	s.addEventsToBatch(events)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{"MinimumLevelAccepted": nil})
}

// renderMessageTemplate replaces {PropertyName} placeholders with actual values
func renderMessageTemplate(template string, properties map[string]interface{}) string {
	if template == "" {
		return ""
	}

	result := template
	for key, value := range properties {
		placeholder := "{" + key + "}"
		var replacement string
		switch v := value.(type) {
		case string:
			replacement = v
		case float64:
			if v == float64(int64(v)) {
				replacement = fmt.Sprintf("%d", int64(v))
			} else {
				replacement = fmt.Sprintf("%g", v)
			}
		case bool:
			replacement = fmt.Sprintf("%t", v)
		case nil:
			replacement = "null"
		default:
			b, _ := json.Marshal(v)
			replacement = string(b)
		}
		result = strings.ReplaceAll(result, placeholder, replacement)
	}
	return result
}

func parseCLEFLine(line string, source string) (*LogEvent, error) {
	var raw map[string]interface{}
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return nil, fmt.Errorf("invalid JSON")
	}

	// Extract @t (required)
	tsRaw, ok := raw["@t"]
	if !ok {
		return nil, fmt.Errorf("missing @t field")
	}
	tsStr, ok := tsRaw.(string)
	if !ok {
		return nil, fmt.Errorf("@t must be a string")
	}
	ts, err := time.Parse(time.RFC3339Nano, tsStr)
	if err != nil {
		ts, err = time.Parse(time.RFC3339, tsStr)
		if err != nil {
			return nil, fmt.Errorf("invalid timestamp format")
		}
	}

	// Clamp future timestamps to now
	if ts.After(time.Now()) {
		ts = time.Now()
	}

	// Extract optional CLEF fields
	level := "Information"
	if l, ok := raw["@l"].(string); ok {
		level = l
	}

	messageTemplate := ""
	if mt, ok := raw["@mt"].(string); ok {
		messageTemplate = mt
	}

	message := ""
	if m, ok := raw["@m"].(string); ok {
		message = m
	}

	exception := ""
	if x, ok := raw["@x"].(string); ok {
		exception = x
	}

	eventType := ""
	if i, ok := raw["@i"].(string); ok {
		eventType = i
	}

	// Remove CLEF fields, keep rest as properties for rendering
	delete(raw, "@t")
	delete(raw, "@l")
	delete(raw, "@mt")
	delete(raw, "@m")
	delete(raw, "@x")
	delete(raw, "@i")

	// Render message template if @m was not provided
	if message == "" && messageTemplate != "" {
		message = renderMessageTemplate(messageTemplate, raw)
	}

	// Auto-compute event type from message template when not provided by client.
	if eventType == "" {
		eventType = computeEventType(messageTemplate, message)
	}

	propsJSON := "{}"
	if len(raw) > 0 {
		b, _ := json.Marshal(raw)
		propsJSON = string(b)
	}

	return &LogEvent{
		Timestamp:       ts,
		Level:           level,
		MessageTemplate: messageTemplate,
		Message:         message,
		Exception:       exception,
		EventType:       eventType,
		Source:          source,
		Properties:      propsJSON,
	}, nil
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}
