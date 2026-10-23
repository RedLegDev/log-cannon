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
  MAX_SEARCH_LIMIT,
  QueryRejected,
  dialectHints,
  getLiveFacts,
  getOverview,
  isOperator,
  prepareQuery,
  searchLogs,
  type PropertyFilter,
} from "./query";
import { queryBasin } from "./basin-sql";
import type { Scope } from "./keys";
import { normalizeAlert } from "./alerts/api";
import { insertAlert, listAlerts, type AlertRow, type NormalizedAlert } from "./alerts/store";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const LEVELS = ["Verbose", "Debug", "Information", "Warning", "Error", "Fatal"] as const;

/** What a tool call needs from the Worker. `createLog` sends through the ingest path. */
export interface McpContext {
  env: BasinSqlEnv & { KEYS_DB: D1Database };
  scopes: Scope[];
  createLog: (entry: CreateLogArgs) => Promise<void>;
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
  source: string;
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
      "Create a log entry in Log Cannon. Use this to record agent activity, task progress, errors, or any structured event. It is queryable within about two minutes.",
    scope: "ingest",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", enum: LEVELS, description: "Log level" },
        message: { type: "string", description: "Log message text" },
        source: { type: "string", description: 'Source/service name (e.g. "my-agent", "build-bot")' },
        message_template: { type: "string", description: "Structured message template with {Placeholder} tokens" },
        exception: { type: "string", description: "Exception/stack trace text" },
        event_type: { type: "string", description: "Event type id. Computed from the template if omitted." },
        properties: { type: "object", description: "Structured properties as key-value pairs" },
      },
      required: ["level", "message", "source"],
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
          source: str(args, "source", true)!,
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
      "Search log events by source, level, message text, trace id and property filters, newest first. Last 24 hours by default (hours, max 720). Up to 1000 results.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Filter by source/service name" },
        level: { type: "string", description: "Filter by level (Error, Warning, Information, Debug)" },
        search: { type: "string", description: "Substring of the message (literal, case-sensitive)" },
        trace_id: { type: "string", description: "Filter by trace id" },
        hours: { type: "number", minimum: 1, maximum: 720, description: "Look-back window in hours (default 24)" },
        limit: { type: "number", minimum: 1, maximum: MAX_SEARCH_LIMIT, description: "Max results (default 100)" },
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
      },
    },
    run: async (args, ctx) => {
      const filters: PropertyFilter[] = [];
      const raw = args.property_filters;
      if (raw !== undefined) {
        if (!Array.isArray(raw)) throw new InvalidParams("property_filters must be an array");
        for (const f of raw as Record<string, unknown>[]) {
          const op = f?.operator ?? "=";
          if (typeof f?.key !== "string" || typeof f?.value !== "string" || !isOperator(op)) {
            throw new InvalidParams("each property filter needs string key and value, and a valid operator");
          }
          filters.push({ key: f.key, value: f.value, operator: op });
        }
      }
      const num = (k: string) => (typeof args[k] === "number" ? (args[k] as number) : undefined);
      try {
        return json(
          await searchLogs(ctx.env, {
            source: str(args, "source"),
            level: str(args, "level"),
            search: str(args, "search"),
            traceId: str(args, "trace_id"),
            hours: num("hours"),
            limit: num("limit"),
            propertyFilters: filters,
          }),
        );
      } catch (e) {
        return queryFailure("Failed to search logs", e);
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
