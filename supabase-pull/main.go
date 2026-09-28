// supabase-pull pulls Supabase platform logs (postgres, auth, edge functions)
// from the Management API's unified logs endpoint and writes them straight to
// logs.events. It replaces the host-crontab supabase-log-poller, keeping the
// property names that poller produced (refs #132).
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/logaggregator/ship"
)

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Deployed with no projects first, so the host poller can be switched off
	// before this one starts: running both double-ingests.
	if len(cfg.Projects) == 0 {
		log.Println("No projects enabled (SUPABASE_PULL_PROJECTS is empty); idling")
		<-ctx.Done()
		return
	}
	token := os.Getenv("SUPABASE_ACCESS_TOKEN")
	if token == "" {
		log.Fatalf("SUPABASE_ACCESS_TOKEN is required when SUPABASE_PULL_PROJECTS is set")
	}

	// Optional CLEF shipping of the per-run summary, as source supabase-pull
	// (the key's name). Not a tee of log.Printf: the summary is the event.
	shipper := ship.FromEnv()
	defer shipper.Close()

	conn, err := connectClickHouse()
	if err != nil {
		log.Fatalf("Failed to connect to ClickHouse: %v", err)
	}

	api := newSupabaseAPI(getEnv("SUPABASE_API_URL", "https://api.supabase.com"), token)
	puller := NewPuller(api, &clickhouseStore{conn: conn}, cfg)

	log.Printf("supabase-pull: %d project(s), tables %v, every %s (overlap %s, max lookback %s)",
		len(cfg.Projects), cfg.Tables, cfg.Interval, cfg.Overlap, cfg.MaxLookback)

	for {
		started := time.Now()
		results := puller.Run(ctx)
		if ctx.Err() != nil {
			return
		}
		report(shipper, results, time.Since(started))

		select {
		case <-ctx.Done():
			return
		case <-time.After(cfg.Interval):
		}
	}
}

// report writes one line per table to stdout and ships one summary event per
// run. Any failed table raises the event to Error, so an alert on
// source = 'supabase-pull' AND level = 'Error' catches API and auth failures.
func report(shipper *ship.Client, results []TableResult, took time.Duration) {
	var inserted, pages, failed int
	var authFailed, behind bool
	var maxAge float64
	for _, r := range results {
		inserted += r.Inserted
		pages += r.Pages
		maxAge = max(maxAge, r.WatermarkAgeSeconds)
		behind = behind || r.Behind
		if r.Error != "" {
			failed++
			authFailed = authFailed || r.AuthFailed
			log.Printf("[%s/%s] ERROR after %d page(s): %s", r.Project, r.Table, r.Pages, r.Error)
			continue
		}
		log.Printf("[%s/%s] fetched=%d inserted=%d skipped=%d pages=%d watermark_age=%.0fs%s",
			r.Project, r.Table, r.Fetched, r.Inserted, r.Skipped, r.Pages, r.WatermarkAgeSeconds, behindNote(r.Behind))
	}

	level, template := "Information",
		"supabase-pull inserted {Inserted} rows in {Pages} pages; oldest watermark {MaxWatermarkAgeSeconds}s"
	if failed > 0 {
		level, template = "Error",
			"supabase-pull: {Failed} of {TableCount} tables failed; inserted {Inserted} rows"
		if authFailed {
			template = "supabase-pull: Supabase rejected the access token; {Failed} of {TableCount} tables failed"
		}
	}
	shipper.Emit(ship.Event{
		Level:    level,
		Template: template,
		Props: map[string]any{
			"Inserted":               inserted,
			"Pages":                  pages,
			"Failed":                 failed,
			"TableCount":             len(results),
			"AuthFailed":             authFailed,
			"Behind":                 behind,
			"MaxWatermarkAgeSeconds": int(maxAge),
			"DurationMs":             took.Milliseconds(),
			"Tables":                 results,
		},
	})
}

func behindNote(b bool) string {
	if b {
		return " (page cap reached, continuing next run)"
	}
	return ""
}

// connectClickHouse uses the same retry/ping loop as retention-worker.
func connectClickHouse() (driver.Conn, error) {
	host := getEnv("CLICKHOUSE_HOST", "clickhouse")
	port := getEnv("CLICKHOUSE_PORT", "9000")
	var conn driver.Conn
	var err error
	for i := 0; i < 30; i++ {
		conn, err = clickhouse.Open(&clickhouse.Options{
			Addr: []string{fmt.Sprintf("%s:%s", host, port)},
			Auth: clickhouse.Auth{
				Database: getEnv("CLICKHOUSE_DATABASE", "logs"),
				Username: getEnv("CLICKHOUSE_USER", "default"),
				Password: getEnv("CLICKHOUSE_PASSWORD", ""),
			},
			Settings:        clickhouse.Settings{"max_execution_time": 120},
			DialTimeout:     10 * time.Second,
			MaxOpenConns:    4,
			MaxIdleConns:    2,
			ConnMaxLifetime: time.Hour,
		})
		if err == nil {
			if err = conn.Ping(context.Background()); err == nil {
				return conn, nil
			}
		}
		log.Printf("Waiting for ClickHouse... (%d/30): %v", i+1, err)
		time.Sleep(2 * time.Second)
	}
	return nil, errors.Join(errors.New("gave up after 30 attempts"), err)
}
