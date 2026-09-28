package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/twmb/murmur3"
)

// Event is one logs.events row, in the column order of insertColumns.
type Event struct {
	Row
	Level      string
	EventType  string
	Source     string
	Properties string
}

// toEvent maps a Supabase row onto the row the retired Python poller produced
// via CLEF, so every alert and saved query keyed on the Source, LogTable,
// ProjectRef and sb_* properties keeps matching. The one addition is sb_id,
// which is what makes a restart or overlap idempotent.
func toEvent(p Project, table string, r Row) Event {
	props := map[string]any{}
	for k, v := range r.Attributes {
		if v == nil || v == "" {
			continue
		}
		props[propertyName(k)] = v
	}
	// Set after the attributes so nothing in them can shadow the fields the
	// alerts and dedupe depend on.
	props["Source"] = p.Source
	props["LogTable"] = table
	props["ProjectRef"] = p.Ref
	props["sb_id"] = r.ID

	b, _ := json.Marshal(props)
	return Event{
		Row:        r,
		Level:      mapLevel(r.Severity),
		EventType:  eventType(r.Message),
		Source:     p.Source,
		Properties: string(b),
	}
}

var levels = map[string]string{
	"fatal": "Fatal", "panic": "Fatal", "critical": "Fatal", "crit": "Fatal",
	"error": "Error", "err": "Error",
	"warning": "Warning", "warn": "Warning",
	"info": "Information", "log": "Information", "notice": "Information",
	"debug": "Debug", "trace": "Verbose",
}

func mapLevel(severity string) string {
	if l, ok := levels[strings.ToLower(severity)]; ok {
		return l
	}
	return "Information"
}

var nonPropertyChar = regexp.MustCompile(`[^0-9A-Za-z_]`)

// propertyName flattens a dotted attribute path (request.path) into a Serilog
// property name (sb_request_path).
func propertyName(key string) string {
	return "sb_" + strings.Trim(nonPropertyChar.ReplaceAllString(key, "_"), "_")
}

// eventType matches queue-consumer's computeEventType for a message with no
// template, so these rows group exactly as the CLEF-ingested ones did.
func eventType(message string) string {
	if message == "" {
		return ""
	}
	return fmt.Sprintf("0x%08x", murmur3.Sum32([]byte(message)))
}
