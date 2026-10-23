// The Supabase platform-log pull (refs #164): run from the Worker's cron, once
// a minute, it pages the Management API logs endpoint for each configured
// project and table and writes the rows to the Basin stream. A port of
// supabase-pull's pull.go, with its state in D1 instead of derived from
// ClickHouse at startup.
//
// Per table: read from the stored position minus the overlap, page with the
// keyset, drop ids already sent, send the rest, and only then record the ids
// and move the cursor. A failed send leaves the cursor where it was, so the
// next tick re-reads the page: delivery is at-least-once, and a duplicate shows
// up as count(*) > count(DISTINCT id).

import { acquireLease, releaseLease } from "../alerts/store";
import { basinWriteEnabled, batchRows, type LogStream } from "../basin";
import {
  AuthError,
  DEFAULT_API_URL,
  MAX_QUERY_WINDOW_US,
  RateLimitedError,
  queryLogs,
  type ApiClient,
  type Cursor,
} from "./api";
import { toRow, type Project } from "./event";
import { commitPage, getCursor, loadSeen, pruneSeen, type CursorState } from "./store";

export interface SupabasePullEnv {
  KEYS_DB: D1Database;
  LOGS?: LogStream;
  BASIN_WRITE?: string;
  /** `ref=source,…`. Empty is a no-op, which is how this first deploys. */
  SUPABASE_PULL_PROJECTS?: string;
  SUPABASE_PULL_TABLES?: string;
  /** Management API personal access token (secret). */
  SUPABASE_ACCESS_TOKEN?: string;
}

export const DEFAULT_TABLES = ["postgres_logs", "auth_logs", "function_logs", "function_edge_logs"];

export interface PullLimits {
  pageSize: number;
  /** Bounds one tick's work per table; a backlog continues next tick. */
  maxPages: number;
  /** Each run re-reads this far behind the position, for rows Supabase lands late. */
  overlapMs: number;
  /** How far back a run reaches, including after an outage. */
  maxLookbackMs: number;
}

export const DEFAULT_LIMITS: PullLimits = {
  pageSize: 500,
  maxPages: 10,
  overlapMs: 5 * 60_000,
  maxLookbackMs: 72 * 3600_000,
};

const LEASE_NAME = "supabase-pull";
export const LEASE_TTL_MS = 5 * 60_000;
/** Stop starting pages this long into a tick. A page is at most two 30 s
 * requests and a send, so work started before it finishes inside the lease. */
export const TICK_DEADLINE_MS = LEASE_TTL_MS - 90_000;

export interface PullDeps {
  now: () => Date;
  /** Wall clock for the tick deadline; defaults to Date.now. */
  clock?: () => number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** CLEF lines for the `supabase-pull` source. Never throws. */
  emit: (lines: string[]) => Promise<void>;
  limits?: Partial<PullLimits>;
  apiUrl?: string;
}

/** Per-table outcome. Field names match the Go service's `Tables` entries. */
export interface TableResult {
  project: string;
  table: string;
  fetched: number;
  inserted: number;
  skipped: number;
  pages: number;
  /** Stopped at the page cap, the deadline or a 429 with more to read. */
  behind?: boolean;
  /** A 429 ended this table for the tick. Not a failure: the cursor held. */
  rate_limited?: boolean;
  /** Now minus the newest row sent; absent when none has been. Information, not health. */
  watermark_age_s?: number;
  /** How far behind the present the table has been read. This is the health signal. */
  read_lag_s: number;
  error?: string;
  /** Not serialized into the summary, as in Go. */
  authFailed?: boolean;
}

export interface PullTick {
  skipped?: "off" | "basin-off" | "lease-held" | "config";
  results: TableResult[];
}

export function splitList(s: string | undefined): string[] {
  return (s ?? "").split(",").map((p) => p.trim()).filter(Boolean);
}

/** `ref=source,ref=source`. Empty means no projects are enabled. */
export function parseProjects(s: string | undefined): Project[] {
  const out: Project[] = [];
  const seen = new Set<string>();
  for (const item of splitList(s)) {
    const eq = item.indexOf("=");
    const ref = eq < 0 ? "" : item.slice(0, eq).trim();
    const source = eq < 0 ? "" : item.slice(eq + 1).trim();
    if (!ref || !source) throw new Error(`invalid SUPABASE_PULL_PROJECTS entry "${item}" (want ref=source)`);
    if (seen.has(ref)) throw new Error(`duplicate project ref "${ref}" in SUPABASE_PULL_PROJECTS`);
    seen.add(ref);
    out.push({ ref, source });
  }
  return out;
}

export async function runSupabasePull(env: SupabasePullEnv, deps: PullDeps): Promise<PullTick> {
  let projects: Project[];
  try {
    projects = parseProjects(env.SUPABASE_PULL_PROJECTS);
  } catch (e) {
    await deps.emit([configErrorLine(deps.now(), (e as Error).message)]);
    return { skipped: "config", results: [] };
  }
  if (!projects.length) return { skipped: "off", results: [] };
  if (!basinWriteEnabled(env.BASIN_WRITE, env.LOGS)) return { skipped: "basin-off", results: [] };
  const stream = env.LOGS;
  const token = env.SUPABASE_ACCESS_TOKEN?.trim();
  if (!token) {
    await deps.emit([configErrorLine(deps.now(), "SUPABASE_ACCESS_TOKEN is required when SUPABASE_PULL_PROJECTS is set")]);
    return { skipped: "config", results: [] };
  }
  const configured = splitList(env.SUPABASE_PULL_TABLES);
  const tables = configured.length ? configured : DEFAULT_TABLES;
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const now = deps.now();
  const holder = crypto.randomUUID();
  if (!(await acquireLease(env.KEYS_DB, LEASE_NAME, holder, now.getTime(), LEASE_TTL_MS))) {
    return { skipped: "lease-held", results: [] };
  }
  try {
    const api: ApiClient = {
      baseUrl: deps.apiUrl ?? DEFAULT_API_URL,
      token,
      fetch: deps.fetch ?? fetch,
      sleep: deps.sleep ?? ((ms) => scheduler.wait(ms)),
    };
    const ctx: TableCtx = { db: env.KEYS_DB, stream, api, limits, deps, pastDeadline: () => clock() - started >= TICK_DEADLINE_MS };
    // Projects in parallel, since the rate limit is per project; a project's
    // tables in turn, so one project's tick spends its own budget in order.
    const perProject = await Promise.all(
      projects.map(async (p) => {
        const out: TableResult[] = [];
        for (const t of tables) out.push(await pullTable(ctx, p, t));
        return out;
      }),
    );
    const results = perProject.flat();
    await deps.emit([summaryLine(results, deps.now(), clock() - started)]);
    return { results };
  } finally {
    await releaseLease(env.KEYS_DB, LEASE_NAME, holder).catch(() => {});
  }
}

interface TableCtx {
  db: D1Database;
  stream: LogStream;
  api: ApiClient;
  limits: PullLimits;
  deps: PullDeps;
  pastDeadline: () => boolean;
}

async function pullTable(ctx: TableCtx, proj: Project, table: string): Promise<TableResult> {
  const { db, limits, deps } = ctx;
  const res: TableResult = { project: proj.source, table, fetched: 0, inserted: 0, skipped: 0, pages: 0, read_lag_s: 0 };
  const now = deps.now();
  const nowUs = now.getTime() * 1000;
  const overlapUs = limits.overlapMs * 1000;
  const floor = nowUs - limits.maxLookbackMs * 1000;
  let state: CursorState = { cursorTs: null, cursorId: null, readTo: null };

  const finish = async (): Promise<TableResult> => {
    if (state.cursorTs !== null) res.watermark_age_s = (nowUs - state.cursorTs) / 1e6;
    // Never read at all counts as the whole lookback behind.
    res.read_lag_s = state.readTo === null ? limits.maxLookbackMs / 1000 : Math.max(deps.now().getTime() * 1000 - state.readTo, 0) / 1e6;
    const pos = Math.max(state.cursorTs ?? 0, state.readTo ?? 0);
    if (pos > 0) {
      await pruneSeen(db, proj.ref, table, pos - overlapUs).catch((e) => {
        console.error(JSON.stringify({ event: "supabase-pull-prune-failed", table, error: String(e) }));
      });
    }
    return res;
  };
  const fail = (stage: string, e: unknown): Promise<TableResult> => {
    res.error = `${stage}: ${e instanceof Error ? e.message : String(e)}`;
    res.authFailed = e instanceof AuthError;
    return finish();
  };

  let seen: Set<string>;
  let start: number;
  try {
    state = await getCursor(db, proj.ref, table);
    // Resume from the later of the newest row sent and how far the table has
    // been read. With neither inside the lookback (a new project, or an outage
    // longer than it) start at the floor.
    start = Math.max(Math.max(state.cursorTs ?? 0, state.readTo ?? 0) - overlapUs, floor);
    seen = await loadSeen(db, proj.ref, table, start);
  } catch (e) {
    return fail("state", e);
  }

  let cur: Cursor = { tsUs: start, id: "" };
  let windowStart = start;
  while (res.pages < limits.maxPages) {
    if (ctx.pastDeadline()) break;
    const from = Math.max(windowStart, cur.tsUs);
    const to = Math.min(nowUs + 60e6, from + MAX_QUERY_WINDOW_US);

    let rows;
    try {
      rows = await queryLogs(ctx.api, proj.ref, table, cur, from, to, limits.pageSize);
    } catch (e) {
      if (e instanceof RateLimitedError) {
        res.rate_limited = true;
        res.behind = true;
        return finish();
      }
      return fail(`page ${res.pages + 1}`, e);
    }
    res.pages++;
    res.fetched += rows.length;

    const receivedAt = new Date();
    const fresh = rows.filter((r) => !seen.has(r.id));
    res.skipped += rows.length - fresh.length;
    try {
      for (const batch of batchRows(fresh.map((r) => toRow(proj, table, r, receivedAt)))) await ctx.stream.send(batch);
    } catch (e) {
      // The cursor stays put, so the next tick re-reads this page.
      return fail(`send ${fresh.length} rows`, e);
    }
    res.inserted += fresh.length;

    const next: CursorState = { ...state };
    const markRead = (t: number) => {
      if (next.readTo === null || t > next.readTo) next.readTo = t;
    };
    if (rows.length) {
      const last = rows[rows.length - 1];
      cur = { tsUs: last.tsUs, id: last.id };
      if (next.cursorTs === null || last.tsUs > next.cursorTs) {
        next.cursorTs = last.tsUs;
        next.cursorId = last.id;
      }
      markRead(last.tsUs);
    }
    let done = false;
    if (rows.length >= limits.pageSize) {
      // A full page: there may be more in this window.
    } else if (to < nowUs) {
      windowStart = to;
      markRead(to);
    } else {
      markRead(nowUs);
      done = true;
    }
    try {
      await commitPage(db, proj.ref, table, fresh, next, now);
    } catch (e) {
      return fail("commit", e);
    }
    state = next;
    for (const r of fresh) seen.add(r.id);
    if (done) return finish();
  }
  res.behind = true;
  return finish();
}

/**
 * One event per run, as the Go service shipped. Any failed table raises it to
 * Error, so `source = 'supabase-pull' AND level = 'Error'` catches API and auth
 * failures. `Tables` lists only the tables that failed, were rate limited or
 * are behind: every table every run would put the row over Basin's 2,000-byte
 * json_get limit and hide the scalars the reconcile reads.
 */
export function summaryLine(results: TableResult[], at: Date, durationMs: number): string {
  let inserted = 0, pages = 0, failed = 0, rateLimited = 0, maxLag = 0;
  let authFailed = false, behind = false;
  for (const r of results) {
    inserted += r.inserted;
    pages += r.pages;
    maxLag = Math.max(maxLag, r.read_lag_s);
    behind ||= !!r.behind;
    if (r.rate_limited) rateLimited++;
    if (r.error) {
      failed++;
      authFailed ||= !!r.authFailed;
    }
  }
  let level = "Information";
  let template = "supabase-pull inserted {Inserted} rows in {Pages} pages; read lag {MaxReadLagSeconds}s";
  if (failed > 0) {
    level = "Error";
    template = authFailed
      ? "supabase-pull: Supabase rejected the access token; {Failed} of {TableCount} tables failed"
      : "supabase-pull: {Failed} of {TableCount} tables failed; inserted {Inserted} rows";
  }
  return JSON.stringify({
    "@t": at.toISOString(),
    "@l": level,
    "@mt": template,
    Inserted: inserted,
    Pages: pages,
    Failed: failed,
    TableCount: results.length,
    AuthFailed: authFailed,
    Behind: behind,
    RateLimited: rateLimited,
    MaxReadLagSeconds: Math.trunc(maxLag),
    DurationMs: durationMs,
    Puller: "worker",
    Tables: results
      .filter((r) => r.error || r.behind || r.rate_limited)
      .map(({ authFailed: _, ...r }) => r),
  });
}

function configErrorLine(at: Date, error: string): string {
  return JSON.stringify({
    "@t": at.toISOString(),
    "@l": "Error",
    "@mt": "supabase-pull: invalid configuration: {Error}",
    Error: error,
    Puller: "worker",
  });
}
