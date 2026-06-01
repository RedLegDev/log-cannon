package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// RetentionPolicy is a per-service retention rule, sourced from logs.api_keys.
// Source is the API key's name (which becomes logs.events.source); RetentionDays
// is how many days of logs to keep (always > 0 here — 0 means keep forever and is
// filtered out by the query).
type RetentionPolicy struct {
	Source        string
	RetentionDays uint32
}

func main() {
	host := getEnv("CLICKHOUSE_HOST", "clickhouse")
	port := getEnv("CLICKHOUSE_PORT", "9000")
	database := getEnv("CLICKHOUSE_DATABASE", "logs")
	user := getEnv("CLICKHOUSE_USER", "default")
	password := getEnv("CLICKHOUSE_PASSWORD", "")

	intervalHours := 24
	if v := os.Getenv("RETENTION_INTERVAL_HOURS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			intervalHours = n
		} else {
			log.Printf("Invalid RETENTION_INTERVAL_HOURS=%q, defaulting to 24", v)
		}
	}
	interval := time.Duration(intervalHours) * time.Hour

	// Connect to ClickHouse (same retry/ping loop as alert-worker)
	var conn driver.Conn
	var err error
	for i := 0; i < 30; i++ {
		conn, err = clickhouse.Open(&clickhouse.Options{
			Addr: []string{fmt.Sprintf("%s:%s", host, port)},
			Auth: clickhouse.Auth{
				Database: database,
				Username: user,
				Password: password,
			},
			Settings: clickhouse.Settings{
				"max_execution_time": 300,
			},
			DialTimeout:     10 * time.Second,
			MaxOpenConns:    5,
			MaxIdleConns:    2,
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

	log.Printf("Connected to ClickHouse, starting retention worker (interval: %dh)...", intervalHours)

	// Run a pass on startup, then on a fixed interval.
	for {
		runRetentionPass(conn)
		time.Sleep(interval)
	}
}

func runRetentionPass(conn driver.Conn) {
	policies, err := fetchPolicies(conn)
	if err != nil {
		log.Printf("Error fetching retention policies: %v", err)
		return
	}

	if len(policies) == 0 {
		log.Println("Retention pass: no services with retention configured, nothing to trim")
		return
	}

	log.Printf("Retention pass: %d service(s) with retention configured", len(policies))

	for _, p := range policies {
		trimSource(conn, p)
	}
}

func fetchPolicies(conn driver.Conn) ([]RetentionPolicy, error) {
	// Only enabled keys with a positive retention window. retention_days = 0 means
	// keep forever and is excluded here.
	query := `
		SELECT name, retention_days
		FROM logs.api_keys
		WHERE enabled = 1 AND retention_days > 0
	`

	rows, err := conn.Query(context.Background(), query)
	if err != nil {
		return nil, fmt.Errorf("failed to query api_keys: %w", err)
	}
	defer rows.Close()

	var policies []RetentionPolicy
	for rows.Next() {
		var p RetentionPolicy
		if err := rows.Scan(&p.Source, &p.RetentionDays); err != nil {
			return nil, fmt.Errorf("failed to scan policy row: %w", err)
		}
		policies = append(policies, p)
	}
	return policies, nil
}

func trimSource(conn driver.Conn, p RetentionPolicy) {
	source := escapeString(p.Source)
	cutoff := fmt.Sprintf("now() - INTERVAL %d DAY", p.RetentionDays)

	// Count first so the audit log records what's being trimmed.
	countQuery := fmt.Sprintf(
		"SELECT count() AS cnt FROM logs.events WHERE source = '%s' AND timestamp < %s",
		source, cutoff,
	)
	var cnt uint64
	if err := conn.QueryRow(context.Background(), countQuery).Scan(&cnt); err != nil {
		log.Printf("[%s] Failed to count expired rows: %v", p.Source, err)
		return
	}

	if cnt == 0 {
		log.Printf("[%s] Up to date (retention %d days), nothing to trim", p.Source, p.RetentionDays)
		return
	}

	// ALTER ... DELETE is an async mutation in ClickHouse. We issue it and let
	// ClickHouse finalize it in the background; the next pass will see it gone.
	deleteQuery := fmt.Sprintf(
		"ALTER TABLE logs.events DELETE WHERE source = '%s' AND timestamp < %s",
		source, cutoff,
	)
	if err := conn.Exec(context.Background(), deleteQuery); err != nil {
		log.Printf("[%s] Failed to trim (retention %d days): %v", p.Source, p.RetentionDays, err)
		return
	}

	log.Printf("[%s] Trimming ~%d row(s) older than %d days", p.Source, cnt, p.RetentionDays)
}

// escapeString mirrors the dashboard's ClickHouse string escaping (single quote -> '').
func escapeString(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}
