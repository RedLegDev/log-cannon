package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
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

// parseOTLPLogs parses an OTel logs export request (protobuf or JSON).
func parseOTLPLogs(body []byte, source string, contentType string) ([]LogEvent, error) {
	var exportReq collogspb.ExportLogsServiceRequest

	if contentType == "application/x-protobuf" || contentType == "application/proto" {
		if err := proto.Unmarshal(body, &exportReq); err != nil {
			return nil, fmt.Errorf("protobuf: %w", err)
		}
	} else {
		if err := protojson.Unmarshal(body, &exportReq); err != nil {
			if err2 := proto.Unmarshal(body, &exportReq); err2 != nil {
				return nil, fmt.Errorf("json=%w, proto=%v", err, err2)
			}
		}
	}

	var events []LogEvent
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
				events = append(events, convertOTLPLogRecord(lr, eventSource))
			}
		}
	}

	return events, nil
}

// parseOTLPTraces parses an OTel traces export request (protobuf or JSON).
func parseOTLPTraces(body []byte, source string, contentType string) ([]LogEvent, error) {
	var exportReq coltracepb.ExportTraceServiceRequest

	if contentType == "application/x-protobuf" || contentType == "application/proto" {
		if err := proto.Unmarshal(body, &exportReq); err != nil {
			return nil, fmt.Errorf("protobuf: %w", err)
		}
	} else {
		if err := protojson.Unmarshal(body, &exportReq); err != nil {
			if err2 := proto.Unmarshal(body, &exportReq); err2 != nil {
				return nil, fmt.Errorf("json=%w, proto=%v", err, err2)
			}
		}
	}

	var events []LogEvent
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
				events = append(events, convertOTLPSpan(span, eventSource))
			}
		}
	}

	return events, nil
}

func otlpSeverityToLevel(severityText string, severityNumber int) string {
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

func attributesToMap(attrs []*commonpb.KeyValue) map[string]interface{} {
	m := make(map[string]interface{})
	for _, kv := range attrs {
		m[kv.Key] = otlpAnyValueToInterface(kv.Value)
	}
	return m
}

func getResourceServiceName(attrs []*commonpb.KeyValue) string {
	for _, kv := range attrs {
		if kv.Key == "service.name" {
			return otlpAnyValueToString(kv.Value)
		}
	}
	return ""
}

func convertOTLPLogRecord(lr *logspb.LogRecord, source string) LogEvent {
	ts := time.Now()
	if lr.TimeUnixNano > 0 {
		ts = time.Unix(0, int64(lr.TimeUnixNano))
	} else if lr.ObservedTimeUnixNano > 0 {
		ts = time.Unix(0, int64(lr.ObservedTimeUnixNano))
	}

	level := otlpSeverityToLevel(lr.SeverityText, int(lr.SeverityNumber))
	message := otlpAnyValueToString(lr.Body)

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

func convertOTLPSpan(span *tracepb.Span, source string) LogEvent {
	ts := time.Now()
	if span.StartTimeUnixNano > 0 {
		ts = time.Unix(0, int64(span.StartTimeUnixNano))
	}

	level := "Information"
	if span.Status != nil && span.Status.Code == tracepb.Status_STATUS_CODE_ERROR {
		level = "Error"
	}

	kind := spanKindToString(int(span.Kind))

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

	message := fmt.Sprintf("%s [%s] %s", span.Name, kind, statusStr)

	props := attributesToMap(span.Attributes)
	props["traceId"] = hex.EncodeToString(span.TraceId)
	props["spanId"] = hex.EncodeToString(span.SpanId)
	if len(span.ParentSpanId) > 0 {
		props["parentSpanId"] = hex.EncodeToString(span.ParentSpanId)
	}

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

// Ensure proto types are used.
var (
	_ = (*logspb.LogRecord)(nil)
	_ = (*tracepb.Span)(nil)
)
