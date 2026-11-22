// The alert evaluator (refs #165): run from the Worker's cron, once a minute.
//
// Each due alert's query runs against Basin with every `now()` pinned to the
// evaluation time minus ALERT_LAG_SECONDS. Basin trails ingest by 1–2 minutes,
// so an unshifted "last 5 minutes" window would always be missing its newest
// rows, and every zero-count / silence alert would fire on data that just
// hasn't landed. The query text stays plain DataFusion SQL; only the clock
// moves.
//
// Mode (ALERTS_MODE): `off` does nothing; `shadow` evaluates and records what
// it would send, on its own cooldown, and sends nothing; `live` delivers as
// v1's alert-worker does and starts the cooldown only on an accepted delivery.

import { BasinQueryError, parseBasinTimestamp, queryBasin, type BasinSqlEnv } from "../basin-sql";
import { chunk, composeBatch, selectColumns, splitBatch, type BatchMember } from "./batch";
import { ConditionError, evaluateCondition } from "./condition";
import { deliverAlert, type DeliveryEnv } from "./deliver";
import {
  acquireLease,
  destinationsByIds,
  enabledAlerts,
  firingOf,
  markErrorReported,
  markTriggered,
  parseJsonArray,
  pruneEvaluations,
  pruneFirings,
  recordEvaluation,
  recordFirings,
  previousEvaluation,
  releaseLease,
  type AlertRow,
  type Evaluation,
  type Firing,
} from "./store";

export interface AlertsEnv extends BasinSqlEnv, DeliveryEnv {
  KEYS_DB: D1Database;
  ALERTS_MODE?: string;
  ALERT_LAG_SECONDS?: string | number;
  ALERT_BATCH_MODE?: string;
}

export type AlertsMode = "off" | "shadow" | "live";

export function alertsMode(v: string | undefined): AlertsMode {
  const m = v?.trim().toLowerCase();
  return m === "shadow" || m === "live" ? m : "off";
}

/**
 * Batched alert queries (refs #194, `src/alerts/batch.ts`): `off` runs one
 * query per alert as before; `shadow` (the default) also runs the batched
 * queries and reports where they disagree, while the per-alert results stay
 * the ones that fire and are recorded; `on` evaluates from the batched
 * results, falling back to one query per alert for any batch that fails.
 */
export type AlertBatchMode = "off" | "shadow" | "on";

export function alertBatchMode(v: string | undefined): AlertBatchMode {
  const m = v?.trim().toLowerCase();
  return m === "off" || m === "on" ? m : "shadow";
}

/**
 * Alerts per batched query. Basin refuses a query whose total scan is too
 * large for a count(DISTINCT) without GROUP BY ("scan budget exceeded"), and
 * the batched scan is the sum of its members' scans: 49 alerts in one query
 * (about 200 MB) were refused, 21 (180 MB) were not. Ten keeps the heaviest
 * possible batch of today's alerts near 140 MB, and a refused batch falls back
 * to one query per alert anyway.
 */
export const ALERT_BATCH_SIZE = 10;

export const DEFAULT_ALERT_LAG_SECONDS = 180;

export function alertLagSeconds(v: string | number | undefined): number {
  const n = typeof v === "number" ? v : v === undefined || v === "" ? NaN : Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 3600 ? n : DEFAULT_ALERT_LAG_SECONDS;
}

/** A DataFusion timestamp literal, second precision, UTC. */
export function timestampLiteral(at: Date): string {
  return `TIMESTAMP '${at.toISOString().replace(/\.\d{3}Z$/, "Z")}'`;
}

const CLOCK = /\b(now\s*\(\s*\)|current_timestamp(?:\s*\(\s*\))?|current_date(?:\s*\(\s*\))?)/gi;

/**
 * Replace every clock call (`now()`, `current_timestamp`, `current_date`) with
 * a fixed instant, outside string literals, so a quoted 'now()' in a LIKE
 * pattern is left alone.
 */
export function pinNow(sql: string, at: Date): string {
  const ts = timestampLiteral(at);
  const date = `DATE '${at.toISOString().slice(0, 10)}'`;
  return sql
    .split(/('(?:[^']|'')*')/)
    .map((part, i) => (i % 2 ? part : part.replace(CLOCK, (m) => (/^current_date/i.test(m) ? date : ts))))
    .join("");
}

/**
 * Basin's newest `received_at`, looking back an hour. Every alert window ends
 * at the pinned instant, so evaluating before Basin has rows up to it would
 * read a partial window, and every zero-count / silence alert would fire on a
 * pipeline delay instead of a real silence.
 */
export async function basinNewest(env: BasinSqlEnv, pinned: Date): Promise<Date | null> {
  const { rows } = await queryBasin<{ newest: string | null }>(env, freshnessMember(pinned).sql, ALERT_QUERY_TIMEOUT_MS);
  return parseBasinTimestamp(rows[0]?.newest);
}

function freshnessMember(pinned: Date): BatchMember {
  return {
    sql: `SELECT CAST(max(received_at) AS VARCHAR) AS newest FROM logs.events WHERE received_at > ${timestampLiteral(new Date(pinned.getTime() - 3_600_000))}`,
    columns: ["newest"],
  };
}

/**
 * Cron ticks land roughly, not exactly, a minute apart. Without slack a 60 s
 * alert whose previous run was 59.8 s ago would skip a tick and run every
 * two minutes.
 */
export const DUE_SLACK_MS = 10_000;

/**
 * A Basin SQL timeout on one tick (`Query exceeded 30 seconds`). Seen on whole
 * ticks at once, 12 of ~170k evaluations from 10-26 to 11-04, and each alert
 * evaluated `ok` on its next tick. So the first timeout in a row isn't
 * reported, and the alert runs again on the next tick instead of losing its
 * interval's look. A second one in a row is reported and the alert goes back
 * to its interval, so a query that always times out doesn't run every minute.
 */
export function isQueryTimeout(error: string | null | undefined): boolean {
  return error === `Query error: Query exceeded ${ALERT_QUERY_TIMEOUT_MS / 1000} seconds`;
}

/** The last run was a first timeout in a row, so the alert runs again now. */
export function retriesTimeout(alert: AlertRow, previous: Pick<AlertRow, "last_status" | "last_error"> | null): boolean {
  if (!(alert.last_status === "error" && isQueryTimeout(alert.last_error))) return false;
  return !(previous?.last_status === "error" && isQueryTimeout(previous.last_error));
}

export function isDue(alert: AlertRow, now: Date): boolean {
  if (!alert.last_run_at) return true;
  const elapsed = now.getTime() - Date.parse(alert.last_run_at);
  return !(elapsed < Math.max(alert.interval_seconds, 30) * 1000 - DUE_SLACK_MS);
}

export const ALERT_CONCURRENCY = 6;
export const ALERT_QUERY_TIMEOUT_MS = 30_000;
const LEASE_NAME = "alerts";
export const LEASE_TTL_MS = 5 * 60_000;
/**
 * Stop starting alerts this long into a tick. The slowest single evaluation
 * is a 30 s query plus a 30 s delivery, so work started before the deadline
 * finishes inside the lease; anything left over is still due next tick.
 */
export const TICK_DEADLINE_MS = LEASE_TTL_MS - 90_000;

/** An alert's row from a batched query, and that query's run time. */
export interface BatchedRow {
  row: Record<string, unknown>;
  queryMs: number;
}

export interface BatchRun {
  /** Each batched alert's own row, by alert id. Absent: evaluate it alone. */
  rows: Map<string, BatchedRow>;
  /** Basin's newest `received_at`, when the batch that carried the check succeeded. */
  newest?: Date | null;
  queries: number;
  /** Due alerts that run alone (see `runsAlone`). */
  alone: number;
  failures: { alerts: number; error: string }[];
}

/**
 * An alert that runs on its own query instead of in a batch: one whose output
 * columns can't be read from its SQL, or whose last run failed in the query
 * itself (bad SQL, no rows), which would fail its whole batch again. A timeout
 * doesn't count: those are whole-tick and pass on their own.
 */
export function runsAlone(alert: AlertRow): boolean {
  if (alert.last_status === "error" && alert.last_error?.startsWith("Query error:") && !isQueryTimeout(alert.last_error)) return true;
  return selectColumns(alert.query) === null;
}

/**
 * Run the due alerts' queries as batches of ALERT_BATCH_SIZE, the freshness
 * check riding in the first. A batch that fails for any reason (one member's
 * bad SQL, a timeout, Basin's scan budget) leaves its alerts out of `rows`, so
 * each is evaluated on its own query exactly as before.
 */
export async function runBatches(env: BasinSqlEnv, due: AlertRow[], pinned: Date): Promise<BatchRun> {
  const batchable = due
    .filter((a) => !runsAlone(a))
    .map((a) => ({ id: a.id, member: { sql: pinNow(a.query, pinned), columns: selectColumns(a.query)! } }));
  const run: BatchRun = { rows: new Map(), queries: 0, alone: due.length - batchable.length, failures: [] };
  const groups = chunk(batchable, ALERT_BATCH_SIZE);
  let next = 0;
  const worker = async () => {
    while (next < groups.length) {
      const i = next++;
      const group = groups[i];
      const members = group.map((g) => g.member);
      if (i === 0) members.unshift(freshnessMember(pinned));
      const started = Date.now();
      run.queries++;
      try {
        const { rows } = await queryBasin(env, composeBatch(members), ALERT_QUERY_TIMEOUT_MS);
        const own = splitBatch(rows, members);
        const queryMs = Date.now() - started;
        if (i === 0) run.newest = parseBasinTimestamp(own.shift()?.newest as string | null | undefined);
        group.forEach((g, j) => run.rows.set(g.id, { row: own[j], queryMs }));
      } catch (e) {
        run.failures.push({ alerts: group.length, error: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ALERT_CONCURRENCY, groups.length) }, worker));
  return run;
}

export interface AlertDeps {
  now: () => Date;
  /** Wall clock for the tick deadline; defaults to Date.now. */
  clock?: () => number;
  /** One CLEF line per event, for the alerts telemetry source. Never throws. */
  emit: (lines: string[]) => Promise<void>;
  fetch?: typeof fetch;
}

export interface TickSummary {
  mode: AlertsMode;
  skipped?: "off" | "lease-held" | "basin-behind";
  /** Newest `received_at` in Basin when the tick held for freshness. */
  basinNewest?: string | null;
  due: number;
  evaluated: Evaluation[];
}

export async function runAlerts(env: AlertsEnv, deps: AlertDeps): Promise<TickSummary> {
  const mode = alertsMode(env.ALERTS_MODE);
  if (mode === "off") return { mode, skipped: "off", due: 0, evaluated: [] };

  const now = deps.now();
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const holder = crypto.randomUUID();
  if (!(await acquireLease(env.KEYS_DB, LEASE_NAME, holder, now.getTime(), LEASE_TTL_MS))) {
    return { mode, skipped: "lease-held", due: 0, evaluated: [] };
  }
  try {
    const due: AlertRow[] = [];
    for (const a of await enabledAlerts(env.KEYS_DB)) {
      if (isDue(a, now)) due.push(a);
      // Only an alert whose last run timed out pays for the extra read.
      else if (isQueryTimeout(a.last_error) && retriesTimeout(a, await previousEvaluation(env.KEYS_DB, a.id))) due.push(a);
    }
    const lag = alertLagSeconds(env.ALERT_LAG_SECONDS);
    const batchMode = alertBatchMode(env.ALERT_BATCH_MODE);
    let batch: BatchRun | null = null;
    if (due.length) {
      // Hold the whole tick while Basin hasn't caught up to the pinned
      // instant. Nothing is recorded, so every alert is still due next tick.
      // Batched, the check rides in the first batch, whose results are then
      // discarded along with the rest of a held tick.
      const pinned = new Date(now.getTime() - lag * 1000);
      if (batchMode !== "off") batch = await runBatches(env, due, pinned);
      let newest: Date | null = null;
      if (batch?.newest !== undefined) newest = batch.newest;
      else {
        try {
          newest = await basinNewest(env, pinned);
        } catch (e) {
          console.error(JSON.stringify({ event: "alerts-freshness-check-failed", error: e instanceof Error ? e.message : String(e) }));
        }
      }
      if (!newest || newest < pinned) {
        if (now.getUTCMinutes() % 10 === 0 || !newest) {
          await deps.emit([behindLine(now, pinned, newest, due.length)]);
        }
        return { mode, skipped: "basin-behind", basinNewest: newest?.toISOString() ?? null, due: due.length, evaluated: [] };
      }
    }
    const evaluated: Evaluation[] = [];
    const firings: Firing[] = [];
    const lines: string[] = [];
    let compared = 0;
    let mismatches = 0;
    let next = 0;
    const worker = async () => {
      while (next < due.length && clock() - started < TICK_DEADLINE_MS) {
        const alert = due[next++];
        const batched = batch?.rows.get(alert.id);
        const e = await evaluateAlert(env, alert, mode, now, lag, deps.fetch, batchMode === "on" ? batched : undefined);
        if (batchMode === "shadow" && batched) {
          compared++;
          const mismatch = shadowMismatch(alert, e, batched.row, now);
          if (mismatch) {
            mismatches++;
            lines.push(mismatch);
          }
        }
        evaluated.push(e);
        const firing = firingOf(e);
        if (firing) firings.push(firing);
        const report = telemetryFor(alert, e, now);
        lines.push(...report);
        try {
          if (e.status === "error" && report.length) await markErrorReported(env.KEYS_DB, alert.id, now);
          await recordEvaluation(env.KEYS_DB, e);
        } catch (err) {
          console.error(JSON.stringify({ event: "alert-record-failed", alertId: alert.id, error: String(err) }));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ALERT_CONCURRENCY, due.length) }, worker));
    if (batch && (batchMode === "shadow" || batch.failures.length)) {
      lines.push(batchSummaryLine(now, batchMode, batch, due.length, compared, mismatches));
    }
    // Firing history (refs #193): one batch after every delivery is done, so
    // it never delays a send, and a failed write is reported, never thrown.
    try {
      await recordFirings(env.KEYS_DB, firings);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ event: "alert-firings-record-failed", firings: firings.length, error }));
      lines.push(firingsFailedLine(now, firings.length, error));
    }
    if (lines.length) await deps.emit(lines);
    if (now.getUTCMinutes() === 0) {
      await pruneEvaluations(env.KEYS_DB, now).catch(() => {});
      await pruneFirings(env.KEYS_DB, now).catch((err) =>
        console.error(JSON.stringify({ event: "alert-firings-prune-failed", error: err instanceof Error ? err.message : String(err) })),
      );
    }
    return { mode, due: due.length, evaluated };
  } finally {
    await releaseLease(env.KEYS_DB, LEASE_NAME, holder).catch(() => {});
  }
}

export async function evaluateAlert(
  env: AlertsEnv,
  alert: AlertRow,
  mode: "shadow" | "live",
  now: Date,
  lagSeconds: number,
  doFetch?: typeof fetch,
  batched?: BatchedRow,
): Promise<Evaluation> {
  // A batched row's query time counts toward the evaluation, as its own query's would.
  const started = Date.now() - (batched?.queryMs ?? 0);
  const base = { alertId: alert.id, evaluatedAt: now, mode, wouldSend: false, sent: false, value: null, error: null };
  const done = (e: Partial<Evaluation> & Pick<Evaluation, "status">): Evaluation => ({
    ...base,
    ...e,
    durationMs: Date.now() - started,
  });

  let row: Record<string, unknown>;
  if (batched) row = batched.row;
  else {
    try {
      const sql = pinNow(alert.query, new Date(now.getTime() - lagSeconds * 1000));
      const { rows } = await queryBasin(env, sql, ALERT_QUERY_TIMEOUT_MS);
      if (!rows.length) return done({ status: "error", error: "Query error: query returned no rows" });
      row = rows[0];
    } catch (e) {
      const msg = e instanceof BasinQueryError ? e.message : e instanceof Error ? e.message : String(e);
      return done({ status: "error", error: `Query error: ${msg}` });
    }
  }

  let triggered: boolean;
  try {
    triggered = evaluateCondition(alert.condition, row);
  } catch (e) {
    const msg = e instanceof ConditionError ? e.message : String(e);
    return done({ status: "error", value: row, error: `Condition evaluation error: ${msg}` });
  }
  if (!triggered) return done({ status: "ok", value: row });

  const last = mode === "live" ? alert.last_triggered_at : alert.shadow_last_triggered_at;
  // The same tick slack as isDue: a 30-min cooldown on a 5-min alert ends on
  // a tick that lands a few hundred ms early, and without the slack that tick
  // reads as cooldown and the send waits a whole interval (seen 11-03 00:37
  // and 20:08, 0.35 s and 0.09 s short).
  if (last && now.getTime() - Date.parse(last) < alert.cooldown_seconds * 1000 - DUE_SLACK_MS) {
    return done({ status: "cooldown", value: row });
  }
  if (mode === "shadow") {
    await markTriggered(env.KEYS_DB, alert.id, "shadow", now).catch((err) =>
      console.error(JSON.stringify({ event: "alert-cooldown-write-failed", alertId: alert.id, error: String(err) })),
    );
    return done({ status: "triggered", value: row, wouldSend: true });
  }

  let destinations: Awaited<ReturnType<typeof destinationsByIds>> = [];
  try {
    destinations = await destinationsByIds(env.KEYS_DB, parseJsonArray(alert.destination_ids));
  } catch (e) {
    console.error(JSON.stringify({ event: "alert-destinations-failed", alertId: alert.id, error: String(e) }));
  }
  const delivery = await deliverAlert(env, alert, destinations, row, now, doFetch);
  if (delivery.delivered > 0) {
    // First, and on its own: the cooldown is what stops a resend every tick.
    // One retry, because a lost write here means duplicate pages.
    await markTriggered(env.KEYS_DB, alert.id, "live", now)
      .catch(() => markTriggered(env.KEYS_DB, alert.id, "live", now))
      .catch((err) => console.error(JSON.stringify({ event: "alert-cooldown-write-failed", alertId: alert.id, error: String(err) })));
  }
  const failed = delivery.attempts.filter((a) => !a.ok);
  return done({
    status: "triggered",
    value: row,
    wouldSend: true,
    sent: delivery.delivered > 0,
    deliveries: delivery.attempts,
    error:
      delivery.delivered > 0
        ? failed.length
          ? `partial delivery: ${failed.map((a) => `${a.target}: ${a.error}`).join("; ")}`
          : null
        : `Dispatch failed (cooldown not started): ${failed.map((a) => `${a.target}: ${a.error}`).join("; ") || "no destinations or recipients configured"}`,
  });
}

export const ERROR_REPORT_INTERVAL_MS = 3_600_000;

/** Not in the `[id] …` shape, so the "an alert cannot evaluate" alert doesn't match it. */
function firingsFailedLine(now: Date, count: number, error: string): string {
  return JSON.stringify({
    "@t": now.toISOString(),
    "@l": "Warning",
    "@m": `Alert firing history not recorded for ${count} firing(s): ${error}`,
    "@mt": "Alert firing history not recorded for {Firings} firing(s): {Error}",
    Firings: count,
    Error: error,
  });
}

/** The condition on a row: true or false, or null when it can't be evaluated. */
function wouldFire(condition: string, row: Record<string, unknown> | null): boolean | null {
  if (!row) return null;
  try {
    return evaluateCondition(condition, row);
  } catch {
    return null;
  }
}

function sameRow(a: Record<string, unknown> | null, b: Record<string, unknown> | null): boolean {
  const canon = (r: Record<string, unknown> | null) => (r ? JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]])) : "null");
  return canon(a) === canon(b);
}

/**
 * Shadow batching: one Warning when an alert's batched row differs from the
 * row its own query returned (the evaluation `e`, which stays authoritative).
 * Not in the `[id] …` shape, so the "an alert cannot evaluate" alert doesn't
 * match it.
 */
export function shadowMismatch(alert: AlertRow, e: Evaluation, batched: Record<string, unknown>, now: Date): string | null {
  const own = e.status === "error" && e.error?.startsWith("Query error:") ? null : e.value;
  if (sameRow(own, batched)) return null;
  return JSON.stringify({
    "@t": now.toISOString(),
    "@l": "Warning",
    "@m": `Alert batch shadow mismatch: ${alert.name}`,
    "@mt": "Alert batch shadow mismatch: {AlertName}",
    AlertId: alert.id,
    AlertName: alert.name,
    PerAlert: own,
    PerAlertError: own ? null : e.error,
    Batched: batched,
    PerAlertWouldFire: wouldFire(alert.condition, own),
    BatchedWouldFire: wouldFire(alert.condition, batched),
  });
}

function batchSummaryLine(now: Date, mode: AlertBatchMode, batch: BatchRun, due: number, compared: number, mismatches: number): string {
  const failed = batch.failures.reduce((n, f) => n + f.alerts, 0);
  return JSON.stringify({
    "@t": now.toISOString(),
    "@l": mismatches || batch.failures.length ? "Warning" : "Information",
    "@m":
      `Alert batches (${mode}): ${batch.queries} queries for ${due} due, ${batch.alone} alone, ` +
      `${batch.failures.length} failed (${failed} alerts), ${mismatches} of ${compared} mismatched`,
    "@mt": "Alert batches ({BatchMode}): {BatchQueries} queries for {Due} due",
    BatchMode: mode,
    Due: due,
    BatchQueries: batch.queries,
    BatchedAlerts: batch.rows.size,
    Alone: batch.alone,
    FailedBatches: batch.failures.length,
    FailedAlerts: failed,
    BatchErrors: batch.failures.map((f) => f.error),
    Compared: compared,
    Mismatches: mismatches,
  });
}

function behindLine(now: Date, pinned: Date, newest: Date | null, held: number): string {
  const behind = newest ? Math.round((pinned.getTime() - newest.getTime()) / 60_000) : null;
  return JSON.stringify({
    "@t": now.toISOString(),
    "@l": "Warning",
    "@m": newest
      ? `Alerts held: Basin is ${behind} minute(s) behind the evaluation window (${held} due)`
      : `Alerts held: Basin returned no recent rows or failed the freshness check (${held} due)`,
    "@mt": "Alerts held: Basin behind the evaluation window",
    BasinNewest: newest?.toISOString() ?? null,
    EvaluateAsOf: pinned.toISOString(),
    BehindMinutes: behind,
    HeldAlerts: held,
  });
}

/**
 * The CLEF lines one evaluation contributes, in v1's `[id] …` message shape so
 * the "an alert cannot evaluate" alert keeps its pattern. An error reports on
 * the first failing run and then at most hourly while it persists; a send (or
 * a shadow would-send) always reports.
 */
export function telemetryFor(alert: AlertRow, e: Evaluation, now: Date): string[] {
  const t = now.toISOString();
  const base = { "@t": t, AlertId: alert.id, AlertName: alert.name, Mode: e.mode };
  if (e.status === "error") {
    if (isQueryTimeout(e.error) && !(alert.last_status === "error" && isQueryTimeout(alert.last_error))) return [];
    const last = alert.last_error_reported_at ? Date.parse(alert.last_error_reported_at) : NaN;
    const fresh = alert.last_status !== "error" || !(now.getTime() - last < ERROR_REPORT_INTERVAL_MS);
    if (!fresh) return [];
    return [JSON.stringify({ ...base, "@l": "Warning", "@m": `[${alert.id}] ${e.error}`, "@mt": "[{AlertId}] {Error}", Error: e.error })];
  }
  if (e.status === "triggered") {
    const verb = e.mode === "shadow" ? "Shadow would send" : e.sent ? "Sending alert" : "Dispatch failed";
    return [
      JSON.stringify({
        ...base,
        "@l": e.mode === "live" && !e.sent ? "Error" : "Information",
        "@m": `[${alert.id}] ${verb}: ${alert.name}`,
        "@mt": `[{AlertId}] ${verb}: {AlertName}`,
        Value: e.value,
        ...(e.error ? { Error: e.error } : {}),
      }),
    ];
  }
  return [];
}
