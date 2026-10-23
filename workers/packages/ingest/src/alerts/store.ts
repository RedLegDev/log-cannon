// D1 access for alerts, destinations, the evaluation log and cron leases (refs #165).

export interface AlertRow {
  id: string;
  name: string;
  description: string;
  query: string;
  condition: string;
  interval_seconds: number;
  cooldown_seconds: number;
  recipients: string;
  destination_ids: string;
  subject: string;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_triggered_at: string | null;
  shadow_last_triggered_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_value: string | null;
  last_error: string | null;
}

export interface DestinationRow {
  id: string;
  name: string;
  type: string;
  config: string;
  enabled: number;
  created_at: string;
}

export type EvalStatus = "ok" | "triggered" | "cooldown" | "error";

export interface Evaluation {
  alertId: string;
  evaluatedAt: Date;
  mode: "shadow" | "live";
  status: EvalStatus;
  wouldSend: boolean;
  sent: boolean;
  value: Record<string, unknown> | null;
  error: string | null;
  durationMs: number;
}

/** The fields a caller may set. Everything else is server-owned. */
export const ALERT_FIELDS = [
  "name",
  "description",
  "query",
  "condition",
  "interval_seconds",
  "cooldown_seconds",
  "recipients",
  "destination_ids",
  "subject",
  "enabled",
] as const;
export type AlertInput = Partial<Record<(typeof ALERT_FIELDS)[number], unknown>>;

export const DESTINATION_FIELDS = ["name", "type", "config", "enabled"] as const;

export function parseJsonArray(s: string | null | undefined): string[] {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export async function listAlerts(db: D1Database): Promise<AlertRow[]> {
  return (await db.prepare("SELECT * FROM alerts ORDER BY created_at, id").all<AlertRow>()).results;
}

export async function getAlert(db: D1Database, id: string): Promise<AlertRow | null> {
  return db.prepare("SELECT * FROM alerts WHERE id = ?").bind(id).first<AlertRow>();
}

export async function enabledAlerts(db: D1Database): Promise<AlertRow[]> {
  return (await db.prepare("SELECT * FROM alerts WHERE enabled = 1").all<AlertRow>()).results;
}

/** Insert with a caller-chosen id (the v1 import keeps ids) or a fresh one. */
export async function insertAlert(db: D1Database, a: Required<NormalizedAlert> & { id?: string }, now: Date): Promise<string> {
  const id = a.id ?? crypto.randomUUID();
  const at = now.toISOString();
  await db
    .prepare(
      `INSERT INTO alerts (id, name, description, query, condition, interval_seconds, cooldown_seconds,
         recipients, destination_ids, subject, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      a.name,
      a.description,
      a.query,
      a.condition,
      a.interval_seconds,
      a.cooldown_seconds,
      JSON.stringify(a.recipients),
      JSON.stringify(a.destination_ids),
      a.subject,
      a.enabled ? 1 : 0,
      at,
      at,
    )
    .run();
  return id;
}

export async function updateAlert(db: D1Database, id: string, a: NormalizedAlert, now: Date): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    binds.push(Array.isArray(v) ? JSON.stringify(v) : typeof v === "boolean" ? (v ? 1 : 0) : v);
  }
  if (!sets.length) return (await getAlert(db, id)) !== null;
  sets.push("updated_at = ?");
  binds.push(now.toISOString(), id);
  const r = await db.prepare(`UPDATE alerts SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  return r.meta.changes > 0;
}

export async function deleteAlert(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM alerts WHERE id = ?").bind(id).run();
  return r.meta.changes > 0;
}

export interface NormalizedAlert {
  name?: string;
  description?: string;
  query?: string;
  condition?: string;
  interval_seconds?: number;
  cooldown_seconds?: number;
  recipients?: string[];
  destination_ids?: string[];
  subject?: string;
  enabled?: boolean;
}

export async function listDestinations(db: D1Database): Promise<DestinationRow[]> {
  return (await db.prepare("SELECT * FROM alert_destinations ORDER BY created_at, id").all<DestinationRow>()).results;
}

export async function destinationsByIds(db: D1Database, ids: string[]): Promise<DestinationRow[]> {
  if (!ids.length) return [];
  const marks = ids.map(() => "?").join(", ");
  return (
    await db
      .prepare(`SELECT * FROM alert_destinations WHERE enabled = 1 AND id IN (${marks})`)
      .bind(...ids)
      .all<DestinationRow>()
  ).results;
}

export async function insertDestination(
  db: D1Database,
  d: { id?: string; name: string; type: string; config: string; enabled: boolean },
  now: Date,
): Promise<string> {
  const id = d.id ?? crypto.randomUUID();
  await db
    .prepare("INSERT INTO alert_destinations (id, name, type, config, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, d.name, d.type, d.config, d.enabled ? 1 : 0, now.toISOString())
    .run();
  return id;
}

export async function updateDestination(
  db: D1Database,
  id: string,
  d: { name?: string; type?: string; config?: string; enabled?: boolean },
): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    binds.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
  }
  if (!sets.length) return (await db.prepare("SELECT 1 FROM alert_destinations WHERE id = ?").bind(id).first()) !== null;
  binds.push(id);
  const r = await db.prepare(`UPDATE alert_destinations SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  return r.meta.changes > 0;
}

export async function deleteDestination(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM alert_destinations WHERE id = ?").bind(id).run();
  return r.meta.changes > 0;
}

/**
 * Record one evaluation: the log row, plus the alert's latest-run columns and,
 * when it fired, the cooldown column for its mode. One batch, so the log and
 * the alert row can't disagree.
 */
export async function recordEvaluation(db: D1Database, e: Evaluation): Promise<void> {
  const at = e.evaluatedAt.toISOString();
  const value = e.value ? JSON.stringify(e.value) : null;
  const stmts = [
    db
      .prepare(
        `INSERT INTO alert_evaluations (alert_id, evaluated_at, mode, status, would_send, sent, value, error, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(e.alertId, at, e.mode, e.status, e.wouldSend ? 1 : 0, e.sent ? 1 : 0, value, e.error, e.durationMs),
    db
      .prepare("UPDATE alerts SET last_run_at = ?, last_status = ?, last_value = ?, last_error = ? WHERE id = ?")
      .bind(at, e.status, value, e.error, e.alertId),
  ];
  const cooldownColumn = e.mode === "live" ? (e.sent ? "last_triggered_at" : null) : e.wouldSend ? "shadow_last_triggered_at" : null;
  if (cooldownColumn) {
    stmts.push(db.prepare(`UPDATE alerts SET ${cooldownColumn} = ? WHERE id = ?`).bind(at, e.alertId));
  }
  await db.batch(stmts);
}

export const EVALUATION_RETENTION_DAYS = 14;

export async function pruneEvaluations(db: D1Database, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - EVALUATION_RETENTION_DAYS * 86_400_000).toISOString();
  await db.prepare("DELETE FROM alert_evaluations WHERE evaluated_at < ?").bind(cutoff).run();
}

/**
 * Take a named lease for `ttlMs`, or return false if someone else holds an
 * unexpired one. One conditional upsert, so two ticks can't both win.
 */
export async function acquireLease(db: D1Database, name: string, holder: string, now: number, ttlMs: number): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO cron_leases (name, holder, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
       WHERE cron_leases.expires_at <= ?`,
    )
    .bind(name, holder, now + ttlMs, now)
    .run();
  return r.meta.changes > 0;
}

export async function releaseLease(db: D1Database, name: string, holder: string): Promise<void> {
  await db.prepare("DELETE FROM cron_leases WHERE name = ? AND holder = ?").bind(name, holder).run();
}
