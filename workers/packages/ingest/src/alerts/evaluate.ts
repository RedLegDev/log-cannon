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

import { BasinQueryError, queryBasin, type BasinSqlEnv } from "../basin-sql";
import { ConditionError, evaluateCondition } from "./condition";
import { deliverAlert, type DeliveryEnv } from "./deliver";
import {
  acquireLease,
  destinationsByIds,
  enabledAlerts,
  parseJsonArray,
  pruneEvaluations,
  recordEvaluation,
  releaseLease,
  type AlertRow,
  type Evaluation,
} from "./store";

export interface AlertsEnv extends BasinSqlEnv, DeliveryEnv {
  KEYS_DB: D1Database;
  ALERTS_MODE?: string;
  ALERT_LAG_SECONDS?: string | number;
}

export type AlertsMode = "off" | "shadow" | "live";

export function alertsMode(v: string | undefined): AlertsMode {
  const m = v?.trim().toLowerCase();
  return m === "shadow" || m === "live" ? m : "off";
}

export const DEFAULT_ALERT_LAG_SECONDS = 180;

export function alertLagSeconds(v: string | number | undefined): number {
  const n = typeof v === "number" ? v : v === undefined || v === "" ? NaN : Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 3600 ? n : DEFAULT_ALERT_LAG_SECONDS;
}

/** A DataFusion timestamp literal, second precision, UTC. */
export function timestampLiteral(at: Date): string {
  return `TIMESTAMP '${at.toISOString().replace(/\.\d{3}Z$/, "Z")}'`;
}

/** Replace every `now()` call with a fixed instant. */
export function pinNow(sql: string, at: Date): string {
  return sql.replace(/\bnow\s*\(\s*\)/gi, timestampLiteral(at));
}

/**
 * Cron ticks land roughly, not exactly, a minute apart. Without slack a 60 s
 * alert whose previous run was 59.8 s ago would skip a tick and run every
 * two minutes.
 */
const DUE_SLACK_MS = 10_000;

export function isDue(alert: AlertRow, now: Date): boolean {
  if (!alert.last_run_at) return true;
  const elapsed = now.getTime() - Date.parse(alert.last_run_at);
  return !(elapsed < Math.max(alert.interval_seconds, 30) * 1000 - DUE_SLACK_MS);
}

export const ALERT_CONCURRENCY = 6;
export const ALERT_QUERY_TIMEOUT_MS = 30_000;
const LEASE_NAME = "alerts";
const LEASE_TTL_MS = 5 * 60_000;

export interface AlertDeps {
  now: () => Date;
  /** One CLEF line per event, for the alerts telemetry source. Never throws. */
  emit: (lines: string[]) => Promise<void>;
  fetch?: typeof fetch;
}

export interface TickSummary {
  mode: AlertsMode;
  skipped?: "off" | "lease-held";
  due: number;
  evaluated: Evaluation[];
}

export async function runAlerts(env: AlertsEnv, deps: AlertDeps): Promise<TickSummary> {
  const mode = alertsMode(env.ALERTS_MODE);
  if (mode === "off") return { mode, skipped: "off", due: 0, evaluated: [] };

  const now = deps.now();
  const holder = crypto.randomUUID();
  if (!(await acquireLease(env.KEYS_DB, LEASE_NAME, holder, now.getTime(), LEASE_TTL_MS))) {
    return { mode, skipped: "lease-held", due: 0, evaluated: [] };
  }
  try {
    const due = (await enabledAlerts(env.KEYS_DB)).filter((a) => isDue(a, now));
    const lag = alertLagSeconds(env.ALERT_LAG_SECONDS);
    const evaluated: Evaluation[] = [];
    const lines: string[] = [];
    let next = 0;
    const worker = async () => {
      while (next < due.length) {
        const alert = due[next++];
        const e = await evaluateAlert(env, alert, mode, now, lag, deps.fetch);
        evaluated.push(e);
        lines.push(...telemetryFor(alert, e, now));
        try {
          await recordEvaluation(env.KEYS_DB, e);
        } catch (err) {
          console.error(JSON.stringify({ event: "alert-record-failed", alertId: alert.id, error: String(err) }));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ALERT_CONCURRENCY, due.length) }, worker));
    if (lines.length) await deps.emit(lines);
    if (now.getUTCMinutes() === 0) await pruneEvaluations(env.KEYS_DB, now).catch(() => {});
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
): Promise<Evaluation> {
  const started = Date.now();
  const base = { alertId: alert.id, evaluatedAt: now, mode, wouldSend: false, sent: false, value: null, error: null };
  const done = (e: Partial<Evaluation> & Pick<Evaluation, "status">): Evaluation => ({
    ...base,
    ...e,
    durationMs: Date.now() - started,
  });

  let row: Record<string, unknown>;
  try {
    const sql = pinNow(alert.query, new Date(now.getTime() - lagSeconds * 1000));
    const { rows } = await queryBasin(env, sql, ALERT_QUERY_TIMEOUT_MS);
    if (!rows.length) return done({ status: "error", error: "Query error: query returned no rows" });
    row = rows[0];
  } catch (e) {
    const msg = e instanceof BasinQueryError ? e.message : e instanceof Error ? e.message : String(e);
    return done({ status: "error", error: `Query error: ${msg}` });
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
  if (last && now.getTime() - Date.parse(last) < alert.cooldown_seconds * 1000) {
    return done({ status: "cooldown", value: row });
  }
  if (mode === "shadow") return done({ status: "triggered", value: row, wouldSend: true });

  let destinations: Awaited<ReturnType<typeof destinationsByIds>> = [];
  try {
    destinations = await destinationsByIds(env.KEYS_DB, parseJsonArray(alert.destination_ids));
  } catch (e) {
    console.error(JSON.stringify({ event: "alert-destinations-failed", alertId: alert.id, error: String(e) }));
  }
  const delivery = await deliverAlert(env, alert, destinations, row, now, doFetch);
  const failed = delivery.attempts.filter((a) => !a.ok);
  return done({
    status: "triggered",
    value: row,
    wouldSend: true,
    sent: delivery.delivered > 0,
    error:
      delivery.delivered > 0
        ? failed.length
          ? `partial delivery: ${failed.map((a) => `${a.target}: ${a.error}`).join("; ")}`
          : null
        : `Dispatch failed (cooldown not started): ${failed.map((a) => `${a.target}: ${a.error}`).join("; ") || "no destinations or recipients configured"}`,
  });
}

/**
 * The CLEF lines one evaluation contributes, in v1's `[id] …` message shape so
 * the "an alert cannot evaluate" alert keeps its pattern. An error reports on
 * the first failing run and then once an hour while it persists; a send (or a
 * shadow would-send) always reports.
 */
export function telemetryFor(alert: AlertRow, e: Evaluation, now: Date): string[] {
  const t = now.toISOString();
  const base = { "@t": t, AlertId: alert.id, AlertName: alert.name, Mode: e.mode };
  if (e.status === "error") {
    const fresh = alert.last_status !== "error" || now.getUTCMinutes() === 0;
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
