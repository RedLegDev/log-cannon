import type { RowFields } from "./row";
import {
  computeEventType,
  goJSON,
  goParseFloat,
  nanosToMs,
  parseRFC3339,
  renderMessageTemplate,
  truncToBigInt,
} from "./go-compat";
import {
  nestingExceeds,
  ParseError,
  rowBuilder,
  setOwn,
  type LogRow,
  type ParseContext,
  type ParseResult,
} from "./row";

/** How an arbitrary JSON object maps onto a row. Port of webhook.go. */
export interface WebhookPreset {
  timestampField?: string;
  timestampFormat?: "auto" | "rfc3339" | "unix" | "unixnano";
  levelField?: string;
  levelDefault?: string;
  levelFromStatus?: boolean;
  statusField?: string;
  messageTemplate?: string;
  sourceField?: string;
  eventTypeField?: string;
  excludeFields?: string[];
}

const COMMON_TIMESTAMP_FIELDS = [
  "timestamp", "time", "@timestamp", "@t", "ts", "date", "datetime", "created_at",
];

const COMMON_LEVEL_FIELDS = ["level", "severity", "@l", "log_level", "loglevel"];

const BUILTIN_PRESETS: Record<string, WebhookPreset> = {
  cloudflare: {
    timestampField: "EdgeStartTimestamp",
    timestampFormat: "unixnano",
    levelFromStatus: true,
    statusField: "EdgeResponseStatus",
    messageTemplate:
      "{ClientRequestMethod} {ClientRequestHost}{ClientRequestURI} → {EdgeResponseStatus}",
    sourceField: "ClientRequestHost",
  },
};

const DEFAULT_PRESET: WebhookPreset = { timestampFormat: "auto", levelDefault: "Information" };

/** Preset by name, case-insensitive; unknown or empty names get the default. */
export function getPreset(name: string | undefined | null): WebhookPreset {
  if (!name) return DEFAULT_PRESET;
  return Object.hasOwn(BUILTIN_PRESETS, name.toLowerCase())
    ? BUILTIN_PRESETS[name.toLowerCase()]
    : DEFAULT_PRESET;
}

type Raw = Record<string, unknown>;

/**
 * Accepts a JSON array (compact or pretty-printed), NDJSON, or a single object
 * on one line. Elements/lines that aren't objects are skipped; the body is
 * rejected only when that leaves nothing.
 *
 * A `null` element or line becomes an empty event, as it did in Go.
 */
export function parseWebhook(
  body: string,
  ctx: ParseContext,
  presetName?: string | null,
): ParseResult {
  const preset = getPreset(presetName);
  const build = rowBuilder(ctx, "webhook");
  const trimmed = body.trim();
  if (!trimmed) return { rows: [], skipped: 0 };
  return trimmed[0] === "["
    ? parseArray(trimmed, ctx, preset, build)
    : parseNDJSON(trimmed, ctx, preset, build);
}

type Build = (f: RowFields) => LogRow;

/** Decode as Go's map[string]interface{} did, then map to a row. Go accepted
 * `null` as a nil map: an event whose message is "null" and that has no
 * properties. Anything that isn't an object, nests too deeply, or fails to map
 * is skipped (undefined), so it can never take its siblings down with it. */
function toRow(v: unknown, preset: WebhookPreset, ctx: ParseContext, build: Build): LogRow | undefined {
  try {
    if (v === null) return mapWebhookEvent({}, preset, ctx, build, true);
    if (typeof v !== "object" || Array.isArray(v) || nestingExceeds(v)) return undefined;
    return mapWebhookEvent(v as Raw, preset, ctx, build);
  } catch {
    return undefined;
  }
}

function parseArray(body: string, ctx: ParseContext, preset: WebhookPreset, build: Build): ParseResult {
  let items: unknown;
  try {
    items = JSON.parse(body);
  } catch (err) {
    throw new ParseError(`invalid JSON array: ${(err as Error).message}`);
  }
  if (!Array.isArray(items)) throw new ParseError("invalid JSON array");
  const rows: LogRow[] = [];
  let skipped = 0;
  for (const item of items) {
    const row = toRow(item, preset, ctx, build);
    if (row) rows.push(row);
    else skipped++;
  }
  if (rows.length === 0 && items.length > 0) {
    throw new ParseError(
      `webhook array produced 0 events (${items.length} elements, ${skipped} skipped)`,
    );
  }
  return { rows, skipped };
}

function parseNDJSON(body: string, ctx: ParseContext, preset: WebhookPreset, build: Build): ParseResult {
  const rows: LogRow[] = [];
  let skipped = 0;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    const row = toRow(value, preset, ctx, build);
    if (row) rows.push(row);
    else skipped++;
  }
  if (rows.length === 0 && skipped > 0) {
    throw new ParseError(`webhook NDJSON produced 0 events (${skipped} malformed lines)`);
  }
  return { rows, skipped };
}

export function levelFromHTTPStatus(status: number): string {
  if (status >= 500) return "Error";
  if (status >= 400) return "Warning";
  return "Information";
}

function toFloat64(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") return goParseFloat(v);
  return null;
}

/** time.Unix(sec, nsec) for a float of seconds, at ms precision. */
function unixSecondsToMs(f: number): number {
  const sec = Math.trunc(f);
  const nsec = Math.trunc((f - sec) * 1e9);
  return nanosToMs(BigInt(sec) * 1_000_000_000n + BigInt(nsec));
}

/** Epoch ms for a number whose unit is guessed from its magnitude. */
function detectNumericTimestamp(f: number): number {
  const abs = Math.abs(f);
  if (abs > 1e18) return nanosToMs(truncToBigInt(f));
  if (abs > 1e15) return nanosToMs(truncToBigInt(f) * 1_000n);
  if (abs > 1e12) return nanosToMs(truncToBigInt(f) * 1_000_000n);
  return unixSecondsToMs(f);
}

/** Event time in epoch ms, or null for "use now". Out-of-range values are
 * the row builder's to clamp. */
function parseWebhookTimestamp(raw: Raw, preset: WebhookPreset): number | null {
  let field = preset.timestampField ?? "";
  if (!field) field = COMMON_TIMESTAMP_FIELDS.find((f) => Object.hasOwn(raw, f)) ?? "";
  if (!field || !Object.hasOwn(raw, field)) return null;
  const val = raw[field];

  // Non-finite numbers came out of Go as garbage times; v2 uses now instead.
  const finite = (f: number | null) => (f !== null && Number.isFinite(f) ? f : null);

  switch (preset.timestampFormat || "auto") {
    case "rfc3339":
      return typeof val === "string" ? parseRFC3339(val) : null;
    case "unix": {
      const f = finite(toFloat64(val));
      return f === null ? null : unixSecondsToMs(f);
    }
    case "unixnano": {
      const f = finite(toFloat64(val));
      return f === null ? null : nanosToMs(truncToBigInt(f));
    }
    default: {
      if (typeof val === "string") {
        const t = parseRFC3339(val);
        if (t !== null) return t;
      }
      const f = finite(toFloat64(val));
      return f === null ? null : detectNumericTimestamp(f);
    }
  }
}

function buildExcludeSet(preset: WebhookPreset): Set<string> {
  const set = new Set<string>(preset.excludeFields ?? []);
  for (const f of [
    preset.timestampField,
    preset.levelField,
    preset.sourceField,
    preset.eventTypeField,
    preset.statusField,
  ]) {
    if (f) set.add(f);
  }
  return set;
}

export function mapWebhookEvent(
  raw: Raw,
  preset: WebhookPreset,
  ctx: ParseContext,
  build: Build = rowBuilder(ctx, "webhook"),
  fromNull = false,
): LogRow {
  const now = ctx.receivedAt.getTime();
  let ts = parseWebhookTimestamp(raw, preset) ?? now;
  if (ts > now) ts = now;

  let level = preset.levelDefault || "Information";
  const levelFields = preset.levelField ? [preset.levelField] : COMMON_LEVEL_FIELDS;
  for (const f of levelFields) {
    const l = raw[f];
    if (Object.hasOwn(raw, f) && typeof l === "string" && l) {
      level = l;
      break;
    }
  }

  if (preset.levelFromStatus && preset.statusField && Object.hasOwn(raw, preset.statusField)) {
    const status = toFloat64(raw[preset.statusField]);
    if (status !== null) level = levelFromHTTPStatus(Math.trunc(status));
  }

  let source = ctx.source;
  if (preset.sourceField) {
    const s = raw[preset.sourceField];
    if (Object.hasOwn(raw, preset.sourceField) && typeof s === "string" && s) source = s;
  }

  let eventType = "";
  if (preset.eventTypeField) {
    const et = raw[preset.eventTypeField];
    if (Object.hasOwn(raw, preset.eventTypeField) && typeof et === "string") eventType = et;
  }

  const messageTemplate = preset.messageTemplate ?? "";
  const message = messageTemplate
    ? renderMessageTemplate(messageTemplate, raw)
    : fromNull
      ? "null"
      : goJSON(raw);
  if (!eventType) eventType = computeEventType(messageTemplate, message);

  const excluded = buildExcludeSet(preset);
  const props: Raw = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!excluded.has(k)) setOwn(props, k, v);
  }

  return build({
    tsMs: ts,
    source,
    kind: "log",
    level,
    message,
    message_template: messageTemplate,
    event_type: eventType,
    exception: "",
    trace_id: null,
    span_id: null,
    parent_span_id: null,
    duration_ms: null,
    properties: props,
  });
}
