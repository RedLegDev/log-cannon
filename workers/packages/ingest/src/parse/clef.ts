import { computeEventType, parseRFC3339, renderMessageTemplate } from "./go-compat";
import {
  nestingExceeds,
  NestingTooDeepError,
  ParseError,
  rowBuilder,
  type LogRow,
  type ParseContext,
  type ParseResult,
} from "./row";

/** Same per-line ceiling as the Go consumer's bufio.Scanner buffer. */
const MAX_LINE_BYTES = 1024 * 1024;

const utf8 = new TextEncoder();

export const CLEF_FIELDS = ["@t", "@l", "@mt", "@m", "@x", "@i"] as const;

/**
 * Parse an NDJSON CLEF body (`/ingest/clef`, `/api/events/raw`). Port of
 * queue-consumer/clef.go parseCLEFBody.
 *
 * A malformed line is skipped so one bad event in a Serilog batch doesn't drop
 * the rest. The body is rejected only when every non-empty line fails.
 */
export function parseCLEF(body: string, ctx: ParseContext): ParseResult {
  const rows: LogRow[] = [];
  let skipped = 0;
  let lastErr = "";
  const build = rowBuilder(ctx, "clef");
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rows.push(parseCLEFLine(line, ctx, build));
    } catch (err) {
      skipped++;
      lastErr = `line ${i + 1}: ${(err as Error).message}`;
    }
  }
  if (rows.length === 0 && skipped > 0) {
    throw new ParseError(`all ${skipped} CLEF line(s) failed to parse (last: ${lastErr})`);
  }
  return { rows, skipped };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseCLEFLine(
  line: string,
  ctx: ParseContext,
  build = rowBuilder(ctx, "clef"),
): LogRow {
  if (line.length * 3 > MAX_LINE_BYTES && utf8.encode(line).length > MAX_LINE_BYTES) {
    throw new Error("line exceeds 1 MiB");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error("invalid JSON");
  }
  if (raw === null) raw = {}; // Go unmarshals `null` into an empty map.
  if (!isObject(raw)) throw new Error("invalid JSON");
  if (nestingExceeds(raw)) throw new NestingTooDeepError();

  if (!("@t" in raw)) throw new Error("missing @t field");
  const tsRaw = raw["@t"];
  if (typeof tsRaw !== "string") throw new Error("@t must be a string");
  let ts = parseRFC3339(tsRaw);
  if (ts === null) throw new Error("invalid timestamp format");
  const now = ctx.receivedAt.getTime();
  if (ts > now) ts = now;

  const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  // Go kept an explicit "@l": "" as an empty level; the stream needs one.
  const level = str("@l") || "Information";
  const messageTemplate = str("@mt");
  let message = str("@m");
  const exception = str("@x");
  let eventType = str("@i");

  const props: Record<string, unknown> = { ...raw };
  for (const f of CLEF_FIELDS) delete props[f];

  if (!message && messageTemplate) message = renderMessageTemplate(messageTemplate, props);
  if (!eventType) eventType = computeEventType(messageTemplate, message);

  // After @-field handling, so it only ever touches properties.
  applyEnrichment(props, ctx.enrich);

  return build({
    tsMs: ts,
    source: ctx.source,
    kind: "log",
    level,
    message,
    message_template: messageTemplate,
    event_type: eventType,
    exception,
    trace_id: null,
    span_id: null,
    parent_span_id: null,
    duration_ms: null,
    properties: props,
  });
}

/**
 * Backfill edge geo/network context. A key is written only when the event has
 * no value, null, or "" for it: a caller's own non-empty value always wins.
 */
export function applyEnrichment(
  props: Record<string, unknown>,
  enrich: Record<string, string> | undefined,
): void {
  if (!enrich) return;
  for (const [k, v] of Object.entries(enrich)) {
    if (!v) continue;
    if (Object.hasOwn(props, k)) {
      const existing = props[k];
      if (existing !== null && existing !== "") continue;
    }
    props[k] = v;
  }
}
