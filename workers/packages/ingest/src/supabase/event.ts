// Supabase rows onto log_events_v1 (refs #164). A port of supabase-pull's
// event.go, so every alert and saved query keyed on the Source, LogTable,
// ProjectRef and sb_* properties keeps matching, plus the trim that keeps
// function_edge_logs rows under Basin's 2,000-byte json_get limit.

import { computeEventType } from "../parse/go-compat";
import { rowBuilder, setOwn, wellFormed, type LogRow } from "../parse/row";
import type { Row } from "./api";

export interface Project {
  ref: string;
  /** The `source` column and the Source property, which the alerts filter on. */
  source: string;
}

/** `key_id` on pulled rows; no API key sends them. */
export const PULL_KEY_ID = "supabase-pull";

const LEVELS: Record<string, string> = {
  fatal: "Fatal", panic: "Fatal", critical: "Fatal", crit: "Fatal",
  error: "Error", err: "Error",
  warning: "Warning", warn: "Warning",
  info: "Information", log: "Information", notice: "Information",
  debug: "Debug", trace: "Verbose",
};

export function mapLevel(severity: string): string {
  return Object.hasOwn(LEVELS, severity.toLowerCase()) ? LEVELS[severity.toLowerCase()] : "Information";
}

/** Flatten a dotted attribute path (request.path) into a Serilog property
 * name (sb_request_path). */
export function propertyName(key: string): string {
  return "sb_" + key.replace(/[^0-9A-Za-z_]/g, "_").replace(/^_+|_+$/g, "");
}

// function_edge_logs rows carry every request and response header and the
// whole Cloudflare request context, which puts every one of them over 2,000
// bytes (measured 2026-10-23: 2,075–2,647, average 2,571). Dropped: per-request
// edge noise, deployment and JWT bookkeeping, and connecting IPs. Kept: method,
// path, URL, status, function and execution ids, timing, user agent and the
// JWT role (measured after: 784–990, average 919).
const EDGE_DROP_PREFIXES = ["sb_request_cf_", "sb_request_headers_", "sb_response_headers_"];
const EDGE_KEEP = new Set([
  "sb_request_headers_user_agent",
  "sb_response_headers_content_length",
  "sb_response_headers_x_envoy_upstream_service_time",
  "sb_response_headers_sb_error_code",
]);
const EDGE_DROP = new Set([
  "sb_deployment_id",
  "sb_deno_origin",
  ...["signature_prefix", "algorithm", "issuer", "issued_at", "expires_at"].map(
    (k) => `sb_request_sb_jwt_authorization_payload_${k}`,
  ),
]);
const IP_PROPERTY = /(^|_)(ip|x_forwarded_for)$/i;

export function keepEdgeProperty(name: string): boolean {
  if (IP_PROPERTY.test(name)) return false;
  if (EDGE_KEEP.has(name)) return true;
  return !EDGE_DROP.has(name) && !EDGE_DROP_PREFIXES.some((p) => name.startsWith(p));
}

/** Map one Supabase row. Its Basin `id` is its `sb_id`, so a row sent twice
 * shows up as `count(*) > count(DISTINCT id)`. */
export function toRow(p: Project, table: string, r: Row, receivedAt: Date): LogRow {
  const props: Record<string, unknown> = {};
  const edge = table === "function_edge_logs";
  for (const [k, v] of Object.entries(r.attributes)) {
    if (v === null || v === undefined || v === "") continue;
    const name = propertyName(k);
    if (edge && !keepEdgeProperty(name)) continue;
    setOwn(props, name, v);
  }
  // Set after the attributes so nothing in them can shadow the fields the
  // alerts and dedupe depend on.
  props.Source = p.source;
  props.LogTable = table;
  props.ProjectRef = p.ref;
  props.sb_id = r.id;

  const build = rowBuilder({ source: p.source, keyId: PULL_KEY_ID, receivedAt }, "supabase");
  const row = build({
    tsMs: Math.floor(r.tsUs / 1000),
    source: p.source,
    kind: "log",
    level: mapLevel(r.severity),
    message: r.message,
    message_template: "",
    event_type: computeEventType("", r.message),
    exception: "",
    trace_id: null,
    span_id: null,
    parent_span_id: null,
    duration_ms: null,
    properties: props,
  });
  row.id = wellFormed(r.id);
  return row;
}
