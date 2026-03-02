package main

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// WebhookPreset defines how arbitrary JSON fields map to Log Cannon's LogEvent schema.
type WebhookPreset struct {
	Name            string
	TimestampField  string   // field name containing timestamp
	TimestampFormat string   // "unixnano", "unix", "rfc3339", "auto"
	LevelField      string   // field name containing level, "" = none
	LevelDefault    string   // default level if no field
	LevelFromStatus bool     // derive level from HTTP status code
	StatusField     string   // field name for HTTP status (used with LevelFromStatus)
	MessageTemplate string   // template with {FieldName} placeholders
	SourceField     string   // field name for source, "" = use API key name
	EventTypeField  string
	ExcludeFields   []string
}

// Common field names for auto-detection.
var commonTimestampFields = []string{
	"timestamp", "time", "@timestamp", "@t", "ts", "date", "datetime", "created_at",
}

var commonLevelFields = []string{
	"level", "severity", "@l", "log_level", "loglevel",
}

// builtinPresets holds all registered webhook presets.
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

// defaultPreset is used when no preset is specified. It auto-detects fields.
var defaultPreset = WebhookPreset{
	Name:            "",
	TimestampFormat: "auto",
	LevelDefault:    "Information",
}

// getPreset returns the preset for the given name. An empty name returns the
// default auto-detecting preset.
func getPreset(name string) WebhookPreset {
	if name == "" {
		return defaultPreset
	}
	if p, ok := builtinPresets[strings.ToLower(name)]; ok {
		return p
	}
	return defaultPreset
}

// levelFromHTTPStatus maps an HTTP status code to a log level.
func levelFromHTTPStatus(status int) string {
	if status >= 500 {
		return "Error"
	}
	if status >= 400 {
		return "Warning"
	}
	return "Information"
}

// parseWebhookTimestamp extracts and parses a timestamp from the raw event
// using the preset configuration. Falls back to time.Now() when nothing works.
func parseWebhookTimestamp(raw map[string]interface{}, preset WebhookPreset) time.Time {
	field := preset.TimestampField

	// If no explicit field, try auto-detecting from common names.
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
	case "auto":
		return parseAutoTimestamp(val)
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
	// Try string (RFC3339) first.
	if s, ok := val.(string); ok {
		t, err := time.Parse(time.RFC3339Nano, s)
		if err == nil {
			return t
		}
		t, err = time.Parse(time.RFC3339, s)
		if err == nil {
			return t
		}
		// Try parsing as a numeric string.
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return detectNumericTimestamp(f)
		}
		return time.Now()
	}

	// Try numeric.
	if f, ok := toFloat64(val); ok {
		return detectNumericTimestamp(f)
	}

	return time.Now()
}

// detectNumericTimestamp guesses seconds vs milliseconds vs microseconds vs
// nanoseconds by magnitude.
func detectNumericTimestamp(f float64) time.Time {
	abs := math.Abs(f)
	switch {
	case abs > 1e18: // nanoseconds
		return time.Unix(0, int64(f))
	case abs > 1e15: // microseconds
		return time.Unix(0, int64(f)*1000)
	case abs > 1e12: // milliseconds
		return time.Unix(0, int64(f)*1e6)
	default: // seconds
		sec := int64(f)
		nsec := int64((f - float64(sec)) * 1e9)
		return time.Unix(sec, nsec)
	}
}

// toFloat64 converts a JSON number (float64) or numeric string to float64.
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

// mapWebhookEvent transforms a raw JSON object into a LogEvent using the given
// preset configuration and a default source name (typically from the API key).
func mapWebhookEvent(raw map[string]interface{}, preset WebhookPreset, defaultSource string) LogEvent {
	// --- Timestamp ---
	ts := parseWebhookTimestamp(raw, preset)
	if ts.After(time.Now()) {
		ts = time.Now()
	}

	// --- Level ---
	level := preset.LevelDefault
	if level == "" {
		level = "Information"
	}

	// Try explicit level field first.
	if preset.LevelField != "" {
		if l, ok := raw[preset.LevelField].(string); ok && l != "" {
			level = l
		}
	} else {
		// Auto-detect level from common field names.
		for _, f := range commonLevelFields {
			if l, ok := raw[f].(string); ok && l != "" {
				level = l
				break
			}
		}
	}

	// Override from HTTP status if configured.
	if preset.LevelFromStatus && preset.StatusField != "" {
		if statusVal, ok := raw[preset.StatusField]; ok {
			if statusF, ok := toFloat64(statusVal); ok {
				level = levelFromHTTPStatus(int(statusF))
			}
		}
	}

	// --- Source ---
	source := defaultSource
	if preset.SourceField != "" {
		if s, ok := raw[preset.SourceField].(string); ok && s != "" {
			source = s
		}
	}

	// --- Event Type ---
	eventType := ""
	if preset.EventTypeField != "" {
		if et, ok := raw[preset.EventTypeField].(string); ok {
			eventType = et
		}
	}

	// --- Message ---
	messageTemplate := preset.MessageTemplate
	message := ""
	if messageTemplate != "" {
		message = renderMessageTemplate(messageTemplate, raw)
	} else {
		// No template: JSON-serialize entire record as message.
		b, err := json.Marshal(raw)
		if err == nil {
			message = string(b)
		} else {
			message = fmt.Sprintf("%v", raw)
		}
	}

	// Auto-compute event type from message template when not provided.
	if eventType == "" {
		eventType = computeEventType(messageTemplate, message)
	}

	// --- Properties ---
	// Build properties excluding mapped/excluded fields.
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

// buildExcludeSet returns a set of field names that should not appear in
// the properties JSON (because they have been mapped to LogEvent fields).
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
