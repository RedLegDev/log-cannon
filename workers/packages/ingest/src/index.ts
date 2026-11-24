// --- Types ---

import {
  resolveKey,
  hasScope,
  KeyLookupTimeoutError,
  KeyRejectedError,
  KEY_LOOKUP_RETRY_AFTER_S,
  type KeyCacheOptions,
  type APIKeyRecord,
  type KeySource,
} from "./keys";
import { handleAdminKeys } from "./admin";
import {
  RequestTrace,
  buildSlowRequest,
  resolveSlowRequestMs,
  shouldEmitTelemetry,
  slowRequestCLEF,
} from "./timing";
import {
  BasinCopyError,
  basinFailureCLEF,
  basinWriteEnabled,
  classifyFailure,
  copyTiming,
  isBasinLoss,
  within,
  writeCopy,
  type BasinCopy,
  type BasinFormat,
  type CopyOptions,
  type LogStream,
} from "./basin";
import { BasinQueryError, queryBasin } from "./basin-sql";
import { CLEF_FIELDS } from "./parse/clef";
import { handleMcp, type CreateLogArgs } from "./mcp";
import { handleAlerts, handleDestinations, handleFirings } from "./alerts/api";
import { runAlerts } from "./alerts/evaluate";
import { runSupabasePull } from "./supabase/pull";
import { runBasinSpillReplay } from "./basin-spill";
import { RETENTION_CRON, runBasinRetention } from "./basin-retention";
import {
  QueryRejected,
  dialectHints,
  eventParamsFromUrl,
  getEvent,
  getStats,
  prepareQuery,
  searchLogs,
  searchParamsFromUrl,
  statsParamsFromUrl,
} from "./query";

interface Env {
  KEYS_DB: D1Database;
  /**
   * Namespace for this deployment's entries in the colo key cache, so two
   * deployments in one zone never share them. Optional; unset is "default".
   */
  KEY_CACHE_NAMESPACE?: string;
  /**
   * Report any ingest request whose in-Worker time reaches this many
   * milliseconds. `0` disables reporting. Unset falls back to
   * DEFAULT_SLOW_REQUEST_MS rather than off.
   */
  SLOW_REQUEST_MS?: string | number;
  /**
   * `logs.events.source` that slow-request events are written to. Empty leaves
   * the console warning as the only channel.
   */
  SLOW_REQUEST_SOURCE?: string;
  /**
   * The Basin stream `log_events_v1` (refs #163); absent until the
   * `[[pipelines]]` binding is configured.
   */
  LOGS?: LogStream;
  /**
   * Exactly "true" writes every accepted request into `LOGS`, the only store
   * since the queue was retired (refs #171). Anything else is off, and an
   * accepted request is then stored nowhere. See `src/basin.ts`.
   */
  BASIN_WRITE?: string;
  /**
   * R2 bucket for Basin copies the stream wouldn't take after retries (refs
   * #166). The cron replays it. Absent, such rows are lost and reported.
   */
  BASIN_SPILL?: R2Bucket;
  /**
   * v2 read path (refs #163): Basin SQL REST. The token is a secret with
   * Basin SQL read only; account and bucket are plain vars.
   */
  BASIN_SQL_TOKEN?: string;
  BASIN_SQL_ACCOUNT?: string;
  BASIN_SQL_BUCKET?: string;
  /**
   * Alert evaluator (refs #165): `off` (default), `shadow` (evaluate and
   * record, send nothing) or `live`. See `src/alerts/evaluate.ts`.
   */
  ALERTS_MODE?: string;
  /**
   * Basin retention (refs #167), on its own daily cron: `off` (default),
   * `dry-run` or `delete`. `BASIN_EVENTS` is the catalog's bucket (manifests
   * are read and written there); `BASIN_CATALOG_TOKEN` is the catalog-write
   * secret delete mode needs. See `src/basin-retention.ts`.
   */
  BASIN_RETENTION_MODE?: string;
  BASIN_RETENTION_DEFAULT_DAYS?: string;
  BASIN_EVENTS?: R2Bucket;
  BASIN_CATALOG_TOKEN?: string;
  /** Seconds every alert's `now()` is pinned behind evaluation time. Default 180. */
  ALERT_LAG_SECONDS?: string | number;
  /** Batched alert queries (refs #194): `off`, `shadow` (default) or `on`. See `src/alerts/evaluate.ts`. */
  ALERT_BATCH_MODE?: string;
  /** Source the evaluator's events (errors, sends) are written to. */
  ALERTS_SOURCE?: string;
  /** Alert email: SaaSMail key (secret), API origin and default sender. */
  SAASMAIL_API_KEY?: string;
  SAASMAIL_API_URL?: string;
  ALERT_FROM_EMAIL?: string;
  /**
   * Supabase platform-log pull (refs #164): `ref=source,…` projects (empty is
   * a no-op), optional table list, and the Management API token (secret).
   * Runs only while BASIN_WRITE is on. See `src/supabase/pull.ts`.
   */
  SUPABASE_PULL_PROJECTS?: string;
  SUPABASE_PULL_TABLES?: string;
  SUPABASE_ACCESS_TOKEN?: string;
}

/**
 * Ingest routes and the parser each dispatches to. The route list and the
 * format union already had to agree; keeping the mapping in one place stops
 * the router becoming a third copy that has to agree with both.
 */
const ROUTE_FORMATS = {
  "/ingest/clef": "clef",
  "/api/events/raw": "clef",
  "/ingest/webhook": "webhook",
  "/ingest/otlp/logs": "otlp-logs",
  "/v1/logs": "otlp-logs",
  "/ingest/otlp/traces": "otlp-traces",
  "/v1/traces": "otlp-traces",
} satisfies Record<string, BasinFormat>;

/** Narrowed view of the `request.cf` fields we read (workers-types exposes
 * these under a broad generic). Every field is optional — Cloudflare omits
 * them outside a real edge request, and botManagement requires Bot Management. */
interface CfGeoContext {
  asn?: number;
  country?: string;
  region?: string;
  city?: string;
  colo?: string;
  botManagement?: { verifiedBot?: boolean };
}

/**
 * Capture per-request geo/network context from the Cloudflare edge so the
 * parser can enrich events that lack it (e.g. browser beacons, which carry
 * a real user IP but can't self-report ASN/geo). Keys match the exact property
 * names downstream analytics already read. No raw client IP is captured (PII).
 *
 * The parser applies these as event properties, filling only keys the event
 * doesn't already carry — never overwriting a value the caller stamped itself.
 * Attached on the CLEF path only. Returns undefined only when nothing at all is
 * available, so this is a pure no-op when there's nothing to add and can't fail
 * the request.
 *
 * `cf_is_bot` mirrors Cloudflare's `verifiedBot`: true only for allow-listed
 * good crawlers (Googlebot, etc.), false/absent for everything else including
 * malicious bots. This matches the existing platform convention; it is NOT a
 * general bot-likelihood score (that would be `botManagement.score`). Under
 * `wrangler dev` `request.cf` is a stub, so user_agent/cf_is_bot can still
 * attach locally; real geo/ASN only appear on a deployed edge.
 */
function buildEnrichment(request: Request): Record<string, string> | undefined {
  const enrich: Record<string, string> = {};

  const ua = request.headers.get("user-agent");
  if (ua) enrich.user_agent = ua;

  const cf = request.cf as CfGeoContext | undefined;
  if (cf) {
    if (cf.asn != null) enrich.cf_asn = String(cf.asn);
    if (cf.country) enrich.geo_country = cf.country;
    if (cf.region) enrich.geo_region = cf.region;
    if (cf.city) enrich.geo_city = cf.city;
    enrich.cf_is_bot = String(cf.botManagement?.verifiedBot ?? false);
  }

  return Object.keys(enrich).length > 0 ? enrich : undefined;
}

// --- Auth ---

function extractAPIKey(request: Request): string {
  const h = request.headers;

  const xApiKey = h.get("X-Api-Key");
  if (xApiKey) return xApiKey;

  const xSeqApiKey = h.get("X-Seq-ApiKey");
  if (xSeqApiKey) return xSeqApiKey;

  const queryKey = new URL(request.url).searchParams.get("apiKey");
  if (queryKey) return queryKey;

  const auth = h.get("Authorization");
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7);

  return "";
}

// --- HTTP helpers ---

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Seq-ApiKey, X-Api-Key, Authorization",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse({ Error: message }, status);
}

const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32 MB

// Maximum raw bytes per chunk of a large body. The number comes from the
// retired queue's 128 KB message cap (90 KB raw, base64 and wrapped, fit under
// it) and is kept as it was: the Basin copy parses and sends one chunk at a
// time, which bounds its memory, and a single CLEF line or OTLP resource entry
// over it is still a 413 the sender has to fix (the error text keeps its
// original wording for the same reason).
const MAX_CHUNK_BYTES = 90 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds 32 MB limit");
  }
}

// Client-fixable body problems (null body, bad gzip). Must surface as 4xx so
// Seq/Serilog do not retry forever the way they do on 5xx.
class BadBodyError extends Error {
  constructor(message: string) {
    super(message);
  }
}

async function readBody(request: Request): Promise<Uint8Array> {
  if (request.body === null) {
    throw new BadBodyError("Request body is required");
  }

  let stream: ReadableStream<Uint8Array>;

  if (request.headers.get("Content-Encoding") === "gzip") {
    const ds = new DecompressionStream("gzip");
    stream = request.body.pipeThrough(ds);
  } else {
    stream = request.body;
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > MAX_BODY_BYTES) {
        reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof BodyTooLargeError) throw e;
    throw new BadBodyError(
      e instanceof Error ? e.message : "Failed to read request body",
    );
  }

  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** `readBody`, with the `read` span closed and the body size recorded. */
async function readTracedBody(
  request: Request,
  trace: RequestTrace,
): Promise<Uint8Array> {
  const bodyBytes = await readBody(request);
  trace.mark("read");
  trace.bodyBytes = bodyBytes.byteLength;
  return bodyBytes;
}

/**
 * Split an OTLP protobuf body (ExportLogsServiceRequest or
 * ExportTraceServiceRequest) into chunks at the top-level repeated field
 * boundary. In both messages the repeated `resource_logs` / `resource_spans`
 * field uses field number 1, wire type 2 (length-delimited), so the tag byte
 * is 0x0a. Concatenating any subset of those length-delimited entries yields
 * a valid OTLP request containing only those resources — the Basin copy
 * parses each chunk as an independent batch.
 *
 * Returns null if a single resource entry already exceeds the chunk limit
 * (would require descending into scope_logs/log_records to split further),
 * or if the body has unexpected top-level fields. The caller surfaces 413 in
 * that case so we notice and add deeper chunking before it bites in prod.
 */
function chunkOTLPBody(body: Uint8Array): Uint8Array[] | null {
  // Pass 1: walk the top-level message and record each entry's byte range.
  const entries: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < body.length) {
    const entryStart = i;
    const tag = body[i];
    if (tag !== 0x0a) {
      // Unknown top-level field (or a non-resource scalar). Bail rather than
      // silently dropping fields we don't understand.
      return null;
    }
    i++;
    // Read varint length prefix
    let length = 0;
    let shift = 0;
    while (i < body.length) {
      const b = body[i];
      i++;
      length += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) return null;
    }
    if (i + length > body.length) return null;
    i += length;
    if (i - entryStart > MAX_CHUNK_BYTES) return null;
    entries.push({ start: entryStart, end: i });
  }

  if (entries.length === 0) return null;

  // Pass 2: greedy-pack contiguous entries into chunks under the limit.
  const chunks: Uint8Array[] = [];
  let chunkStart = entries[0].start;
  let chunkEnd = entries[0].end;
  for (let idx = 1; idx < entries.length; idx++) {
    const e = entries[idx];
    if (e.end - chunkStart > MAX_CHUNK_BYTES) {
      chunks.push(body.subarray(chunkStart, chunkEnd));
      chunkStart = e.start;
    }
    chunkEnd = e.end;
  }
  chunks.push(body.subarray(chunkStart, chunkEnd));
  return chunks;
}

/**
 * Split a JSON OTLP body into chunks. The body is an
 * ExportLogsServiceRequest (key `resourceLogs`) or ExportTraceServiceRequest
 * (key `resourceSpans`); each chunk wraps a contiguous subset of that
 * top-level array as a fresh request, so the parser handles it identically.
 *
 * Same null-return contract as chunkOTLPBody: bail (caller surfaces 413) if
 * the body has unexpected top-level keys, isn't valid JSON, or contains a
 * single entry that wouldn't fit in a chunk on its own. Splitting deeper
 * (into scopeLogs / logRecords) is left until a producer actually trips it.
 */
function chunkJSONOTLPBody(
  body: Uint8Array,
  format: "otlp-logs" | "otlp-traces",
): Uint8Array[] | null {
  const arrayKey = format === "otlp-logs" ? "resourceLogs" : "resourceSpans";

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1 || keys[0] !== arrayKey) return null;
  const entries = obj[arrayKey];
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const encoder = new TextEncoder();
  const prefix = encoder.encode(`{"${arrayKey}":[`);
  const suffix = encoder.encode(`]}`);
  const wrapperOverhead = prefix.byteLength + suffix.byteLength;

  const serialized: Uint8Array[] = entries.map((e) =>
    encoder.encode(JSON.stringify(e)),
  );
  for (const s of serialized) {
    if (s.byteLength + wrapperOverhead > MAX_CHUNK_BYTES) return null;
  }

  const chunks: Uint8Array[] = [];
  let groupStart = 0;
  let groupBodySize = serialized[0].byteLength;
  for (let i = 1; i < serialized.length; i++) {
    const addedSize = 1 + serialized[i].byteLength; // +1 for comma separator
    if (groupBodySize + addedSize + wrapperOverhead > MAX_CHUNK_BYTES) {
      chunks.push(joinJSONOTLPChunk(prefix, suffix, serialized, groupStart, i));
      groupStart = i;
      groupBodySize = serialized[i].byteLength;
    } else {
      groupBodySize += addedSize;
    }
  }
  chunks.push(
    joinJSONOTLPChunk(prefix, suffix, serialized, groupStart, serialized.length),
  );
  return chunks;
}

function joinJSONOTLPChunk(
  prefix: Uint8Array,
  suffix: Uint8Array,
  entries: Uint8Array[],
  start: number,
  end: number,
): Uint8Array {
  let total = prefix.byteLength + suffix.byteLength;
  for (let i = start; i < end; i++) {
    total += entries[i].byteLength;
    if (i > start) total += 1; // comma
  }
  const out = new Uint8Array(total);
  let off = 0;
  out.set(prefix, off);
  off += prefix.byteLength;
  for (let i = start; i < end; i++) {
    if (i > start) out[off++] = 0x2c; // ','
    out.set(entries[i], off);
    off += entries[i].byteLength;
  }
  out.set(suffix, off);
  return out;
}

/**
 * Split a CLEF body (newline-delimited JSON) into chunks that each fit
 * under MAX_CHUNK_BYTES. Each returned chunk is itself a valid CLEF
 * payload, so the parser handles it identically to a single smaller
 * request.
 *
 * Returns null if any single line is larger than MAX_CHUNK_BYTES —
 * such an event cannot be split further at line boundaries and the caller
 * should surface a 413 so the producer fixes the offending log statement.
 */
function chunkCLEFBody(body: Uint8Array): Uint8Array[] | null {
  const chunks: Uint8Array[] = [];
  let chunkStart = 0;
  let lastLineEnd = 0;
  let i = 0;

  while (i < body.length) {
    // Find the end of the current line (inclusive of trailing '\n' if any).
    let lineEnd = i;
    while (lineEnd < body.length && body[lineEnd] !== 0x0a) lineEnd++;
    if (lineEnd < body.length) lineEnd++; // include the newline byte

    const lineLength = lineEnd - i;
    if (lineLength > MAX_CHUNK_BYTES) {
      return null; // single line cannot fit in any chunk
    }

    // If appending this line would push the in-progress chunk over the
    // limit, flush what we have first and start a new chunk at this line.
    if (lineEnd - chunkStart > MAX_CHUNK_BYTES && i > chunkStart) {
      chunks.push(body.subarray(chunkStart, i));
      chunkStart = i;
    }

    lastLineEnd = lineEnd;
    i = lineEnd;
  }

  if (lastLineEnd > chunkStart) {
    chunks.push(body.subarray(chunkStart, lastLineEnd));
  }

  return chunks;
}

// --- Auth middleware ---

class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Seconds for `Retry-After`; set when the sender should simply retry. */
    public retryAfterS?: number,
  ) {
    super(message);
  }
}

/** Adds the `Retry-After` an `AuthError` asks for to its error response. */
function withRetryAfter(res: Response, e: AuthError): Response {
  if (e.retryAfterS !== undefined) res.headers.set("Retry-After", String(e.retryAfterS));
  return res;
}

/** The key cache's per-deployment namespace and this request's `waitUntil`. */
function keyCacheOptions(env: Env, ctx: ExecutionContext): KeyCacheOptions {
  return { namespace: env.KEY_CACHE_NAMESPACE, waitUntil: (p) => ctx.waitUntil(p) };
}

interface AuthResult {
  record: APIKeyRecord;
  /** Which tier resolved the key: this isolate, the colo cache, or D1. */
  source: KeySource;
}

async function authenticate(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  trace?: RequestTrace,
): Promise<AuthResult> {
  const apiKey = extractAPIKey(request);
  if (!apiKey) throw new AuthError(401, "API key required");

  const report = (source: KeySource) => {
    if (!trace) return;
    trace.keyCacheHit = source === "l1";
    trace.keyL2Hit = source === "l2";
  };

  // Distinguish a known auth rejection (bad/disabled key — genuinely the
  // client's fault, safe as a non-retryable 4xx) from everything else (D1
  // outage, query timeout, schema drift — the client did nothing wrong).
  // Seq/Serilog sinks treat 4xx as terminal and drop the batch but retry
  // 5xx, so collapsing both cases into 403 turns a transient D1 blip into
  // silent, permanent log loss across every client at once.
  try {
    const result = await resolveKey(apiKey, env.KEYS_DB, Date.now(), keyCacheOptions(env, ctx));
    report(result.source);
    return result;
  } catch (e) {
    if (e instanceof KeyRejectedError) {
      // Still says which tier answered: a disabled key served from L1 is an
      // L1 hit.
      report(e.source);
      throw new AuthError(403, "Invalid or disabled API key");
    }
    if (e instanceof KeyLookupTimeoutError) {
      // A slow D1, not a bad key: 503 so the sender retries, by which time
      // the late read has usually filled the cache (refs #151).
      if (trace) trace.authTimedOut = true;
      throw new AuthError(503, "Key store slow, retry shortly", KEY_LOOKUP_RETRY_AFTER_S);
    }
    throw new AuthError(500, "Key store unavailable");
  }
}

// --- Basin write ---

/**
 * Everything a route handler and its Basin copy need from the request that is
 * the same for all of them. Bundled rather than threaded as more parameters
 * because the copy's failure report needs all of it after the response is
 * gone.
 */
export interface IngestRequest {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  trace: RequestTrace;
  /** Request pathname, as the slow-request and failure events record it. */
  route: string;
  /** The API key's name — the `logs.events.source` being written to. */
  source: string;
  /** The API key's id, stamped on Basin rows as `key_id`. */
  keyId: string;
  /** When the request arrived; Basin rows carry it as `received_at`. */
  receivedAt: Date;
}

/** `key_id` on rows the Worker writes about itself; no API key sent them. */
export const TELEMETRY_KEY_ID = "log-cannon-ingest";

/**
 * Write the Worker's own CLEF events (slow requests, losses, alert evaluator
 * events) to `source` in Basin, so readers and alerts see them. Never throws:
 * the copy retries and spills like any other, and one that still fails is
 * logged, never reported through this same path.
 *
 * Its spill gets `copyTiming.telemetrySpillTimeoutMs`, shorter than a request
 * copy's: a loss report starts only after the request copy it describes has
 * failed, so it has the least of `waitUntil` left.
 */
export async function sendTelemetry(
  env: Env,
  source: string,
  lines: string[],
  opts: Pick<CopyOptions, "spillOnly"> = {},
): Promise<void> {
  if (!lines.length || !basinWriteEnabled(env.BASIN_WRITE, env.LOGS)) return;
  const bytes = new TextEncoder().encode(`${lines.join("\n")}\n`);
  const contentType = "application/vnd.serilog.clef";
  try {
    // Off the response path, as copyToBasin is: the slow-request report runs
    // inside the request it describes.
    await scheduler.wait(0);
    await writeCopy(
      env.LOGS,
      { format: "clef", bodies: [bytes], contentType, source, keyId: TELEMETRY_KEY_ID, receivedAt: new Date() },
      { spill: env.BASIN_SPILL, spillTimeoutMs: copyTiming.telemetrySpillTimeoutMs, ...opts },
    );
  } catch (e) {
    const spill = e instanceof BasinCopyError ? { spilledRows: e.outcome.spilled, lostRows: e.outcome.lost, spillError: e.spillError } : {};
    console.error(JSON.stringify({ event: "telemetry-basin-copy-failed", source, error: e instanceof Error ? e.message : String(e), ...spill }));
  }
}

/** What a route hands `copyToBasin`; the request supplies the rest. */
export type IngestCopy = Omit<BasinCopy, "source" | "keyId" | "receivedAt">;

/**
 * Write a request into Basin, the only store, in `waitUntil` so it is off the
 * response path: the client gets its success response without waiting for it.
 *
 * It registers the `waitUntil` synchronously, before its first `await`, and
 * every route calls it with nothing awaited between the call and its
 * response. A client that disconnects ends the invocation at the next
 * `await`, and code after that never runs, so a copy registered after one
 * would be lost without a trace (refs #175).
 *
 * Never throws. A failure is reported on both channels, on its own throttle
 * budget; a copy that lost rows (its spill failed too) on a separate one, so a
 * run of spills can't hide it.
 */
export function copyToBasin(ingest: IngestRequest, copy: IngestCopy): void {
  const { env, ctx } = ingest;
  if (!basinWriteEnabled(env.BASIN_WRITE, env.LOGS)) return;
  const stream = env.LOGS;
  ctx.waitUntil(
    (async () => {
      // Yield a macrotask first. Without it the async body runs synchronously
      // up to its first await, so the whole parse would happen before this
      // function returns and the handler sends its response.
      await scheduler.wait(0);
      try {
        await within(
          writeCopy(
            stream,
            { ...copy, source: ingest.source, keyId: ingest.keyId, receivedAt: ingest.receivedAt },
            { spill: env.BASIN_SPILL, watchdogMs: copyTiming.watchdogMs },
          ),
          copyTiming.watchdogMs,
          "copy",
        );
      } catch (e) {
        await reportBasinFailure(ingest, copy, e);
      }
    })(),
  );
}

async function reportBasinFailure(
  ingest: IngestRequest,
  copy: Pick<BasinCopy, "format" | "bodies">,
  error: unknown,
): Promise<void> {
  try {
    const failure = {
      route: ingest.route,
      format: copy.format,
      ingestSource: ingest.source,
      bodyBytes: copy.bodies.reduce((n, b) => n + b.byteLength, 0),
      stage: classifyFailure(error),
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof BasinCopyError && error.stage === "send"
        ? {
            spilledRows: error.outcome.spilled,
            lostRows: error.outcome.lost,
            spillError: error.spillError,
            spillAttempts: error.outcome.spillAttempts,
          }
        : {}),
    };
    console.error(JSON.stringify({ event: "basin-copy-failed", ...failure }));

    const telemetrySource = ingest.env.SLOW_REQUEST_SOURCE?.trim() ?? "";
    if (!telemetrySource) return;
    if (!shouldEmitTelemetry(Date.now(), isBasinLoss(failure) ? "basin-loss" : "basin-failure")) return;
    // A failed send means the stream is the problem, so the report's own Basin
    // copy goes straight to the spill instead of hanging on it.
    await sendTelemetry(ingest.env, telemetrySource, [basinFailureCLEF(failure, new Date().toISOString())], {
      spillOnly: failure.stage === "send",
    });
  } catch (e) {
    warnReportFailed(e);
  }
}

// --- Route handlers ---

async function handleCLEF(ingest: IngestRequest): Promise<Response> {
  const { request, trace } = ingest;
  const bodyBytes = await readTracedBody(request, trace);
  const contentType =
    request.headers.get("Content-Type") ?? "application/json";
  const enrich = buildEnrichment(request);

  // Fast path: a small body is one chunk.
  if (bodyBytes.byteLength <= MAX_CHUNK_BYTES) {
    copyToBasin(ingest, { format: "clef", bodies: [bodyBytes], contentType, enrich });
    return jsonResponse({ MinimumLevelAccepted: null }, 201);
  }

  // Large body: split CLEF (newline-delimited JSON) into chunks of at most
  // MAX_CHUNK_BYTES, so the copy parses one chunk at a time.
  const chunks = chunkCLEFBody(bodyBytes);
  if (chunks === null) {
    return errorResponse(
      413,
      `CLEF event exceeds ${MAX_CHUNK_BYTES} byte queue chunk limit`,
    );
  }

  copyToBasin(ingest, { format: "clef", bodies: chunks, contentType, enrich });

  return jsonResponse({ MinimumLevelAccepted: null }, 201);
}

async function handleWebhook(ingest: IngestRequest): Promise<Response> {
  const { request, trace } = ingest;
  const bodyBytes = await readTracedBody(request, trace);

  // Cloudflare Logpush validation handshake: non-JSON body → 200 OK
  if (
    bodyBytes.length === 0 ||
    (bodyBytes[0] !== 0x7b && bodyBytes[0] !== 0x5b)
  ) {
    return new Response(null, { status: 200 });
  }

  // Webhook bodies are not chunked: they aren't newline-delimited, and the
  // copy parses the whole body at once.
  const preset = new URL(request.url).searchParams.get("preset") ?? "";

  const contentType = request.headers.get("Content-Type") ?? "application/json";
  copyToBasin(ingest, { format: "webhook", bodies: [bodyBytes], contentType, preset: preset || undefined });

  return jsonResponse({ accepted: true });
}

async function handleOTLP(
  ingest: IngestRequest,
  format: "otlp-logs" | "otlp-traces",
): Promise<Response> {
  const { request, trace } = ingest;
  const bodyBytes = await readTracedBody(request, trace);
  const contentType =
    request.headers.get("Content-Type") ?? "application/x-protobuf";
  const key = format === "otlp-logs" ? "rejectedLogRecords" : "rejectedSpans";

  // Fast path: a small body is one chunk.
  if (bodyBytes.byteLength <= MAX_CHUNK_BYTES) {
    copyToBasin(ingest, { format, bodies: [bodyBytes], contentType });
    return jsonResponse({ partialSuccess: { [key]: 0, errorMessage: "" } });
  }

  // Large body: split the OTLP request at resource_logs/resource_spans
  // boundaries into chunks of at most MAX_CHUNK_BYTES, so the copy parses one
  // chunk at a time. Dispatch matches the parser's content-type rule
  // (src/parse/otlp.ts): exact protobuf media types get the protobuf
  // splitter; everything else is treated as JSON.
  const isProtobuf =
    contentType === "application/x-protobuf" ||
    contentType === "application/proto";
  const chunks = isProtobuf
    ? chunkOTLPBody(bodyBytes)
    : chunkJSONOTLPBody(bodyBytes, format);
  if (chunks === null) {
    return errorResponse(
      413,
      `OTLP resource entry exceeds ${MAX_CHUNK_BYTES} byte queue chunk limit`,
    );
  }

  copyToBasin(ingest, { format, bodies: chunks, contentType });

  return jsonResponse({ partialSuccess: { [key]: 0, errorMessage: "" } });
}

// --- Slow-request reporting ---

/** One message for both failure channels, so they cannot drift. */
function warnReportFailed(e: unknown): void {
  console.warn(
    JSON.stringify({
      event: "slow-ingest-report-failed",
      error: e instanceof Error ? e.message : String(e),
    }),
  );
}

/**
 * Report an ingest request that took at least `SLOW_REQUEST_MS` in the Worker.
 *
 * Two channels, deliberately independent:
 *
 * - `console.warn`, retained by Workers Logs (`[observability]` in
 *   `wrangler.toml`). Costs nothing and survives the case that matters most —
 *   a store that is itself the slow thing.
 * - A CLEF event on `SLOW_REQUEST_SOURCE`, written in `waitUntil` so it never
 *   adds latency to the caller's request, and throttled per isolate. This is
 *   the channel the read API, MCP and alerts can already read, so alerting on
 *   ingest degradation needs no new machinery.
 *
 * Never throws: an instrumentation failure must not turn a served request into
 * a 500 that a Seq sink then retries.
 *
 * Exported so the reporting path can be tested against a fake clock rather
 * than by trying to make a real request slow.
 */
export function reportIfSlow(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  trace: RequestTrace,
  fields: { route: string; format: string; status: number; ingestSource: string },
): void {
  try {
    const threshold = resolveSlowRequestMs(env.SLOW_REQUEST_MS);
    if (threshold <= 0) return;
    if (trace.totalMs() < threshold) return;

    const cf = request.cf as CfGeoContext | undefined;
    const report = buildSlowRequest(trace, {
      ...fields,
      colo: cf?.colo,
      rayId: request.headers.get("cf-ray") ?? undefined,
    });

    console.warn(JSON.stringify({ event: "slow-ingest-request", ...report }));

    const telemetrySource = env.SLOW_REQUEST_SOURCE?.trim() ?? "";
    if (!telemetrySource) return;
    if (!shouldEmitTelemetry()) return;

    const line = slowRequestCLEF(report, new Date().toISOString());
    ctx.waitUntil(sendTelemetry(env, telemetrySource, [line]).catch(warnReportFailed));
  } catch (e) {
    // The outer catch covers the synchronous path, including a `send` that
    // throws before it returns a promise; the inner `.catch` covers the
    // rejection of a send that is never awaited. Different failures, one
    // message.
    warnReportFailed(e);
  }
}

// --- v2 read API (refs #163) ---

/**
 * The read surface answers at the unprefixed v1 paths and, as an alias for
 * callers that moved before cutover, under `/v2`. Which one reaches this
 * Worker in production is the routes' call: until the cutover commit adds the
 * unprefixed routes (refs #168), those paths still go to the v1 dashboard.
 */
const READ_PREFIX = "/v2";
// Each of these also needs a production route in wrangler.toml, or the
// unprefixed path never reaches the Worker (only /v2/* is a wildcard route).
const READ_PATHS = new Set([
  "/api/v1/query",
  "/api/v1/logs",
  "/api/v1/stats",
  "/api/mcp",
  "/api/v1/alerts",
  "/api/v1/alert-destinations",
  "/api/v1/alert-firings",
]);
const EVENTS_PREFIX = "/api/v1/events/";

export function readPath(path: string): string | null {
  const rest = path.startsWith(`${READ_PREFIX}/`) ? path.slice(READ_PREFIX.length) : path;
  if (READ_PATHS.has(rest)) return rest;
  // The sub-routes: GET /api/v1/events/:id, POST /api/v1/alerts/:id/test and
  // GET /api/v1/alerts/:id/firings (refs #193).
  if (/^\/api\/v1\/events\/[^/]+$/.test(rest)) return rest;
  return /^\/api\/v1\/alerts\/[^/]+\/(test|firings)$/.test(rest) ? rest : null;
}

function apiError(error: string, message: string, status: number, extra?: Record<string, unknown>): Response {
  return jsonResponse({ error, message, ...extra }, status);
}

function basinError(e: unknown, sql?: string): Response {
  if (e instanceof QueryRejected) return apiError("validation_error", e.message, 400);
  if (e instanceof BasinQueryError) {
    if (e.status === 400) {
      const hints = sql ? dialectHints(sql) : [];
      return apiError("query_error", e.message, 400, hints.length ? { hints } : undefined);
    }
    if (e.status === 504) return apiError("query_timeout", e.message, 504);
    return apiError("upstream_error", e.message, e.status);
  }
  console.error(JSON.stringify({ event: "read-api-error", error: e instanceof Error ? e.message : String(e) }));
  return apiError("internal_error", "Query execution failed", 500);
}

/**
 * MCP `create_log`: one CLEF line through the same Basin write as
 * `/ingest/clef`, stamped the same way: source is the calling key's name and
 * `key_id` the calling key, so an MCP key can't write as another tenant (#84).
 */
const CLEF_RESERVED = new Set<string>(CLEF_FIELDS);

async function createLog(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  key: APIKeyRecord,
  entry: CreateLogArgs,
): Promise<void> {
  const source = key.name;
  const receivedAt = new Date();
  // A property named like a CLEF field the parser consumes (@x, @i, …) would
  // set that field instead of being data. Double its @ (Serilog's escape);
  // other @-keys are plain properties to the parser and pass through.
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry.properties ?? {})) props[CLEF_RESERVED.has(k) ? `@${k}` : k] = v;
  const line: Record<string, unknown> = {
    ...props,
    "@t": receivedAt.toISOString(),
    "@l": entry.level,
    "@m": entry.message,
    "@mt": entry.message_template || entry.message,
  };
  if (entry.exception) line["@x"] = entry.exception;
  if (entry.event_type) line["@i"] = entry.event_type;
  const bytes = new TextEncoder().encode(`${JSON.stringify(line)}\n`);
  if (bytes.byteLength > MAX_CHUNK_BYTES) {
    throw new Error(`log entry exceeds ${MAX_CHUNK_BYTES} bytes`);
  }
  const contentType = "application/vnd.serilog.clef";
  const ingest: IngestRequest = {
    request,
    env,
    ctx,
    trace: new RequestTrace(),
    route: "/api/mcp#create_log",
    source,
    keyId: key.keyId,
    receivedAt,
  };
  copyToBasin(ingest, { format: "clef", bodies: [bytes], contentType });
}

async function handleRead(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  route: string,
  unprefixed: boolean,
): Promise<Response> {
  let key: APIKeyRecord;
  try {
    key = (await authenticate(request, env, ctx)).record;
  } catch (e) {
    if (e instanceof AuthError) {
      const code =
        e.status === 401 ? "unauthorized" : e.status === 403 ? "forbidden" : e.status === 503 ? "unavailable" : "internal_error";
      return withRetryAfter(apiError(code, e.message, e.status), e);
    }
    return apiError("internal_error", "Authentication failed", 500);
  }

  // One alerts context for REST and MCP, so both get the same scope checks.
  const api = { env, canWrite: hasScope(key, "write"), json: jsonResponse, error: apiError, now: () => new Date() };

  if (route === "/api/mcp") {
    return handleMcp(request, {
      env,
      scopes: key.scopes,
      createLog: (entry) => createLog(request, env, ctx, key, entry),
      alertsApi: api,
    });
  }

  if (!hasScope(key, "read")) {
    return apiError("forbidden", "This key lacks the required 'read' scope", 403);
  }

  if (
    route === "/api/v1/alerts" ||
    route.startsWith("/api/v1/alerts/") ||
    route === "/api/v1/alert-destinations" ||
    route === "/api/v1/alert-firings"
  ) {
    try {
      return route === "/api/v1/alert-destinations"
        ? await handleDestinations(request, api)
        : route === "/api/v1/alert-firings"
          ? await handleFirings(request, null, api)
          : await handleAlerts(request, route.slice("/api/v1/alerts".length), api);
    } catch (e) {
      console.error(JSON.stringify({ event: "alerts-api-error", route, error: e instanceof Error ? e.message : String(e) }));
      return apiError("internal_error", "Alert request failed", 500);
    }
  }

  if (route === "/api/v1/logs") {
    if (request.method === "DELETE") {
      return apiError("not_supported", "Basin is read-only; logs are removed by per-key retention", 405);
    }
    if (request.method !== "GET") return apiError("method_not_allowed", "Use GET", 405);
    try {
      const result = await searchLogs(env, searchParamsFromUrl(new URL(request.url)));
      // v1 rows carried `timestamp`; callers still on the unprefixed path read it.
      if (unprefixed) result.data = result.data.map((row) => ({ ...row, timestamp: row.ts }));
      return jsonResponse(result);
    } catch (e) {
      return basinError(e);
    }
  }

  if (route === "/api/v1/stats") {
    if (request.method !== "GET") return apiError("method_not_allowed", "Use GET", 405);
    try {
      return jsonResponse(await getStats(env, statsParamsFromUrl(new URL(request.url))));
    } catch (e) {
      return basinError(e);
    }
  }

  if (route.startsWith(EVENTS_PREFIX)) {
    if (request.method !== "GET") return apiError("method_not_allowed", "Use GET", 405);
    let id: string;
    try {
      id = decodeURIComponent(route.slice(EVENTS_PREFIX.length));
    } catch {
      return apiError("validation_error", "The event id in the path is not valid percent-encoding", 400);
    }
    try {
      const result = await getEvent(env, eventParamsFromUrl(id, new URL(request.url)));
      return result ? jsonResponse(result) : apiError("not_found", `No event with id ${id} in the window searched`, 404);
    } catch (e) {
      return basinError(e);
    }
  }

  // /api/v1/query
  if (request.method !== "POST") return apiError("method_not_allowed", "Use POST", 405);
  let sql: unknown;
  try {
    sql = ((await request.json()) as { sql?: unknown })?.sql;
  } catch {
    return apiError("validation_error", "Body must be JSON: {\"sql\": \"SELECT ...\"}", 400);
  }
  try {
    const prepared = prepareQuery(sql);
    const start = Date.now();
    const { rows, bytesScanned } = await queryBasin(env, prepared);
    return jsonResponse({
      data: rows,
      meta: { rows: rows.length, elapsed_ms: Date.now() - start, bytes_scanned: bytesScanned },
    });
  } catch (e) {
    return basinError(e, typeof sql === "string" ? sql : undefined);
  }
}

// --- Cron ---

/**
 * The once-a-minute cron: alerts, the Supabase pull (#164) and the Basin spill
 * replay (#166), side by side. Each has its own try/catch, so one failing or
 * overrunning never stops the others.
 */
export async function scheduled(env: Env): Promise<void> {
  await Promise.all([alertsTick(env), supabasePullTick(env), basinSpillReplayTick(env)]);
}

async function basinSpillReplayTick(env: Env): Promise<void> {
  const source = env.SLOW_REQUEST_SOURCE?.trim() || TELEMETRY_KEY_ID;
  try {
    const tick = await runBasinSpillReplay(env, {
      now: () => new Date(),
      emit: (lines) => sendTelemetry(env, source, lines).catch(warnReportFailed),
    });
    if (tick.skipped !== "off" && (tick.skipped || tick.replayed || tick.backlog || tick.error)) {
      console.log(JSON.stringify({ event: "basin-spill-replay-tick", ...tick }));
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "basin-spill-replay-tick-failed", error: e instanceof Error ? e.message : String(e) }));
  }
}

async function basinRetentionTick(env: Env): Promise<void> {
  const source = env.SLOW_REQUEST_SOURCE?.trim() || TELEMETRY_KEY_ID;
  try {
    const run = await runBasinRetention(env, {
      now: () => new Date(),
      emit: (lines) => sendTelemetry(env, source, lines).catch(warnReportFailed),
    });
    if (run.skipped !== "off") console.log(JSON.stringify({ event: "basin-retention-run", ...run }));
  } catch (e) {
    console.error(JSON.stringify({ event: "basin-retention-run-failed", error: e instanceof Error ? e.message : String(e) }));
  }
}

async function alertsTick(env: Env): Promise<void> {
  const source = env.ALERTS_SOURCE?.trim() || "log-cannon-alerts";
  try {
    const tick = await runAlerts(env, {
      now: () => new Date(),
      emit: (lines) => sendTelemetry(env, source, lines).catch(warnReportFailed),
    });
    if (tick.skipped !== "off") {
      const errors = tick.evaluated.filter((e) => e.status === "error").length;
      const fired = tick.evaluated.filter((e) => e.wouldSend).length;
      console.log(JSON.stringify({ event: "alerts-tick", mode: tick.mode, skipped: tick.skipped, due: tick.due, errors, fired }));
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "alerts-tick-failed", error: e instanceof Error ? e.message : String(e) }));
  }
}

async function supabasePullTick(env: Env): Promise<void> {
  try {
    const tick = await runSupabasePull(env, {
      now: () => new Date(),
      emit: (lines) => sendTelemetry(env, "supabase-pull", lines).catch(warnReportFailed),
    });
    if (tick.skipped !== "off") console.log(JSON.stringify({ event: "supabase-pull-tick", skipped: tick.skipped, tables: tick.results }));
  } catch (e) {
    console.error(JSON.stringify({ event: "supabase-pull-tick-failed", error: e instanceof Error ? e.message : String(e) }));
  }
}

// --- Router ---

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(controller.cron === RETENTION_CRON ? basinRetentionTick(env) : scheduled(env));
  },

  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const path = new URL(request.url).pathname;

    // Health check (GET)
    if (path === "/health") {
      if (request.method !== "GET") {
        return errorResponse(405, "Method not allowed");
      }
      return jsonResponse({ status: "ok" });
    }

    // Admin API. Must be dispatched before the POST-only gate below, which
    // would otherwise 405 the GET/PATCH/DELETE verbs this API needs. Note
    // this also means it must come before the old blanket GET/POST-only
    // gate that used to sit here — PATCH/DELETE need to reach this branch.
    if (path === "/v1/keys" || path.startsWith("/v1/keys/")) {
      let adminKey: APIKeyRecord;
      try {
        adminKey = (await authenticate(request, env, ctx)).record;
      } catch (e) {
        if (e instanceof AuthError) return withRetryAfter(errorResponse(e.status, e.message), e);
        return errorResponse(500, "Internal error");
      }
      return await handleAdminKeys(request, env.KEYS_DB, adminKey, env.KEY_CACHE_NAMESPACE);
    }

    const read = readPath(path);
    if (read) return await handleRead(request, env, ctx, read, read === path);

    if (request.method !== "POST") {
      return errorResponse(405, "Method not allowed");
    }

    // Timing starts here: everything above is either a cheap string check or
    // a path that never touches D1 or Basin. The auth span below is the
    // first I/O the request does.
    const trace = new RequestTrace();
    const receivedAt = new Date();

    // Authenticate
    let key: APIKeyRecord;
    try {
      key = (await authenticate(request, env, ctx, trace)).record;
    } catch (e) {
      trace.mark("auth");
      // A slow *failing* auth is the most diagnostic case there is: a stalled
      // D1 surfaces here as a 500 "Key store unavailable", and without this
      // the one request that proves the key store is the bottleneck would be
      // the one request that goes unreported.
      const status = e instanceof AuthError ? e.status : 500;
      reportIfSlow(request, env, ctx, trace, {
        route: path,
        format: "unknown",
        status,
        ingestSource: "",
      });
      const res = errorResponse(
        status,
        e instanceof AuthError ? e.message : "Internal error",
      );
      return e instanceof AuthError ? withRetryAfter(res, e) : res;
    }
    trace.mark("auth");
    const source = key.name;

    // Route. The lookup stays after auth: an unauthenticated request to an
    // unknown path must still get 401, not 404.
    const format = ROUTE_FORMATS[path as keyof typeof ROUTE_FORMATS] as
      | BasinFormat
      | undefined;
    if (!format) return errorResponse(404, "Not found");

    const ingest: IngestRequest = {
      request,
      env,
      ctx,
      trace,
      route: path,
      source,
      keyId: key.keyId,
      receivedAt,
    };

    let response: Response;
    try {
      switch (format) {
        case "clef":
          response = await handleCLEF(ingest);
          break;
        case "webhook":
          response = await handleWebhook(ingest);
          break;
        case "otlp-logs":
        case "otlp-traces":
          response = await handleOTLP(ingest, format);
          break;
      }
    } catch (e) {
      // A body the client can fix still spent real time in `read`, so it is
      // worth reporting when it was slow. An unrecognised throw is left to
      // become a 500, which Workers Logs records as an exception outcome.
      //
      // Both errors caught here originate in `readBody`, which throws *after*
      // stream I/O — so the clock has moved and the handler never reached its
      // own `trace.mark("read")`. Close the span here or a slow oversized body
      // reports a large TotalMs against an all-zero breakdown, which is the
      // one thing this instrumentation exists to prevent.
      trace.mark("read");
      if (e instanceof BodyTooLargeError) {
        response = errorResponse(413, e.message);
      } else if (e instanceof BadBodyError) {
        response = errorResponse(400, e.message);
      } else {
        throw e;
      }
    }

    reportIfSlow(request, env, ctx, trace, {
      route: path,
      format,
      status: response.status,
      ingestSource: source,
    });

    return response;
  },
};
