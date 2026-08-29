package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"
	"time"
)

// WebhookPreset defines how arbitrary JSON fields map to LogEvent schema.
type WebhookPreset struct {
	Name            string
	TimestampField  string
	TimestampFormat string
	LevelField      string
	LevelDefault    string
	LevelFromStatus bool
	StatusField     string
	MessageTemplate string
	SourceField     string
	EventTypeField  string
	ExcludeFields   []string
}

var commonTimestampFields = []string{
	"timestamp", "time", "@timestamp", "@t", "ts", "date", "datetime", "created_at",
}

var commonLevelFields = []string{
	"level", "severity", "@l", "log_level", "loglevel",
}

var builtinPresets = map[string]WebhookPreset{
	"cloudflare": {
		Name:            "cloudflare",
		TimestampField:  "EdgeStartTimestamp",
		TimestampFormat: "unixnano",
		LevelFromStatus: true,
		StatusField:     "EdgeResponseStatus",
		MessageTemplate: "{ClientRequestMethod} {ClientRequestHost}{ClientRequestURI} → {EdgeResponseStatus}",
		SourceField:     "ClientRequestHost",
	},
}

var defaultPreset = WebhookPreset{
	TimestampFormat: "auto",
	LevelDefault:    "Information",
}

func getPreset(name string) WebhookPreset {
	if name == "" {
		return defaultPreset
	}
	if p, ok := builtinPresets[strings.ToLower(name)]; ok {
		return p
	}
	return defaultPreset
}

// parseWebhookBody parses a webhook body into LogEvents.
// Accepts a JSON array (compact or pretty-printed), NDJSON (one object per
// line), or a single JSON object on one line. The ingest Worker already
// enqueues bodies starting with `{` or `[`; without the array path a compact
// `[{...}]` is one line that fails Unmarshal into a map and stores nothing.
func parseWebhookBody(body []byte, source string, presetName string) ([]LogEvent, error) {
	preset := getPreset(presetName)
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return nil, nil
	}

	if trimmed[0] == '[' {
		return parseWebhookArray(trimmed, source, preset)
	}
	return parseWebhookNDJSON(trimmed, source, preset)
}

func parseWebhookArray(body []byte, source string, preset WebhookPreset) ([]LogEvent, error) {
	var items []json.RawMessage
	if err := json.Unmarshal(body, &items); err != nil {
		log.Printf("Webhook ingest: invalid JSON array: %v", err)
		return nil, fmt.Errorf("invalid JSON array: %w", err)
	}

	var events []LogEvent
	skipped := 0
	for _, item := range items {
		var raw map[string]interface{}
		if err := json.Unmarshal(item, &raw); err != nil {
			skipped++
			continue
		}
		events = append(events, mapWebhookEvent(raw, preset, source))
	}

	if skipped > 0 {
		log.Printf("Webhook ingest: %d non-object array elements skipped", skipped)
	}
	if len(events) == 0 && len(items) > 0 {
		log.Printf("Webhook ingest: 0 events from %d-element array (%d skipped)", len(items), skipped)
		return nil, fmt.Errorf("webhook array produced 0 events (%d elements, %d skipped)", len(items), skipped)
	}

	return events, nil
}

func parseWebhookNDJSON(body []byte, source string, preset WebhookPreset) ([]LogEvent, error) {
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	var events []LogEvent
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

		events = append(events, mapWebhookEvent(raw, preset, source))
	}

	if err := scanner.Err(); err != nil {
		return events, err
	}

	if errors > 0 {
		log.Printf("Webhook ingest: %d malformed lines skipped", errors)
	}
	if len(events) == 0 && errors > 0 {
		log.Printf("Webhook ingest: 0 events after skipping %d malformed lines", errors)
		return nil, fmt.Errorf("webhook NDJSON produced 0 events (%d malformed lines)", errors)
	}

	return events, nil
}

func levelFromHTTPStatus(status int) string {
	if status >= 500 {
		return "Error"
	}
	if status >= 400 {
		return "Warning"
	}
	return "Information"
}

func parseWebhookTimestamp(raw map[string]interface{}, preset WebhookPreset) time.Time {
	field := preset.TimestampField
	if field == "" {
		for _, f := range commonTimestampFields {
			if _, ok := raw[f]; ok {
				field = f
				break
			}
		}
	}
	if field == "" {
		return time.Now()
	}

	val, ok := raw[field]
	if !ok {
		return time.Now()
	}

	format := preset.TimestampFormat
	if format == "" {
		format = "auto"
	}

	switch format {
	case "rfc3339":
		return parseRFC3339(val)
	case "unix":
		return parseUnixSeconds(val)
	case "unixnano":
		return parseUnixNano(val)
	default:
		return parseAutoTimestamp(val)
	}
}

func parseRFC3339(val interface{}) time.Time {
	s, ok := val.(string)
	if !ok {
		return time.Now()
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t, err = time.Parse(time.RFC3339, s)
		if err != nil {
			return time.Now()
		}
	}
	return t
}

func parseUnixSeconds(val interface{}) time.Time {
	f, ok := toFloat64(val)
	if !ok {
		return time.Now()
	}
	sec := int64(f)
	nsec := int64((f - float64(sec)) * 1e9)
	return time.Unix(sec, nsec)
}

func parseUnixNano(val interface{}) time.Time {
	f, ok := toFloat64(val)
	if !ok {
		return time.Now()
	}
	return time.Unix(0, int64(f))
}

func parseAutoTimestamp(val interface{}) time.Time {
	if s, ok := val.(string); ok {
		t, err := time.Parse(time.RFC3339Nano, s)
		if err == nil {
			return t
		}
		t, err = time.Parse(time.RFC3339, s)
		if err == nil {
			return t
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return detectNumericTimestamp(f)
		}
		return time.Now()
	}
	if f, ok := toFloat64(val); ok {
		return detectNumericTimestamp(f)
	}
	return time.Now()
}

func detectNumericTimestamp(f float64) time.Time {
	abs := math.Abs(f)
	switch {
	case abs > 1e18:
		return time.Unix(0, int64(f))
	case abs > 1e15:
		return time.Unix(0, int64(f)*1000)
	case abs > 1e12:
		return time.Unix(0, int64(f)*1e6)
	default:
		sec := int64(f)
		nsec := int64((f - float64(sec)) * 1e9)
		return time.Unix(sec, nsec)
	}
}

func toFloat64(val interface{}) (float64, bool) {
	switch v := val.(type) {
	case float64:
		return v, true
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(v, 64)
		return f, err == nil
	default:
		return 0, false
	}
}

func mapWebhookEvent(raw map[string]interface{}, preset WebhookPreset, defaultSource string) LogEvent {
	ts := parseWebhookTimestamp(raw, preset)
	if ts.After(time.Now()) {
		ts = time.Now()
	}

	level := preset.LevelDefault
	if level == "" {
		level = "Information"
	}

	if preset.LevelField != "" {
		if l, ok := raw[preset.LevelField].(string); ok && l != "" {
			level = l
		}
	} else {
		for _, f := range commonLevelFields {
			if l, ok := raw[f].(string); ok && l != "" {
				level = l
				break
			}
		}
	}

	if preset.LevelFromStatus && preset.StatusField != "" {
		if statusVal, ok := raw[preset.StatusField]; ok {
			if statusF, ok := toFloat64(statusVal); ok {
				level = levelFromHTTPStatus(int(statusF))
			}
		}
	}

	source := defaultSource
	if preset.SourceField != "" {
		if s, ok := raw[preset.SourceField].(string); ok && s != "" {
			source = s
		}
	}

	eventType := ""
	if preset.EventTypeField != "" {
		if et, ok := raw[preset.EventTypeField].(string); ok {
			eventType = et
		}
	}

	messageTemplate := preset.MessageTemplate
	message := ""
	if messageTemplate != "" {
		message = renderMessageTemplate(messageTemplate, raw)
	} else {
		b, err := json.Marshal(raw)
		if err == nil {
			message = string(b)
		} else {
			message = fmt.Sprintf("%v", raw)
		}
	}

	if eventType == "" {
		eventType = computeEventType(messageTemplate, message)
	}

	excluded := buildExcludeSet(preset)
	props := make(map[string]interface{})
	for k, v := range raw {
		if _, skip := excluded[k]; !skip {
			props[k] = v
		}
	}

	propsJSON := "{}"
	if len(props) > 0 {
		b, _ := json.Marshal(props)
		propsJSON = string(b)
	}

	return LogEvent{
		Timestamp:       ts,
		Level:           level,
		MessageTemplate: messageTemplate,
		Message:         message,
		EventType:       eventType,
		Source:          source,
		Properties:      propsJSON,
	}
}

func buildExcludeSet(preset WebhookPreset) map[string]struct{} {
	set := make(map[string]struct{})
	addIfNonEmpty := func(f string) {
		if f != "" {
			set[f] = struct{}{}
		}
	}
	addIfNonEmpty(preset.TimestampField)
	addIfNonEmpty(preset.LevelField)
	addIfNonEmpty(preset.SourceField)
	addIfNonEmpty(preset.EventTypeField)
	addIfNonEmpty(preset.StatusField)
	for _, f := range preset.ExcludeFields {
		set[f] = struct{}{}
	}
	return set
}
