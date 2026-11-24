// --- MCP over Streamable HTTP, stateless, JSON responses only (refs #163) ---
//
// Hand-rolled instead of pulling the MCP SDK into the ingest Worker: the
// server only exposes tools, holds no session, and never streams, so the
// protocol surface is initialize / ping / tools/list / tools/call. Tools are
// registered by key scope, as in v1. The alert tools read and write the D1
// alerts that the cron evaluator runs (refs #165).

import type { BasinSqlEnv } from "./basin-sql";
import { BasinQueryError } from "./basin-sql";
import { API_DOCS, LOGGER_DOCS, OVERVIEW_DOCS } from "./docs";
import {
  MAX_CONTEXT_LIMIT,
  MAX_CONTEXT_MINUTES,
  MAX_GROUP_BY,
  MAX_SEARCH_HOURS,
  MAX_SEARCH_LIMIT,
  MAX_SOURCES,
  MAX_STATS_LIMIT,
  QueryRejected,
  dialectHints,
  getEvent,
  getLiveFacts,
  getOverview,
  getStats,
  isOperator,
  prepareQuery,
  searchLogs,
  type FilterParams,
  type PropertyFilter,
} from "./query";
import { queryBasin } from "./basin-sql";
import type { Scope } from "./keys";
import { handleAlerts, handleFirings, normalizeAlert, type ApiContext } from "./alerts/api";
import { insertAlert, listAlerts, type AlertRow, type NormalizedAlert } from "./alerts/store";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const LEVELS = ["Verbose", "Debug", "Information", "Warning", "Error", "Fatal"] as const;

/** What a tool call needs from the Worker. `createLog` sends through the ingest path. */
export interface McpContext {
  env: BasinSqlEnv & { KEYS_DB: D1Database };
  scopes: Scope[];
  createLog: (entry: CreateLogArgs) => Promise<void>;
  /** The REST alerts context for this key; the alert tools run its handlers (refs #193). */
  alertsApi: ApiContext;
  now?: () => Date;
}

/**
 * Alerts triggered within their cooldown, newest first: v1's definition of
 * firing, for the live cooldown and (while v2 runs in shadow) the shadow one.
 */
export function firingAlerts(alerts: AlertRow[], now: Date, column: "last_triggered_at" | "shadow_last_triggered_at") {
  return alerts
    .filter((a) => a.enabled && a[column] && now.getTime() - Date.parse(a[column]!) < a.cooldown_seconds * 1000)
    .sort((a, b) => Date.parse(b[column]!) - Date.parse(a[column]!))
    .map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      last_triggered_at: a[column],
      minutes_ago: Math.floor((now.getTime() - Date.parse(a[column]!)) / 60_000),
    }));
}

export interface CreateLogArgs {
  level: (typeof LEVELS)[number];
  message: string;
  message_template?: string;
  exception?: string;
  event_type?: string;
  properties?: Record<string, unknown>;
}

interface Tool {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: McpContext) => Promise<ToolResult>;
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

class InvalidParams extends Error {}

const json = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});

/** JSON-RPC batches were dropped from MCP in 2025-06-18; kept for older clients, but bounded. */
export const MAX_BATCH = 10;
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function str(args: Record<string, unknown>, k: string, required = false): string | undefined {
  const v = args[k];
  if (v === undefined || v === null) {
    if (required) throw new InvalidParams(`${k} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new InvalidParams(`${k} must be a string`);
  return v;
}

function num(args: Record<string, unknown>, k: string): number | undefined {
  return typeof args[k] === "number" ? (args[k] as number) : undefined;
}

/** `from` / `to` / `ts`: an ISO 8601 string or epoch milliseconds. */
function instant(args: Record<string, unknown>, k: string): string | number | undefined {
  const v = args[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" && typeof v !== "number") throw new InvalidParams(`${k} must be an ISO 8601 string or epoch milliseconds`);
  return v;
}

function propertyFilters(args: Record<string, unknown>): PropertyFilter[] {
  const filters: PropertyFilter[] = [];
  const raw = args.property_filters;
  if (raw === undefined) return filters;
  if (!Array.isArray(raw)) throw new InvalidParams("property_filters must be an array");
  for (const f of raw as Record<string, unknown>[]) {
    const op = f?.operator ?? "=";
    if (typeof f?.key !== "string" || typeof f?.value !== "string" || !isOperator(op)) {
      throw new InvalidParams("each property filter needs string key and value, and a valid operator");
    }
    filters.push({ key: f.key, value: f.value, operator: op });
  }
  return filters;
}

/** A source name, or an array of them. */
function sources(args: Record<string, unknown>): string | string[] | undefined {
  const v = args.source;
  if (Array.isArray(v)) {
    if (!v.every((s) => typeof s === "string")) throw new InvalidParams("source must be a string or an array of strings");
    return v as string[];
  }
  return str(args, "source");
}

/** The filters search_logs and log_stats share. */
function filterArgs(args: Record<string, unknown>): FilterParams {
  return {
    source: sources(args),
    level: str(args, "level"),
    search: str(args, "search"),
    exception: str(args, "exception"),
    traceId: str(args, "trace_id"),
    hours: num(args, "hours"),
    from: instant(args, "from"),
    to: instant(args, "to"),
    propertyFilters: propertyFilters(args),
  };
}

const TIME_VALUE = { type: ["string", "number"] };

const FILTER_SCHEMA = {
  source: {
    anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: MAX_SOURCES }],
    description: "Source/service name, or an array of up to 20 (matches any)",
  },
  level: { type: "string", description: "Filter by level (Error, Warning, Information, Debug)" },
  search: { type: "string", description: "Substring of the message (literal, case-sensitive)" },
  exception: { type: "string", description: "Substring of the exception text (literal, case-sensitive)" },
  trace_id: { type: "string", description: "Filter by trace id" },
  hours: { type: "number", minimum: 1, maximum: MAX_SEARCH_HOURS, description: "Look-back window in hours (default 24)" },
  from: { ...TIME_VALUE, description: "Window start, ISO 8601 or epoch ms. Overrides hours" },
  to: { ...TIME_VALUE, description: "Window end (exclusive), ISO 8601 or epoch ms. Default now. Window max 720 hours" },
  property_filters: {
    type: "array",
    description: "Filter by structured properties",
    items: {
      type: "object",
      properties: {
        key: { type: "string", description: "Property key; dot paths for nesting (metrics.latency)" },
        value: { type: "string", description: "Value to compare against" },
        operator: { type: "string", enum: ["=", "!=", ">", ">=", "<", "<="], description: "Default =" },
      },
      required: ["key", "value"],
    },
  },
};

function queryFailure(prefix: string, e: unknown, sql?: string): ToolResult {
  if (e instanceof BasinQueryError || e instanceof QueryRejected) {
    const hints = sql && e instanceof BasinQueryError && e.status === 400 ? dialectHints(sql) : [];
    return fail(`${prefix}: ${e.message}${hints.length ? `\nThis looks like ClickHouse SQL. Basin SQL is DataFusion:\n- ${hints.join("\n- ")}` : ""}`);
  }
  return fail(`${prefix}: ${e instanceof Error ? e.message : String(e)}`);
}

export const TOOLS: Tool[] = [
  {
    name: "create_log",
    title: "Create Log Entry",
    description:
      "Create a log entry in Log Cannon. Use this to record agent activity, task progress, errors, or any structured event. It is queryable within about two minutes. The entry's source is the calling API key's name, as on /ingest/clef; a source argument is ignored.",
    scope: "ingest",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", enum: LEVELS, description: "Log level" },
        message: { type: "string", description: "Log message text" },
        message_template: { type: "string", description: "Structured message template with {Placeholder} tokens" },
        exception: { type: "string", description: "Exception/stack trace text" },
        event_type: { type: "string", description: "Event type id. Computed from the template if omitted." },
        properties: { type: "object", description: "Structured properties as key-value pairs" },
      },
      required: ["level", "message"],
    },
    run: async (args, ctx) => {
      const level = str(args, "level", true)!;
      if (!(LEVELS as readonly string[]).includes(level)) throw new InvalidParams(`level must be one of ${LEVELS.join(", ")}`);
      const props = args.properties;
      if (props !== undefined && (props === null || typeof props !== "object" || Array.isArray(props))) {
        throw new InvalidParams("properties must be an object");
      }
      try {
        await ctx.createLog({
          level: level as CreateLogArgs["level"],
          message: str(args, "message", true)!,
          message_template: str(args, "message_template"),
          exception: str(args, "exception"),
          event_type: str(args, "event_type"),
          properties: props as Record<string, unknown> | undefined,
        });
        return json({ success: true, message: "Log entry created" });
      } catch (e) {
        return fail(`Failed to create log entry: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  {
    name: "search_logs",
    title: "Search Logs",
    description:
      "Search log events by source, level, message or exception text, trace id and property filters. Last 24 hours by default, or a from/to window. Newest first (order asc for oldest first). Up to 1000 per page; pass meta.next_cursor back as cursor for the next page.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        ...FILTER_SCHEMA,
        order: { type: "string", enum: ["desc", "asc"], description: "Default desc" },
        cursor: { type: "string", description: "meta.next_cursor from the previous page, same filters and order" },
        limit: { type: "number", minimum: 1, maximum: MAX_SEARCH_LIMIT, description: "Max results (default 100)" },
      },
    },
    run: async (args, ctx) => {
      const params = { ...filterArgs(args), order: str(args, "order"), cursor: str(args, "cursor"), limit: num(args, "limit") };
      try {
        return json(await searchLogs(ctx.env, params));
      } catch (e) {
        return queryFailure("Failed to search logs", e);
      }
    },
  },
  {
    name: "log_stats",
    title: "Log Stats",
    description:
      "Count log events, grouped and optionally time-bucketed, with the same filters as search_logs. Each row has the group keys, bucket, count and unique (distinct ids). E.g. group_by [\"level\"], bucket \"hour\".",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        ...FILTER_SCHEMA,
        group_by: {
          type: "array",
          maxItems: MAX_GROUP_BY,
          items: { type: "string" },
          description: "Up to 2 of source, level, message_template, event_type, prop:<key> (dot paths allowed)",
        },
        bucket: { type: "string", enum: ["minute", "5m", "15m", "hour", "day"], description: "Time bucket; omit for none" },
        limit: { type: "number", minimum: 1, maximum: MAX_STATS_LIMIT, description: "Max rows (default 100), ordered by bucket then count desc" },
      },
    },
    run: async (args, ctx) => {
      const groupBy = args.group_by;
      if (groupBy !== undefined && (!Array.isArray(groupBy) || !groupBy.every((g) => typeof g === "string"))) {
        throw new InvalidParams("group_by must be an array of strings");
      }
      try {
        return json(
          await getStats(ctx.env, { ...filterArgs(args), groupBy: groupBy as string[] | undefined, bucket: str(args, "bucket"), limit: num(args, "limit") }),
        );
      } catch (e) {
        return queryFailure("Failed to get stats", e);
      }
    },
  },
  {
    name: "get_event",
    title: "Get Event",
    description:
      "Fetch one log event by id, optionally with the rows around it from the same source or trace (context). Pass ts if known; otherwise it looks back hours (default 24).",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Event id" },
        ts: { ...TIME_VALUE, description: "The event's time if known (ISO 8601 or epoch ms); searches ±10 minutes around it" },
        hours: { type: "number", minimum: 1, maximum: MAX_SEARCH_HOURS, description: "Look-back without ts (default 24)" },
        context: { type: "string", enum: ["source", "trace"], description: "Also return surrounding rows from the same source or trace" },
        before_minutes: { type: "number", minimum: 0, maximum: MAX_CONTEXT_MINUTES, description: "Context before the event (default 5)" },
        after_minutes: { type: "number", minimum: 0, maximum: MAX_CONTEXT_MINUTES, description: "Context after the event (default 1)" },
        limit: { type: "number", minimum: 1, maximum: MAX_CONTEXT_LIMIT, description: "Max context rows (default 200)" },
      },
      required: ["id"],
    },
    run: async (args, ctx) => {
      const id = str(args, "id", true)!;
      try {
        const result = await getEvent(ctx.env, {
          id,
          ts: instant(args, "ts"),
          hours: num(args, "hours"),
          context: str(args, "context"),
          beforeMinutes: num(args, "before_minutes"),
          afterMinutes: num(args, "after_minutes"),
          limit: num(args, "limit"),
        });
        return result ? json(result) : fail(`No event with id ${id} in the window searched`);
      } catch (e) {
        return queryFailure("Failed to get event", e);
      }
    },
  },
  {
    name: "execute_query",
    title: "Execute SQL Query",
    description:
      "Run a read-only SQL query against Basin (Apache DataFusion SQL, not ClickHouse). Table logs.events: id, ts, received_at, source, key_id, format, kind, level, message, message_template, event_type, exception, trace_id, span_id, parent_span_id, duration_ms, properties (JSON text). " +
      "Use count(*) FILTER (WHERE …), date_trunc('hour', ts), now() - INTERVAL '1 hour'. json_get_str fails the whole query on properties over 2000 bytes: wrap it in CASE WHEN octet_length(properties) <= 2000. Data is 1-2 minutes behind. Max 10,000 rows, 30 s. Call get_docs overview for the full guide.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: { sql: { type: "string", description: "SELECT query" } },
      required: ["sql"],
    },
    run: async (args, ctx) => {
      const sql = str(args, "sql", true)!;
      try {
        const start = Date.now();
        const { rows, bytesScanned } = await queryBasin(ctx.env, prepareQuery(sql));
        return json({ data: rows, meta: { rows: rows.length, elapsed_ms: Date.now() - start, bytes_scanned: bytesScanned } });
      } catch (e) {
        return queryFailure("Query failed", e, sql);
      }
    },
  },
  {
    name: "get_overview",
    title: "Get Overview",
    description:
      "Investigation starter for the last 24 hours: volume, error rate, active sources, per-source counts and the top error/warning templates. Start here.",
    scope: "read",
    inputSchema: { type: "object", properties: {} },
    run: async (_args, ctx) => {
      try {
        return json(await getOverview(ctx.env));
      } catch (e) {
        return queryFailure("Failed to get overview", e);
      }
    },
  },
  {
    name: "get_firing_alerts",
    title: "Get Firing Alerts",
    description:
      "Alert rules triggered within their cooldown period: a quick way to see active incidents. shadow_firing lists what the v2 evaluator would have sent while it runs in shadow mode.",
    scope: "read",
    inputSchema: { type: "object", properties: {} },
    run: async (_args, ctx) => {
      try {
        const now = (ctx.now ?? (() => new Date()))();
        const alerts = await listAlerts(ctx.env.KEYS_DB);
        const data = firingAlerts(alerts, now, "last_triggered_at");
        return json({ data, firing_count: data.length, shadow_firing: firingAlerts(alerts, now, "shadow_last_triggered_at") });
      } catch (e) {
        return fail(`Failed to get firing alerts: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  {
    name: "create_alert",
    title: "Create Alert",
    description:
      "Create a threshold alert rule, evaluated every interval against Basin. The query is Basin SQL (DataFusion) and must return one row of numbers; now() in it is the evaluation time minus about 3 minutes of ingest lag. The condition compares columns of that first row (e.g. \"cnt > 50\", \"errors >= 100 && total > 1000\"). Use destination_ids to assign reusable notification targets.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Alert name" },
        description: { type: "string", description: "Alert description" },
        query: { type: "string", description: "SELECT returning one row of values for the condition" },
        condition: { type: "string", description: 'Condition expression, e.g. "cnt > 50"' },
        interval_seconds: { type: "integer", minimum: 30, description: "Check interval in seconds (min 30, default 60; evaluated at most once a minute)" },
        cooldown_seconds: { type: "integer", minimum: 0, description: "Min seconds between repeated alerts (default 300)" },
        destination_ids: { type: "array", items: { type: "string" }, description: "Alert destination ids to notify (preferred over recipients)" },
        recipients: { type: "array", items: { type: "string" }, description: "Email addresses to notify (legacy; use destination_ids)" },
        subject: { type: "string", description: "Email subject line" },
      },
      required: ["name", "query", "condition", "subject"],
    },
    run: async (args, ctx) => {
      const { alert, fields } = normalizeAlert(args, false);
      if (Object.keys(fields).length) {
        throw new InvalidParams(Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("; "));
      }
      try {
        const id = await insertAlert(ctx.env.KEYS_DB, alert as Required<NormalizedAlert>, (ctx.now ?? (() => new Date()))());
        return json({ success: true, id });
      } catch (e) {
        return fail(`Failed to create alert: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  // list_alerts, get_alert_history, update_alert and test_alert run the REST
  // handlers themselves (refs #193), so validation, scope checks and the
  // response shapes are REST's. A 400 is invalid params, as for create_alert.
  {
    name: "list_alerts",
    title: "List Alerts",
    description:
      "List every alert rule with its query, condition, interval, cooldown, destination ids, enabled flag and latest evaluation (last_status: ok, triggered, cooldown or error), plus queries_per_day and est_usd_per_month, the Basin SQL cost of running it at its interval. While alert batching is on, a batchable alert's figures are its marginal share of a batch (a tenth of a query per run); an alert that runs alone pays a full query. Same as GET /api/v1/alerts.",
    scope: "read",
    inputSchema: { type: "object", properties: {} },
    run: async (_args, ctx) => restResult(await handleAlerts(alertsRequest("GET"), "", ctx.alertsApi), "Failed to list alerts"),
  },
  {
    name: "get_alert_history",
    title: "Get Alert History",
    description:
      "Alert firing history, newest first: each live evaluation whose condition was true, with the evaluated values, outcome (delivered, cooldown or failed), the destinations tried and any delivery error. Kept 90 days; shadow mode records none. Omit alert_id for every alert.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: { type: "string", description: "One alert's id; omit for all alerts" },
        from: { type: "string", description: "Earliest fired_at, ISO 8601 or epoch milliseconds (inclusive)" },
        to: { type: "string", description: "Latest fired_at, ISO 8601 or epoch milliseconds (inclusive)" },
        limit: { type: "number", minimum: 1, maximum: 1000, description: "Max rows (default 100, max 1000)" },
      },
    },
    run: async (args, ctx) => {
      const params = new URLSearchParams();
      for (const k of ["from", "to", "limit"]) {
        const v = args[k];
        if (v === undefined || v === null) continue;
        if (typeof v !== "string" && typeof v !== "number") throw new InvalidParams(`${k} must be a string or number`);
        params.set(k, String(v));
      }
      const alertId = str(args, "alert_id") ?? null;
      return restResult(await handleFirings(alertsRequest("GET", undefined, params), alertId, ctx.alertsApi), "Failed to get alert history");
    },
  },
  {
    name: "update_alert",
    title: "Update Alert",
    description:
      "Change an alert rule: pass its id and only the fields to change (name, description, query, condition, interval_seconds, cooldown_seconds, destination_ids, recipients, subject, enabled). enabled: false disables it without deleting it. Same as PATCH /api/v1/alerts.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Alert id" },
        name: { type: "string" },
        description: { type: "string" },
        query: { type: "string", description: "SELECT returning one row of values for the condition" },
        condition: { type: "string", description: 'Condition expression, e.g. "cnt > 50"' },
        interval_seconds: { type: "integer", minimum: 30 },
        cooldown_seconds: { type: "integer", minimum: 0 },
        destination_ids: { type: "array", items: { type: "string" } },
        recipients: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        enabled: { type: "boolean", description: "false disables the alert; true re-enables it" },
      },
      required: ["id"],
    },
    run: async (args, ctx) => {
      str(args, "id", true);
      return restResult(await handleAlerts(alertsRequest("PATCH", args), "", ctx.alertsApi), "Failed to update alert");
    },
  },
  {
    name: "test_alert",
    title: "Test Alert",
    description:
      "Run an alert's query exactly as the evaluator would (now() pinned back by the ingest lag) and report the rows and whether the condition would fire. query and condition override the stored ones for a dry run. deliver: true (write scope) also sends to the alert's destinations without starting its cooldown. Same as POST /api/v1/alerts/:id/test.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Alert id" },
        query: { type: "string", description: "Query to try instead of the stored one" },
        condition: { type: "string", description: "Condition to try instead of the stored one" },
        deliver: { type: "boolean", description: "Also send through the alert's destinations (write scope)" },
      },
      required: ["id"],
    },
    run: async (args, ctx) => {
      const id = str(args, "id", true)!;
      const { id: _id, ...body } = args;
      return restResult(await handleAlerts(alertsRequest("POST", body), `/${id}/test`, ctx.alertsApi), "Failed to test alert");
    },
  },
  {
    name: "get_docs",
    title: "Get Documentation",
    description:
      'Log Cannon documentation. "overview": schema, Basin SQL dialect and gotchas, plus live sources, levels and property keys. "api": REST reference. "logger": CLEF logger integration.',
    scope: "read",
    inputSchema: {
      type: "object",
      properties: { section: { type: "string", enum: ["overview", "api", "logger"] } },
      required: ["section"],
    },
    run: async (args, ctx) => {
      const section = str(args, "section", true);
      if (section === "api") return { content: [{ type: "text", text: API_DOCS }] };
      if (section === "logger") return { content: [{ type: "text", text: LOGGER_DOCS }] };
      if (section !== "overview") throw new InvalidParams("section must be overview, api or logger");
      try {
        const live = await getLiveFacts(ctx.env);
        const text =
          OVERVIEW_DOCS +
          `\n## Live data\n\n### Sources (last 24 hours)\n${live.sources.map((s) => `- ${s}`).join("\n") || "- none"}\n` +
          `\n### Levels\n${live.levels.map((l) => `- ${l}`).join("\n") || "- none"}\n` +
          `\n### Property keys (last hour, sampled)\n${live.propertyKeys.map((p) => `- **${p.key}**: e.g. "${p.sampleValue}"`).join("\n") || "- none"}\n`;
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return queryFailure("Failed to get documentation", e);
      }
    },
  },
];

/** A Request for an alerts REST handler called from a tool; only method, body and query are read. */
function alertsRequest(method: string, body?: Record<string, unknown>, params?: URLSearchParams): Request {
  const qs = params?.toString();
  return new Request(`https://mcp.invalid/api/v1/alerts${qs ? `?${qs}` : ""}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A REST handler's answer as a tool result: 2xx is the body, 400 invalid params, anything else a tool error. */
async function restResult(res: Response, prefix: string): Promise<ToolResult> {
  const body = (await res.json().catch(() => null)) as { message?: string; fields?: Record<string, string> } | null;
  if (res.ok) return json(body);
  const detail = body?.fields ? Object.entries(body.fields).map(([k, v]) => `${k}: ${v}`).join("; ") : "";
  const message = detail || body?.message || `status ${res.status}`;
  if (res.status === 400) throw new InvalidParams(message);
  return fail(`${prefix}: ${message}`);
}

const SCOPE_RANK: Record<Scope, number> = { ingest: 0, read: 1, write: 2, admin: 3 };

export function toolsFor(scopes: Scope[]): Tool[] {
  const best = Math.max(-1, ...scopes.map((s) => SCOPE_RANK[s] ?? -1));
  return TOOLS.filter((t) => SCOPE_RANK[t.scope] <= best);
}

// --- JSON-RPC ---

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type RpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

const rpcError = (id: RpcRequest["id"], code: number, message: string): RpcResponse => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

async function dispatch(req: RpcRequest, ctx: McpContext): Promise<RpcResponse | null> {
  if (!req || typeof req !== "object" || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return rpcError(req?.id, -32600, "Invalid Request");
  }
  // Notifications (no id) get no response, and only `notifications/*`
  // means anything as one: a tools/call without an id isn't run.
  const isNotification = req.id === undefined;
  if (isNotification) return null;
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize": {
      const asked = req.params?.protocolVersion;
      const protocolVersion =
        typeof asked === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "log-cannon", version: "2.0.0" },
          instructions: "Log Cannon v2 on Basin. Call get_docs with section overview before writing SQL: the dialect is DataFusion, not ClickHouse.",
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: toolsFor(ctx.scopes).map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })),
        },
      };
    case "tools/call": {
      const name = req.params?.name;
      const tool = toolsFor(ctx.scopes).find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
      const args = req.params?.arguments ?? {};
      if (typeof args !== "object" || Array.isArray(args)) return rpcError(id, -32602, "arguments must be an object");
      try {
        return { jsonrpc: "2.0", id, result: await tool.run(args as Record<string, unknown>, ctx) };
      } catch (e) {
        if (e instanceof InvalidParams) return rpcError(id, -32602, e.message);
        return { jsonrpc: "2.0", id, result: fail(`${tool.name} failed: ${e instanceof Error ? e.message : String(e)}`) };
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${req.method}`);
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export async function handleMcp(request: Request, ctx: McpContext): Promise<Response> {
  if (request.method === "GET") {
    return new Response(JSON.stringify(rpcError(null, -32000, "Method Not Allowed. Use POST for MCP requests.")), {
      status: 405,
      headers: { ...JSON_HEADERS, Allow: "POST" },
    });
  }
  if (request.method === "DELETE") {
    return new Response(JSON.stringify(rpcError(null, -32000, "Session management not supported in stateless mode.")), {
      status: 405,
      headers: { ...JSON_HEADERS, Allow: "POST" },
    });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, "Parse error")), { status: 400, headers: JSON_HEADERS });
  }

  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > MAX_BATCH) {
      return new Response(JSON.stringify(rpcError(null, -32600, "Invalid Request")), { status: 400, headers: JSON_HEADERS });
    }
    const out = (await Promise.all(body.map((r) => dispatch(r as RpcRequest, ctx)))).filter((r) => r !== null);
    return out.length ? new Response(JSON.stringify(out), { headers: JSON_HEADERS }) : new Response(null, { status: 202 });
  }
  const out = await dispatch(body as RpcRequest, ctx);
  return out ? new Response(JSON.stringify(out), { headers: JSON_HEADERS }) : new Response(null, { status: 202 });
}
