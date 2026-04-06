package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// parseCLEFBody parses an NDJSON CLEF body into LogEvents.
func parseCLEFBody(body []byte, source string) ([]LogEvent, error) {
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	var events []LogEvent
	lineNum := 0

	for scanner.Scan() {
		lineNum++
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		event, err := parseCLEFLine(line, source)
		if err != nil {
			return nil, fmt.Errorf("line %d: %w", lineNum, err)
		}
		if event != nil {
			events = append(events, *event)
		}
	}

	return events, scanner.Err()
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

	if ts.After(time.Now()) {
		ts = time.Now()
	}

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

	delete(raw, "@t")
	delete(raw, "@l")
	delete(raw, "@mt")
	delete(raw, "@m")
	delete(raw, "@x")
	delete(raw, "@i")

	if message == "" && messageTemplate != "" {
		message = renderMessageTemplate(messageTemplate, raw)
	}

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
