package main

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// recentWatermarkWindow is how far the cheap first watermark lookup reaches.
// logs.events is ordered by the source column, which the cutover rows don't
// share, so a property filter scans every source's rows in the window; only
// tables with nothing that recent pay for the MaxLookback scan.
const recentWatermarkWindow = time.Hour

type Puller struct {
	api   LogAPI
	store Store
	cfg   Config
	now   func() time.Time

	// watermarks is derived from logs.events on the first run after start
	// and maintained in memory after that. No state file: a restart
	// re-derives it.
	watermarks map[string]map[string]time.Time
	// readTo is how far this process has read each table with nothing left
	// behind, including stretches that held no rows, which a watermark taken
	// from stored rows cannot remember. Without it a quiet table re-walks, and
	// re-scans logs.events for, its whole lookback every run, and a lookback
	// longer than the page cap covers never reaches the present.
	readTo map[string]map[string]time.Time
}

func NewPuller(api LogAPI, store Store, cfg Config) *Puller {
	return &Puller{api: api, store: store, cfg: cfg, now: time.Now,
		watermarks: map[string]map[string]time.Time{}, readTo: map[string]map[string]time.Time{}}
}

type TableResult struct {
	Project  string `json:"project"`
	Table    string `json:"table"`
	Fetched  int    `json:"fetched"`
	Inserted int    `json:"inserted"`
	Skipped  int    `json:"skipped"`
	Pages    int    `json:"pages"`
	// Behind is true when the run stopped at MaxPagesPerTable with more to read.
	Behind bool `json:"behind,omitempty"`
	// WatermarkAgeSeconds is now minus the newest row stored for the table.
	WatermarkAgeSeconds float64 `json:"watermark_age_s"`
	Error               string  `json:"error,omitempty"`
	AuthFailed          bool    `json:"-"`
}

// Run pulls every configured project and table once.
func (p *Puller) Run(ctx context.Context) []TableResult {
	var results []TableResult
	for _, proj := range p.cfg.Projects {
		wms, err := p.projectWatermarks(ctx, proj)
		if err != nil {
			for _, table := range p.cfg.Tables {
				results = append(results, TableResult{Project: proj.Source, Table: table, Error: err.Error()})
			}
			continue
		}
		for _, table := range p.cfg.Tables {
			if ctx.Err() != nil {
				return results
			}
			results = append(results, p.pullTable(ctx, proj, table, wms))
		}
	}
	return results
}

func (p *Puller) projectWatermarks(ctx context.Context, proj Project) (map[string]time.Time, error) {
	if wms, ok := p.watermarks[proj.Source]; ok {
		return wms, nil
	}
	now := p.now()
	wms, err := p.store.Watermarks(ctx, proj.Source, now.Add(-recentWatermarkWindow))
	if err != nil {
		return nil, err
	}
	if missing := p.missingTables(wms); len(missing) > 0 && p.cfg.MaxLookback > recentWatermarkWindow {
		older, err := p.store.Watermarks(ctx, proj.Source, now.Add(-p.cfg.MaxLookback))
		if err != nil {
			return nil, err
		}
		for _, t := range missing {
			if ts, ok := older[t]; ok {
				wms[t] = ts
			}
		}
	}
	p.watermarks[proj.Source] = wms
	return wms, nil
}

func (p *Puller) missingTables(wms map[string]time.Time) []string {
	var out []string
	for _, t := range p.cfg.Tables {
		if _, ok := wms[t]; !ok {
			out = append(out, t)
		}
	}
	return out
}

func (p *Puller) pullTable(ctx context.Context, proj Project, table string, wms map[string]time.Time) (res TableResult) {
	res = TableResult{Project: proj.Source, Table: table}
	now := p.now()
	floor := now.Add(-p.cfg.MaxLookback)

	defer func() {
		if wm, ok := wms[table]; ok {
			res.WatermarkAgeSeconds = now.Sub(wm).Seconds()
		} else {
			res.WatermarkAgeSeconds = p.cfg.MaxLookback.Seconds()
		}
	}()
	fail := func(err error) TableResult {
		res.Error = err.Error()
		res.AuthFailed = errors.Is(err, ErrAuth)
		return res
	}

	if p.readTo[proj.Source] == nil {
		p.readTo[proj.Source] = map[string]time.Time{}
	}
	readTo := p.readTo[proj.Source]
	markRead := func(t time.Time) {
		if t.After(readTo[table]) {
			readTo[table] = t
		}
	}

	// Resume from the later of the newest stored row and how far this process
	// has read. With neither inside MaxLookback (a new project, or an outage
	// longer than the floor) start at the floor: everything Supabase still
	// retains that the floor allows.
	pos := wms[table]
	if readTo[table].After(pos) {
		pos = readTo[table]
	}
	start := pos.Add(-p.cfg.Overlap)
	if start.Before(floor) {
		start = floor
	}

	seen, err := p.store.Seen(ctx, proj.Source, table, start)
	if err != nil {
		return fail(err)
	}

	cur := Cursor{Timestamp: start}
	windowStart := start
	for res.Pages < p.cfg.MaxPagesPerTable {
		from := windowStart
		if cur.Timestamp.After(from) {
			from = cur.Timestamp
		}
		to := now.Add(time.Minute)
		if from.Add(maxQueryWindow).Before(to) {
			to = from.Add(maxQueryWindow)
		}

		rows, err := p.api.Query(ctx, proj.Ref, table, cur, from, to, p.cfg.PageSize)
		if err != nil {
			return fail(fmt.Errorf("page %d: %w", res.Pages+1, err))
		}
		res.Pages++
		res.Fetched += len(rows)

		var fresh []Event
		for _, r := range rows {
			e := toEvent(proj, table, r)
			if seen.Has(e) {
				res.Skipped++
				continue
			}
			fresh = append(fresh, e)
		}
		if len(fresh) > 0 {
			if err := p.store.Insert(ctx, fresh); err != nil {
				// The in-memory watermark stays put, so the next run re-reads
				// this page; an uncertain write is then skipped by sb_id.
				return fail(fmt.Errorf("insert %d rows: %w", len(fresh), err))
			}
			res.Inserted += len(fresh)
		}
		if len(rows) > 0 {
			last := rows[len(rows)-1]
			cur = Cursor{Timestamp: last.Timestamp, ID: last.ID}
			if wm, ok := wms[table]; !ok || last.Timestamp.After(wm) {
				wms[table] = last.Timestamp
			}
			markRead(last.Timestamp)
		}

		switch {
		case len(rows) >= p.cfg.PageSize:
			// A full page: there may be more in this window.
		case to.Before(now):
			windowStart = to
			markRead(to)
		default:
			markRead(now)
			return res
		}
	}
	res.Behind = true
	return res
}
