package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Project is one Supabase project to pull. Source becomes both the
// logs.events.source column and the Source property — the property is what
// the existing alerts filter on.
type Project struct {
	Ref    string
	Source string
}

type Config struct {
	Projects []Project
	Tables   []string

	// Interval between runs. The run itself pages until caught up, so this
	// bounds lag, not throughput.
	Interval time.Duration
	// Overlap re-reads this much before the watermark each run, so a row
	// Supabase lands late is still picked up. Rows already stored are skipped
	// by sb_id.
	Overlap time.Duration
	// MaxLookback floors how far back a run reaches, including after an
	// outage. Keep it within the plan's Supabase log retention.
	MaxLookback time.Duration

	PageSize int
	// MaxPagesPerTable bounds one run's work per table; a longer backlog
	// continues on the next run from the new watermark.
	MaxPagesPerTable int
}

var defaultTables = []string{"postgres_logs", "auth_logs", "function_logs", "function_edge_logs"}

func loadConfig() (Config, error) {
	cfg := Config{
		Tables:           defaultTables,
		Interval:         time.Minute,
		Overlap:          5 * time.Minute,
		MaxLookback:      72 * time.Hour,
		PageSize:         500,
		MaxPagesPerTable: 50,
	}

	var err error
	if cfg.Projects, err = parseProjects(os.Getenv("SUPABASE_PULL_PROJECTS")); err != nil {
		return cfg, err
	}
	if v := os.Getenv("SUPABASE_PULL_TABLES"); v != "" {
		cfg.Tables = splitList(v)
	}
	for _, d := range []struct {
		env string
		dst *time.Duration
	}{
		{"SUPABASE_PULL_INTERVAL", &cfg.Interval},
		{"SUPABASE_PULL_OVERLAP", &cfg.Overlap},
		{"SUPABASE_PULL_MAX_LOOKBACK", &cfg.MaxLookback},
	} {
		if v := os.Getenv(d.env); v != "" {
			parsed, err := time.ParseDuration(v)
			if err != nil || parsed < 0 {
				return cfg, fmt.Errorf("invalid %s=%q", d.env, v)
			}
			*d.dst = parsed
		}
	}
	if v := os.Getenv("SUPABASE_PULL_MAX_PAGES"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return cfg, fmt.Errorf("invalid SUPABASE_PULL_MAX_PAGES=%q", v)
		}
		cfg.MaxPagesPerTable = n
	}
	if cfg.Interval <= 0 {
		return cfg, fmt.Errorf("SUPABASE_PULL_INTERVAL must be positive")
	}
	return cfg, nil
}

// parseProjects reads "ref=source,ref=source". Empty means no projects are
// enabled, which is how the worker is first deployed.
func parseProjects(s string) ([]Project, error) {
	var out []Project
	seen := map[string]bool{}
	for _, item := range splitList(s) {
		ref, source, ok := strings.Cut(item, "=")
		ref, source = strings.TrimSpace(ref), strings.TrimSpace(source)
		if !ok || ref == "" || source == "" {
			return nil, fmt.Errorf("invalid SUPABASE_PULL_PROJECTS entry %q (want ref=source)", item)
		}
		if seen[ref] {
			return nil, fmt.Errorf("duplicate project ref %q in SUPABASE_PULL_PROJECTS", ref)
		}
		seen[ref] = true
		out = append(out, Project{Ref: ref, Source: source})
	}
	return out, nil
}

func splitList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}
