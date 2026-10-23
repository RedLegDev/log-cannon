// `/v2/api/v1/alerts` and `/v2/api/v1/alert-destinations` (refs #165): v1's
// shapes, validation and scopes, on D1. Reads need `read`; changes need
// `write`. GET also carries each alert's latest evaluation.

import { BasinQueryError, queryBasin, type BasinSqlEnv } from "../basin-sql";
import { ConditionError, evaluateCondition } from "./condition";
import { alertLagSeconds, pinNow } from "./evaluate";
import {
  deleteAlert,
  deleteDestination,
  getAlert,
  insertAlert,
  insertDestination,
  listAlerts,
  listDestinations,
  parseJsonArray,
  updateAlert,
  updateDestination,
  type AlertRow,
  type NormalizedAlert,
} from "./store";

export interface AlertsApiEnv extends BasinSqlEnv {
  KEYS_DB: D1Database;
  ALERT_LAG_SECONDS?: string | number;
}

type Respond = (body: unknown, status?: number) => Response;
type Fail = (error: string, message: string, status: number, extra?: Record<string, unknown>) => Response;

export interface ApiContext {
  env: AlertsApiEnv;
  canWrite: boolean;
  json: Respond;
  error: Fail;
  now: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function alertOut(a: AlertRow) {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    query: a.query,
    condition: a.condition,
    interval_seconds: a.interval_seconds,
    cooldown_seconds: a.cooldown_seconds,
    recipients: parseJsonArray(a.recipients),
    destination_ids: parseJsonArray(a.destination_ids),
    subject: a.subject,
    enabled: Boolean(a.enabled),
    created_at: a.created_at,
    updated_at: a.updated_at,
    last_triggered_at: a.last_triggered_at,
    last_run_at: a.last_run_at,
    last_status: a.last_status,
    last_value: a.last_value ? JSON.parse(a.last_value) : null,
    last_error: a.last_error,
  };
}

function isRead(sql: string): boolean {
  return /^(select|with)\b/i.test(sql.trim());
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function stringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

/**
 * Validate an alert body. `partial` (PATCH) checks only the fields present;
 * otherwise v1's required fields and defaults apply.
 */
export function normalizeAlert(body: Record<string, unknown>, partial: boolean): { alert: NormalizedAlert; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const out: NormalizedAlert = {};
  const has = (k: string) => body[k] !== undefined;

  for (const k of ["name", "query", "condition", "subject"] as const) {
    if (!has(k)) {
      if (!partial) fields[k] = "Required field";
      continue;
    }
    if (typeof body[k] !== "string" || !(body[k] as string).trim()) fields[k] = "Required field";
    else out[k] = body[k] as string;
  }
  if (out.query !== undefined && !isRead(out.query)) fields.query = "Only SELECT (or WITH … SELECT) statements are allowed";
  if (has("description")) {
    if (typeof body.description !== "string") fields.description = "Must be a string";
    else out.description = body.description;
  } else if (!partial) out.description = "";

  const interval = has("interval_seconds") ? body.interval_seconds : partial ? undefined : 60;
  if (interval !== undefined) {
    if (!isInt(interval) || interval < 30) fields.interval_seconds = "Must be an integer >= 30";
    else out.interval_seconds = interval;
  }
  const cooldown = has("cooldown_seconds") ? body.cooldown_seconds : partial ? undefined : 300;
  if (cooldown !== undefined) {
    if (!isInt(cooldown) || cooldown < 0) fields.cooldown_seconds = "Must be an integer >= 0";
    else out.cooldown_seconds = cooldown;
  }
  for (const k of ["recipients", "destination_ids"] as const) {
    if (!has(k)) {
      if (!partial) out[k] = [];
      continue;
    }
    const arr = stringArray(body[k]);
    if (!arr) fields[k] = "Must be an array of strings";
    else out[k] = arr;
  }
  if (!partial && !out.recipients?.length && !out.destination_ids?.length && !fields.recipients && !fields.destination_ids) {
    fields.destination_ids = "At least one destination or recipient is required";
  }
  if (has("enabled")) {
    if (typeof body.enabled !== "boolean") fields.enabled = "Must be a boolean";
    else out.enabled = body.enabled;
  } else if (!partial) out.enabled = true;
  return { alert: out, fields };
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await request.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function handleAlerts(request: Request, sub: string, ctx: ApiContext): Promise<Response> {
  const { env, json, error } = ctx;
  const db = env.KEYS_DB;

  const test = /^\/([^/]+)\/test$/.exec(sub);
  if (test) {
    if (request.method !== "POST") return error("method_not_allowed", "Use POST", 405);
    return testAlert(request, test[1], ctx);
  }
  if (sub !== "") return error("not_found", "Not found", 404);

  if (request.method === "GET") return json({ data: (await listAlerts(db)).map(alertOut) });
  if (!ctx.canWrite) return error("forbidden", "This key lacks the required 'write' scope", 403);

  const body = await readJson(request);
  if (!body) return error("validation_error", "Body must be a JSON object", 400);

  if (request.method === "POST") {
    const { alert, fields } = normalizeAlert(body, false);
    if (body.id !== undefined && (typeof body.id !== "string" || !UUID.test(body.id))) fields.id = "Must be a UUID";
    if (Object.keys(fields).length) return error("validation_error", "Invalid request", 400, { fields });
    if (typeof body.id === "string" && (await getAlert(db, body.id))) {
      return error("conflict", `Alert ${body.id} already exists`, 409);
    }
    const id = await insertAlert(db, { ...(alert as Required<NormalizedAlert>), id: body.id as string | undefined }, ctx.now());
    return json({ success: true, id }, 201);
  }
  if (request.method === "PATCH") {
    if (typeof body.id !== "string" || !body.id) return error("validation_error", "id is required", 400);
    const { id, ...rest } = body;
    const { alert, fields } = normalizeAlert(rest, true);
    if (Object.keys(fields).length) return error("validation_error", "Invalid request", 400, { fields });
    if (!(await updateAlert(db, id as string, alert, ctx.now()))) return error("not_found", `No alert ${id}`, 404);
    return json({ success: true });
  }
  if (request.method === "DELETE") {
    if (typeof body.id !== "string" || !body.id) return error("validation_error", "id is required", 400);
    if (!(await deleteAlert(db, body.id))) return error("not_found", `No alert ${body.id}`, 404);
    return json({ success: true });
  }
  return error("method_not_allowed", "Use GET, POST, PATCH or DELETE", 405);
}

/**
 * Run a query the way the evaluator would: `now()` pinned to now minus the
 * alert lag. With a condition (from the body, else the stored alert's), also
 * report whether it would fire on the first row.
 */
async function testAlert(request: Request, id: string, ctx: ApiContext): Promise<Response> {
  const body = await readJson(request);
  const stored = await getAlert(ctx.env.KEYS_DB, id);
  const query = typeof body?.query === "string" ? body.query : stored?.query;
  if (!query) return ctx.error("validation_error", "query is required", 400);
  if (!isRead(query)) return ctx.error("validation_error", "Only SELECT statements are allowed", 400);
  const condition = typeof body?.condition === "string" ? body.condition : stored?.condition;

  const at = new Date(ctx.now().getTime() - alertLagSeconds(ctx.env.ALERT_LAG_SECONDS) * 1000);
  const sql = pinNow(query, at);
  let rows: Record<string, unknown>[];
  try {
    rows = (await queryBasin(ctx.env, sql)).rows;
  } catch (e) {
    if (e instanceof BasinQueryError) {
      return ctx.error(e.status === 400 ? "query_error" : "upstream_error", e.message, e.status);
    }
    throw e;
  }
  const meta: Record<string, unknown> = { evaluated_as_of: at.toISOString() };
  if (condition) {
    try {
      meta.condition = condition;
      meta.would_fire = rows.length ? evaluateCondition(condition, rows[0]) : null;
      if (!rows.length) meta.condition_error = "query returned no rows";
    } catch (e) {
      meta.would_fire = null;
      meta.condition_error = e instanceof ConditionError ? e.message : String(e);
    }
  }
  return ctx.json({ data: rows, meta });
}

export async function handleDestinations(request: Request, ctx: ApiContext): Promise<Response> {
  const { env, json, error } = ctx;
  const db = env.KEYS_DB;
  if (request.method === "GET") {
    const data = (await listDestinations(db)).map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      config: JSON.parse(d.config || "{}"),
      enabled: Boolean(d.enabled),
      created_at: d.created_at,
    }));
    return json({ data });
  }
  if (!ctx.canWrite) return error("forbidden", "This key lacks the required 'write' scope", 403);
  const body = await readJson(request);
  if (!body) return error("validation_error", "Body must be a JSON object", 400);

  const checkConfig = (type: unknown, config: unknown): string | null => {
    if (!config || typeof config !== "object" || Array.isArray(config)) return "Required field";
    const c = config as Record<string, unknown>;
    if (type === "email" && typeof c.email !== "string") return "Email address is required";
    if (type === "webhook" && typeof c.url !== "string") return "URL is required";
    return null;
  };

  if (request.method === "POST") {
    const fields: Record<string, string> = {};
    if (typeof body.name !== "string" || !body.name) fields.name = "Required field";
    if (body.type !== "email" && body.type !== "webhook") fields.type = "Must be email or webhook";
    const cfgErr = checkConfig(body.type, body.config);
    if (cfgErr) fields.config = cfgErr;
    if (body.id !== undefined && (typeof body.id !== "string" || !UUID.test(body.id))) fields.id = "Must be a UUID";
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") fields.enabled = "Must be a boolean";
    if (Object.keys(fields).length) return error("validation_error", "Invalid request", 400, { fields });
    const id = await insertDestination(
      db,
      {
        id: body.id as string | undefined,
        name: body.name as string,
        type: body.type as string,
        config: JSON.stringify(body.config),
        enabled: body.enabled !== false,
      },
      ctx.now(),
    );
    return json({ success: true, id }, 201);
  }
  if (request.method === "PATCH") {
    if (typeof body.id !== "string" || !body.id) return error("validation_error", "id is required", 400);
    const patch: { name?: string; type?: string; config?: string; enabled?: boolean } = {};
    if (body.name !== undefined) patch.name = String(body.name);
    if (body.type !== undefined) {
      if (body.type !== "email" && body.type !== "webhook") return error("validation_error", "type must be email or webhook", 400);
      patch.type = body.type;
    }
    if (body.config !== undefined) {
      const cfgErr = checkConfig(body.type ?? "", body.config);
      if (cfgErr) return error("validation_error", `config: ${cfgErr}`, 400);
      patch.config = JSON.stringify(body.config);
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return error("validation_error", "enabled must be a boolean", 400);
      patch.enabled = body.enabled;
    }
    if (!(await updateDestination(db, body.id, patch))) return error("not_found", `No destination ${body.id}`, 404);
    return json({ success: true });
  }
  if (request.method === "DELETE") {
    if (typeof body.id !== "string" || !body.id) return error("validation_error", "id is required", 400);
    if (!(await deleteDestination(db, body.id))) return error("not_found", `No destination ${body.id}`, 404);
    return json({ success: true });
  }
  return error("method_not_allowed", "Use GET, POST, PATCH or DELETE", 405);
}
