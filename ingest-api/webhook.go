package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
)

func (s *Server) handleWebhook(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

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

	// Get preset from query param
	presetName := r.URL.Query().Get("preset")
	preset := getPreset(presetName)

	// Handle gzip decompression
	var body io.Reader = r.Body
	if r.Header.Get("Content-Encoding") == "gzip" {
		gz, err := gzip.NewReader(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"Error": "Failed to decompress gzip body"})
			return
		}
		defer gz.Close()
		body = gz
	}

	// Read first bytes to detect Cloudflare validation handshake.
	// Cloudflare sends a test.txt.gz file during Logpush setup that is not
	// JSON. If the body doesn't start with '{' or '[', return 200 OK.
	peek := make([]byte, 1)
	n, err := body.Read(peek)
	if err != nil && err != io.EOF {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"Error": fmt.Sprintf("Failed to read body: %v", err)})
		return
	}
	if n == 0 {
		// Empty body
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{"accepted": 0, "errors": 0})
		return
	}

	if peek[0] != '{' && peek[0] != '[' {
		// Not JSON — likely a Cloudflare validation handshake
		w.WriteHeader(http.StatusOK)
		return
	}

	// Reconstruct reader with the already-read byte
	body = io.MultiReader(bytes.NewReader(peek[:n]), body)

	// Parse ndjson lines
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // 1MB max line buffer

	events := make([]LogEvent, 0)
	accepted := 0
	errors := 0

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		var raw map[string]interface{}
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			errors++
			continue
		}

		event := mapWebhookEvent(raw, preset, source)
		events = append(events, event)
		accepted++
	}

	if err := scanner.Err(); err != nil {
		log.Printf("Scanner error reading webhook body: %v", err)
	}

	if errors > 0 {
		log.Printf("Webhook ingest: %d malformed lines skipped", errors)
	}

	if len(events) > 0 {
		s.addEventsToBatch(events)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{"accepted": accepted, "errors": errors})
}
