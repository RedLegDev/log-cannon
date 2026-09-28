package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// Seen is what logs.events already holds at the start of a pull window.
type Seen struct {
	IDs map[string]bool
	// Legacy holds rows written before sb_id existed (the Python poller),
	// keyed by millisecond timestamp and message. It only matters for the
	// first run after cutover, whose overlap window reaches into those rows.
	Legacy map[string]bool
}

func (s Seen) Has(e Event) bool {
	return s.IDs[e.ID] || s.Legacy[legacyKey(e.Timestamp, e.Message)]
}

func legacyKey(ts time.Time, message string) string {
	return fmt.Sprintf("%d|%s", ts.UnixMilli(), message)
}

type Store interface {
	// Watermarks returns max(timestamp) per LogTable for rows whose Source
	// property is source, looking back to since.
	Watermarks(ctx context.Context, source string, since time.Time) (map[string]time.Time, error)
	Seen(ctx context.Context, source, table string, since time.Time) (Seen, error)
	Insert(ctx context.Context, events []Event) error
}

type clickhouseStore struct {
	conn driver.Conn
}

// Both reads filter on the Source *property*, not the source column: the rows
// the Python poller wrote carry the ingesting key's name (Wagner-Server) in
// the column, and the watermark has to resume from them at cutover.

func (s *clickhouseStore) Watermarks(ctx context.Context, source string, since time.Time) (map[string]time.Time, error) {
	q := fmt.Sprintf(`
		SELECT JSONExtractString(properties, 'LogTable') AS log_table, max(timestamp)
		FROM logs.events
		WHERE timestamp >= %s AND JSONExtractString(properties, 'Source') = '%s'
		GROUP BY log_table`, chTime(since), chEscape(source))
	rows, err := s.conn.Query(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("watermark query: %w", err)
	}
	defer rows.Close()
	out := map[string]time.Time{}
	for rows.Next() {
		var table string
		var ts time.Time
		if err := rows.Scan(&table, &ts); err != nil {
			return nil, fmt.Errorf("watermark scan: %w", err)
		}
		out[table] = ts.UTC()
	}
	return out, rows.Err()
}

func (s *clickhouseStore) Seen(ctx context.Context, source, table string, since time.Time) (Seen, error) {
	q := fmt.Sprintf(`
		SELECT JSONExtractString(properties, 'sb_id'), timestamp, message
		FROM logs.events
		WHERE timestamp >= %s
		  AND JSONExtractString(properties, 'Source') = '%s'
		  AND JSONExtractString(properties, 'LogTable') = '%s'`,
		chTime(since), chEscape(source), chEscape(table))
	rows, err := s.conn.Query(ctx, q)
	if err != nil {
		return Seen{}, fmt.Errorf("seen query: %w", err)
	}
	defer rows.Close()
	seen := Seen{IDs: map[string]bool{}, Legacy: map[string]bool{}}
	for rows.Next() {
		var id, message string
		var ts time.Time
		if err := rows.Scan(&id, &ts, &message); err != nil {
			return Seen{}, fmt.Errorf("seen scan: %w", err)
		}
		if id != "" {
			seen.IDs[id] = true
		} else {
			seen.Legacy[legacyKey(ts, message)] = true
		}
	}
	return seen, rows.Err()
}

// Insert is the third writer of logs.events (after queue-consumer and the
// dashboard's insertLogEvent), and like them it stamps inserted_at — see
// clickhouse/init/010_events_inserted_at.sql.
func (s *clickhouseStore) Insert(ctx context.Context, events []Event) error {
	batch, err := s.conn.PrepareBatch(ctx,
		"INSERT INTO logs.events (timestamp, level, message_template, message, exception, event_type, source, properties, inserted_at)")
	if err != nil {
		return err
	}
	now := time.Now()
	for _, e := range events {
		if err := batch.Append(e.Timestamp, e.Level, "", e.Message, "", e.EventType, e.Source, e.Properties, now); err != nil {
			_ = batch.Abort()
			return fmt.Errorf("append: %w", err)
		}
	}
	return batch.Send()
}

func chTime(t time.Time) string {
	return "toDateTime64('" + t.UTC().Format("2006-01-02 15:04:05.000") + "', 3, 'UTC')"
}

// chEscape doubles single quotes, as retention-worker and the dashboard do.
func chEscape(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}
