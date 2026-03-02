package main

import (
	"compress/gzip"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	collogspb "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	coltracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/otlp/logs/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// readBody reads the request body, handling gzip decompression if needed.
func readBody(r *http.Request) ([]byte, error) {
	var reader io.Reader = r.Body
	if r.Header.Get("Content-Encoding") == "gzip" {
		gz, err := gzip.NewReader(r.Body)
		if err != nil {
			return nil, fmt.Errorf("failed to create gzip reader: %w", err)
		}
		defer gz.Close()
		reader = gz
	}
	return io.ReadAll(reader)
}

// otlpSeverityToLevel maps OTLP severity text and number to Log Cannon levels.
func otlpSeverityToLevel(severityText string, severityNumber int) string {
	// Try text first
	if severityText != "" {
		upper := strings.ToUpper(severityText)
		switch {
		case strings.HasPrefix(upper, "TRACE"), strings.HasPrefix(upper, "DEBUG"):
			return "Debug"
		case strings.HasPrefix(upper, "INFO"):
			return "Information"
		case strings.HasPrefix(upper, "WARN"):
			return "Warning"
		case strings.HasPrefix(upper, "ERROR"):
			return "Error"
		case strings.HasPrefix(upper, "FATAL"):
			return "Fatal"
		}
	}

	// Fall back to severity number
	if severityNumber > 0 {
		switch {
		case severityNumber <= 4:
			return "Verbose"
		case severityNumber <= 8:
			return "Debug"
		case severityNumber <= 12:
			return "Information"
		case severityNumber <= 16:
			return "Warning"
		case severityNumber <= 20:
			return "Error"
		default:
			return "Fatal"
		}
	}

	return "Information"
}

// spanKindToString converts an OTLP span kind enum to a readable string.
func spanKindToString(kind int) string {
	switch kind {
	case 1:
		return "INTERNAL"
	case 2:
		return "SERVER"
	case 3:
		return "CLIENT"
	case 4:
		return "PRODUCER"
	case 5:
		return "CONSUMER"
	default:
		return "UNSPECIFIED"
	}
}

// otlpAnyValueToString extracts a string representation from an OTLP AnyValue.
func otlpAnyValueToString(v *commonpb.AnyValue) string {
	if v == nil {
		return ""
	}
	switch val := v.Value.(type) {
	case *commonpb.AnyValue_StringValue:
		return val.StringValue
	case *commonpb.AnyValue_IntValue:
		return fmt.Sprintf("%d", val.IntValue)
	case *commonpb.AnyValue_DoubleValue:
		return fmt.Sprintf("%g", val.DoubleValue)
	case *commonpb.AnyValue_BoolValue:
		return fmt.Sprintf("%t", val.BoolValue)
	case *commonpb.AnyValue_BytesValue:
		return hex.EncodeToString(val.BytesValue)
	default:
		b, _ := json.Marshal(otlpAnyValueToInterface(v))
		return string(b)
	}
}

// otlpAnyValueToInterface converts an OTLP AnyValue to a native Go interface{}.
func otlpAnyValueToInterface(v *commonpb.AnyValue) interface{} {
	if v == nil {
		return nil
	}
	switch val := v.Value.(type) {
	case *commonpb.AnyValue_StringValue:
		return val.StringValue
	case *commonpb.AnyValue_IntValue:
		return val.IntValue
	case *commonpb.AnyValue_DoubleValue:
		return val.DoubleValue
	case *commonpb.AnyValue_BoolValue:
		return val.BoolValue
	case *commonpb.AnyValue_BytesValue:
		return hex.EncodeToString(val.BytesValue)
	case *commonpb.AnyValue_ArrayValue:
		if val.ArrayValue == nil {
			return nil
		}
		arr := make([]interface{}, len(val.ArrayValue.Values))
		for i, item := range val.ArrayValue.Values {
			arr[i] = otlpAnyValueToInterface(item)
		}
		return arr
	case *commonpb.AnyValue_KvlistValue:
		if val.KvlistValue == nil {
			return nil
		}
		m := make(map[string]interface{})
		for _, kv := range val.KvlistValue.Values {
			m[kv.Key] = otlpAnyValueToInterface(kv.Value)
		}
		return m
	default:
		return nil
	}
}

// attributesToMap converts OTLP KeyValue attributes to a Go map.
func attributesToMap(attrs []*commonpb.KeyValue) map[string]interface{} {
	m := make(map[string]interface{})
	for _, kv := range attrs {
		m[kv.Key] = otlpAnyValueToInterface(kv.Value)
	}
	return m
}

// getResourceServiceName extracts service.name from resource attributes.
func getResourceServiceName(attrs []*commonpb.KeyValue) string {
	for _, kv := range attrs {
		if kv.Key == "service.name" {
			return otlpAnyValueToString(kv.Value)
		}
	}
	return ""
}

// extractOTLPAPIKey delegates to the shared extractAPIKey in main.go.
func extractOTLPAPIKey(r *http.Request) string {
	return extractAPIKey(r)
}

// handleOTLPLogs handles POST /v1/logs for OTLP log ingestion.
func (s *Server) handleOTLPLogs(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract and validate API key
	apiKey := extractOTLPAPIKey(r)
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

	// Read body with gzip support
	body, err := readBody(r)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"Error": fmt.Sprintf("Failed to read body: %v", err)})
		return
	}

	// Parse the export request
	var exportReq collogspb.ExportLogsServiceRequest
	ct := r.Header.Get("Content-Type")
	if ct == "application/x-protobuf" || ct == "application/proto" {
		if err := proto.Unmarshal(body, &exportReq); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"Error": fmt.Sprintf("Failed to parse protobuf: %v", err)})
			return
		}
	} else {
		// Use protojson for correct proto3 JSON mapping (handles string-encoded uint64, etc.)
		if err := protojson.Unmarshal(body, &exportReq); err != nil {
			// Fallback to protobuf binary in case content-type is wrong
			if err2 := proto.Unmarshal(body, &exportReq); err2 != nil {
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(map[string]string{"Error": fmt.Sprintf("Failed to parse body as JSON or protobuf: json=%v, proto=%v", err, err2)})
				return
			}
		}
	}

	// Convert OTLP log records to LogEvents
	events := make([]LogEvent, 0)
	for _, rl := range exportReq.ResourceLogs {
		serviceName := ""
		if rl.Resource != nil {
			serviceName = getResourceServiceName(rl.Resource.Attributes)
		}
		eventSource := source
		if serviceName != "" {
			eventSource = serviceName
		}

		for _, sl := range rl.ScopeLogs {
			for _, lr := range sl.LogRecords {
				event := convertOTLPLogRecord(lr, eventSource)
				events = append(events, event)
			}
		}
	}

	if len(events) > 0 {
		s.addEventsToBatch(events)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"partialSuccess": map[string]interface{}{
			"rejectedLogRecords": 0,
			"errorMessage":       "",
		},
	})
}

// convertOTLPLogRecord converts a single OTLP LogRecord to a LogEvent.
func convertOTLPLogRecord(lr *logspb.LogRecord, source string) LogEvent {
	// Determine timestamp
	ts := time.Now()
	if lr.TimeUnixNano > 0 {
		ts = time.Unix(0, int64(lr.TimeUnixNano))
	} else if lr.ObservedTimeUnixNano > 0 {
		ts = time.Unix(0, int64(lr.ObservedTimeUnixNano))
	}

	// Determine level
	level := otlpSeverityToLevel(lr.SeverityText, int(lr.SeverityNumber))

	// Extract message from body
	message := otlpAnyValueToString(lr.Body)

	// Build properties from attributes
	props := attributesToMap(lr.Attributes)
	propsJSON := "{}"
	if len(props) > 0 {
		b, err := json.Marshal(props)
		if err == nil {
			propsJSON = string(b)
		}
	}

	return LogEvent{
		Timestamp:       ts,
		Level:           level,
		MessageTemplate: "",
		Message:         message,
		Exception:       "",
		EventType:       computeEventType("", message),
		Source:          source,
		Properties:      propsJSON,
	}
}

// handleOTLPTraces handles POST /v1/traces for OTLP trace ingestion.
func (s *Server) handleOTLPTraces(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract and validate API key
	apiKey := extractOTLPAPIKey(r)
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

	// Read body with gzip support
	body, err := readBody(r)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"Error": fmt.Sprintf("Failed to read body: %v", err)})
		return
	}

	// Parse the export request
	var exportReq coltracepb.ExportTraceServiceRequest
	ct := r.Header.Get("Content-Type")
	if ct == "application/x-protobuf" || ct == "application/proto" {
		if err := proto.Unmarshal(body, &exportReq); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"Error": fmt.Sprintf("Failed to parse protobuf: %v", err)})
			return
		}
	} else {
		// Use protojson for correct proto3 JSON mapping (handles string-encoded uint64, etc.)
		if err := protojson.Unmarshal(body, &exportReq); err != nil {
			// Fallback to protobuf binary in case content-type is wrong
			if err2 := proto.Unmarshal(body, &exportReq); err2 != nil {
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(map[string]string{"Error": fmt.Sprintf("Failed to parse body as JSON or protobuf: json=%v, proto=%v", err, err2)})
				return
			}
		}
	}

	// Convert OTLP spans to LogEvents
	events := make([]LogEvent, 0)
	for _, rs := range exportReq.ResourceSpans {
		serviceName := ""
		if rs.Resource != nil {
			serviceName = getResourceServiceName(rs.Resource.Attributes)
		}
		eventSource := source
		if serviceName != "" {
			eventSource = serviceName
		}

		for _, ss := range rs.ScopeSpans {
			for _, span := range ss.Spans {
				event := convertOTLPSpan(span, eventSource)
				events = append(events, event)
			}
		}
	}

	if len(events) > 0 {
		s.addEventsToBatch(events)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"partialSuccess": map[string]interface{}{
			"rejectedSpans": 0,
			"errorMessage":  "",
		},
	})
}

// convertOTLPSpan converts a single OTLP Span to a LogEvent.
func convertOTLPSpan(span *tracepb.Span, source string) LogEvent {
	// Timestamp from startTimeUnixNano
	ts := time.Now()
	if span.StartTimeUnixNano > 0 {
		ts = time.Unix(0, int64(span.StartTimeUnixNano))
	}

	// Level based on status code: 2 = ERROR
	level := "Information"
	if span.Status != nil && span.Status.Code == tracepb.Status_STATUS_CODE_ERROR {
		level = "Error"
	}

	// Span kind
	kind := spanKindToString(int(span.Kind))

	// Status string
	statusStr := "OK"
	if span.Status != nil {
		switch span.Status.Code {
		case tracepb.Status_STATUS_CODE_ERROR:
			statusStr = "ERROR"
		case tracepb.Status_STATUS_CODE_OK:
			statusStr = "OK"
		default:
			statusStr = "UNSET"
		}
		if span.Status.Message != "" {
			statusStr = statusStr + ": " + span.Status.Message
		}
	}

	// Message
	message := fmt.Sprintf("%s [%s] %s", span.Name, kind, statusStr)

	// Build properties
	props := attributesToMap(span.Attributes)
	props["traceId"] = hex.EncodeToString(span.TraceId)
	props["spanId"] = hex.EncodeToString(span.SpanId)
	if len(span.ParentSpanId) > 0 {
		props["parentSpanId"] = hex.EncodeToString(span.ParentSpanId)
	}

	// Calculate duration in milliseconds
	if span.StartTimeUnixNano > 0 && span.EndTimeUnixNano > 0 {
		durationNs := span.EndTimeUnixNano - span.StartTimeUnixNano
		props["durationMs"] = float64(durationNs) / 1e6
	}

	propsJSON := "{}"
	if len(props) > 0 {
		b, err := json.Marshal(props)
		if err == nil {
			propsJSON = string(b)
		}
	}

	messageTemplate := "{Name} [{Kind}] {Status}"

	return LogEvent{
		Timestamp:       ts,
		Level:           level,
		MessageTemplate: messageTemplate,
		Message:         message,
		Exception:       "",
		EventType:       computeEventType(messageTemplate, message),
		Source:          source,
		Properties:      propsJSON,
	}
}

// Ensure proto types are used (prevent unused import errors).
var (
	_ = (*logspb.LogRecord)(nil)
	_ = (*tracepb.Span)(nil)
)
