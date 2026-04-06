package main

import "time"

// LogEvent mirrors the existing ingest-api LogEvent struct.
type LogEvent struct {
	Timestamp       time.Time
	Level           string
	MessageTemplate string
	Message         string
	Exception       string
	EventType       string
	Source          string
	Properties      string
}
