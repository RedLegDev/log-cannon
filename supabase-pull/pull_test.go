package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"testing"
	"time"
)

var (
	t0      = time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	project = Project{Ref: "refabc", Source: "app-supabase"}
)

// fakeAPI serves rows with the endpoint's semantics: the iso window is
// second-granular and inclusive, the SQL keyset is exact.
type fakeAPI struct {
	rows    map[string][]Row // table -> rows
	windows []time.Duration
	err     error
	calls   int
}

func (f *fakeAPI) add(table string, rows ...Row) {
	if f.rows == nil {
		f.rows = map[string][]Row{}
	}
	f.rows[table] = append(f.rows[table], rows...)
	sort.Slice(f.rows[table], func(i, j int) bool { return less(f.rows[table][i], f.rows[table][j]) })
}

func less(a, b Row) bool {
	if !a.Timestamp.Equal(b.Timestamp) {
		return a.Timestamp.Before(b.Timestamp)
	}
	return a.ID < b.ID
}

func (f *fakeAPI) Query(_ context.Context, ref, table string, cur Cursor, from, to time.Time, limit int) ([]Row, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	if ref != project.Ref {
		return nil, fmt.Errorf("unexpected ref %q", ref)
	}
	f.windows = append(f.windows, to.Sub(from))
	lo := from.Truncate(time.Second)
	hi := to.Add(time.Second - 1).Truncate(time.Second)
	var out []Row
	for _, r := range f.rows[table] {
		if r.Timestamp.Before(lo) || r.Timestamp.After(hi) {
			continue
		}
		if cur.ID == "" {
			if r.Timestamp.Before(cur.Timestamp) {
				continue
			}
		} else if !less(Row{Timestamp: cur.Timestamp, ID: cur.ID}, r) {
			continue
		}
		out = append(out, r)
		if len(out) == limit {
			break
		}
	}
	return out, nil
}

// fakeStore keeps rows as ClickHouse would: millisecond timestamps, and a
// properties JSON string the reads extract from.
type fakeStore struct {
	rows []storedRow
}

type storedRow struct {
	source     string // the column
	ts         time.Time
	message    string
	properties map[string]any
}

func (s *fakeStore) Watermarks(_ context.Context, source string, since time.Time) (map[string]time.Time, error) {
	out := map[string]time.Time{}
	for _, r := range s.rows {
		if r.properties["Source"] != source || r.ts.Before(since.Truncate(time.Millisecond)) {
			continue
		}
		t := r.properties["LogTable"].(string)
		if r.ts.After(out[t]) {
			out[t] = r.ts
		}
	}
	return out, nil
}

func (s *fakeStore) Seen(_ context.Context, source, table string, since time.Time) (Seen, error) {
	seen := Seen{IDs: map[string]bool{}, Legacy: map[string]bool{}}
	for _, r := range s.rows {
		if r.properties["Source"] != source || r.properties["LogTable"] != table || r.ts.Before(since.Truncate(time.Millisecond)) {
			continue
		}
		if id, _ := r.properties["sb_id"].(string); id != "" {
			seen.IDs[id] = true
		} else {
			seen.Legacy[legacyKey(r.ts, r.message)] = true
		}
	}
	return seen, nil
}

func (s *fakeStore) Insert(_ context.Context, events []Event) error {
	for _, e := range events {
		var props map[string]any
		if err := json.Unmarshal([]byte(e.Properties), &props); err != nil {
			return err
		}
		s.rows = append(s.rows, storedRow{source: e.Source, ts: e.Timestamp.Truncate(time.Millisecond), message: e.Message, properties: props})
	}
	return nil
}

func (s *fakeStore) countByID() map[string]int {
	out := map[string]int{}
	for _, r := range s.rows {
		if id, _ := r.properties["sb_id"].(string); id != "" {
			out[id]++
		}
	}
	return out
}

func testConfig() Config {
	return Config{
		Projects:         []Project{project},
		Tables:           []string{"auth_logs"},
		Overlap:          5 * time.Minute,
		MaxLookback:      72 * time.Hour,
		PageSize:         500,
		MaxPagesPerTable: 50,
	}
}

func newTestPuller(api LogAPI, store Store, cfg Config, now time.Time) *Puller {
	p := NewPuller(api, store, cfg)
	p.now = func() time.Time { return now }
	return p
}

// rowsEvery makes n rows starting at start, step apart, with ids prefix-NNNNN.
func rowsEvery(prefix string, start time.Time, step time.Duration, n int) []Row {
	out := make([]Row, n)
	for i := range out {
		out[i] = Row{
			ID:        fmt.Sprintf("%s-%05d", prefix, i),
			Timestamp: start.Add(time.Duration(i) * step),
			Message:   fmt.Sprintf("%s event %d", prefix, i),
			Severity:  "info",
		}
	}
	return out
}

func assertEachIDOnce(t *testing.T, store *fakeStore, want int) {
	t.Helper()
	counts := store.countByID()
	if len(counts) != want {
		t.Fatalf("stored %d distinct sb_ids, want %d", len(counts), want)
	}
	for id, c := range counts {
		if c != 1 {
			t.Fatalf("sb_id %s stored %d times", id, c)
		}
	}
}

func TestPagesThroughEqualTimestampsAcrossPageBoundaries(t *testing.T) {
	// auth_logs stamps whole seconds: 1203 rows over ~2 minutes means every
	// page boundary lands inside a run of equal timestamps.
	api := &fakeAPI{}
	api.add("auth_logs", rowsEvery("a", t0.Add(-10*time.Minute), 100*time.Millisecond, 1203)...)
	for i := range api.rows["auth_logs"] {
		api.rows["auth_logs"][i].Timestamp = api.rows["auth_logs"][i].Timestamp.Truncate(time.Second)
	}
	store := &fakeStore{}
	cfg := testConfig()
	cfg.MaxLookback = 15 * time.Minute // one window, so pages count only full pages

	res := newTestPuller(api, store, cfg, t0).Run(context.Background())

	if res[0].Error != "" {
		t.Fatal(res[0].Error)
	}
	if res[0].Pages != 3 || res[0].Inserted != 1203 {
		t.Fatalf("pages=%d inserted=%d, want 3 pages and 1203 rows", res[0].Pages, res[0].Inserted)
	}
	assertEachIDOnce(t, store, 1203)
}

func TestRestartAfterStopHasNoGapAndNoDuplicates(t *testing.T) {
	api := &fakeAPI{}
	store := &fakeStore{}
	cfg := testConfig()

	// Run 1 at t0 stores the first hour.
	api.add("auth_logs", rowsEvery("before", t0.Add(-time.Hour), 7*time.Second, 500)...)
	newTestPuller(api, store, cfg, t0).Run(context.Background())

	// Stopped for 30 minutes; Supabase kept logging, and a row that landed
	// late (stamped before the watermark, inside the overlap) arrived too.
	api.add("auth_logs", rowsEvery("during", t0.Add(time.Second), 3*time.Second, 600)...)
	api.add("auth_logs", Row{ID: "late", Timestamp: t0.Add(-2 * time.Minute), Message: "late arrival"})

	// A fresh process has no memory: it re-derives the watermark.
	res := newTestPuller(api, store, cfg, t0.Add(30*time.Minute+time.Minute)).Run(context.Background())

	if res[0].Error != "" {
		t.Fatal(res[0].Error)
	}
	if res[0].Inserted != 601 {
		t.Fatalf("inserted %d after restart, want 600 new + 1 late", res[0].Inserted)
	}
	assertEachIDOnce(t, store, 500+600+1)
}

func TestCutoverResumesFromPollerRowsByTheSourceProperty(t *testing.T) {
	// The Python poller's rows: source column is the ingesting key's name,
	// no sb_id. Seconds-precision auth timestamps, like production.
	store := &fakeStore{}
	legacy := rowsEvery("legacy", t0.Add(-20*time.Minute), time.Second, 20*60)
	for _, r := range legacy {
		store.rows = append(store.rows, storedRow{
			source: "Wagner-Server", ts: r.Timestamp, message: r.Message,
			properties: map[string]any{"Source": project.Source, "LogTable": "auth_logs", "ProjectRef": project.Ref},
		})
	}

	api := &fakeAPI{}
	api.add("auth_logs", legacy...)
	api.add("auth_logs", rowsEvery("new", t0.Add(time.Second), time.Second, 90)...)

	res := newTestPuller(api, store, testConfig(), t0.Add(2*time.Minute)).Run(context.Background())

	if res[0].Error != "" {
		t.Fatal(res[0].Error)
	}
	if res[0].Inserted != 90 {
		t.Fatalf("inserted %d, want only the 90 rows after the poller's watermark", res[0].Inserted)
	}
	if res[0].Skipped == 0 {
		t.Fatal("the overlap window should have re-read and skipped poller rows")
	}
	for _, r := range store.rows[len(legacy):] {
		if r.source != project.Source {
			t.Fatalf("new row source column = %q, want %q", r.source, project.Source)
		}
	}
}

func TestCatchUpWalksWindowsUnderTheAPICap(t *testing.T) {
	// A 50-hour outage: the watermark is 50h old, rows are sparse.
	store := &fakeStore{}
	wm := t0.Add(-50 * time.Hour)
	store.rows = append(store.rows, storedRow{source: project.Source, ts: wm, message: "old",
		properties: map[string]any{"Source": project.Source, "LogTable": "auth_logs", "sb_id": "old"}})

	api := &fakeAPI{}
	api.add("auth_logs", rowsEvery("gap", wm.Add(time.Minute), 10*time.Minute, 300)...)

	res := newTestPuller(api, store, testConfig(), t0).Run(context.Background())

	if res[0].Error != "" {
		t.Fatal(res[0].Error)
	}
	if res[0].Inserted != 300 {
		t.Fatalf("inserted %d, want all 300 rows of the outage", res[0].Inserted)
	}
	for _, w := range api.windows {
		if w > 24*time.Hour {
			t.Fatalf("queried a %s window; the endpoint caps at 24h", w)
		}
	}
}

func TestEmptyTableStartsAtTheLookbackFloor(t *testing.T) {
	cfg := testConfig()
	cfg.MaxLookback = 30 * time.Hour
	api := &fakeAPI{}
	api.add("auth_logs", Row{ID: "too-old", Timestamp: t0.Add(-31 * time.Hour), Message: "x"})
	api.add("auth_logs", Row{ID: "in-range", Timestamp: t0.Add(-29 * time.Hour), Message: "y"})
	store := &fakeStore{}

	res := newTestPuller(api, store, cfg, t0).Run(context.Background())

	if res[0].Inserted != 1 || store.rows[0].properties["sb_id"] != "in-range" {
		t.Fatalf("inserted %d rows (%v), want only the row inside the 30h floor", res[0].Inserted, store.rows)
	}
}

func TestPageCapStopsAndTheNextRunContinues(t *testing.T) {
	cfg := testConfig()
	cfg.MaxPagesPerTable = 2
	cfg.MaxLookback = 2 * time.Hour
	api := &fakeAPI{}
	api.add("auth_logs", rowsEvery("b", t0.Add(-time.Hour), time.Second, 1400)...)
	store := &fakeStore{}
	p := newTestPuller(api, store, cfg, t0)

	first := p.Run(context.Background())
	if !first[0].Behind || first[0].Inserted != 1000 {
		t.Fatalf("first run: behind=%v inserted=%d, want behind with 1000", first[0].Behind, first[0].Inserted)
	}
	second := p.Run(context.Background())
	if second[0].Behind || second[0].Inserted != 400 {
		t.Fatalf("second run: behind=%v inserted=%d, want caught up with 400", second[0].Behind, second[0].Inserted)
	}
	assertEachIDOnce(t, store, 1400)
}

func TestAuthFailureIsReportedAndStoresNothing(t *testing.T) {
	api := &fakeAPI{err: fmt.Errorf("%w (HTTP 401)", ErrAuth)}
	store := &fakeStore{}

	res := newTestPuller(api, store, testConfig(), t0).Run(context.Background())

	if !res[0].AuthFailed || res[0].Error == "" {
		t.Fatalf("result %+v, want an auth failure", res[0])
	}
	if len(store.rows) != 0 {
		t.Fatalf("stored %d rows on an auth failure", len(store.rows))
	}
}
