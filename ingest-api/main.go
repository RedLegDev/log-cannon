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
	conn       driver.Conn
	apiKeys    map[string]APIKey
	apiKeysMu  sync.RWMutex
	eventBatch []LogEvent
	batchMu    sync.Mutex
	lastFlush  time.Time
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

	server := &Server{
		conn:       conn,
		apiKeys:    make(map[string]APIKey),
		eventBatch: make([]LogEvent, 0, 1000),
		lastFlush:  time.Now(),
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
	http.HandleFunc("/api/events/raw", server.handleIngest)

	log.Printf("Starting ingest API on port %s", serverPort)
	log.Fatal(http.ListenAndServe(":"+serverPort, nil))
}

func (s *Server) loadAPIKeys() error {
	rows, err := s.conn.Query(context.Background(),
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

	batch, err := s.conn.PrepareBatch(context.Background(),
		"INSERT INTO logs.events (timestamp, level, message_template, message, exception, event_type, source, properties)")
	if err != nil {
		return err
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
			return err
		}
	}

	return batch.Send()
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := s.conn.Ping(context.Background()); err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{"status": "error", "error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (s *Server) handleIngest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract API key
	apiKey := r.Header.Get("X-Seq-ApiKey")
	if apiKey == "" {
		apiKey = r.URL.Query().Get("apiKey")
	}

	if apiKey == "" {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]string{"Error": "API key required"})
		return
	}

	// Validate API key with constant-time comparison
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
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{"Error": "Invalid or disabled API key"})
		return
	}

	source := matchedKey.Name

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

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{"MinimumLevelAccepted": nil})
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
	if message == "" {
		message = messageTemplate
	}

	exception := ""
	if x, ok := raw["@x"].(string); ok {
		exception = x
	}

	eventType := ""
	if i, ok := raw["@i"].(string); ok {
		eventType = i
	}

	// Remove CLEF fields, keep rest as properties
	delete(raw, "@t")
	delete(raw, "@l")
	delete(raw, "@mt")
	delete(raw, "@m")
	delete(raw, "@x")
	delete(raw, "@i")

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
