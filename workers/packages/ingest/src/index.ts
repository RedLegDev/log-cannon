// --- Types ---

import { validateKey, isKeyCached, type APIKeyRecord } from "./keys";
import { handleAdminKeys } from "./admin";
import {
  RequestTrace,
  buildSlowRequest,
  resolveSlowRequestMs,
  shouldEmitTelemetry,
  slowRequestCLEF,
} from "./timing";

interface Env {
  INGEST_QUEUE: Queue<QueuePayload>;
  KEYS_DB: D1Database;
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
}

interface QueuePayload {
  format: "clef" | "webhook" | "otlp-logs" | "otlp-traces";
  source: string;
  /** Raw request body, base64-encoded (queue messages are JSON). */
  body: string;
  contentType: string;
  preset?: string;
  /**
   * Request-scoped Cloudflare geo/network context captured once at the edge
   * (from `request.cf` + headers). The consumer applies these as event
   * properties, filling only keys the event doesn't already carry — never
   * overwriting a value the caller stamped itself. Keys here are the exact
   * property names downstream analytics read (cf_asn, geo_*, cf_is_bot,
   * user_agent). Currently attached on the CLEF path only.
   */
  enrich?: Record<string, string>;
}

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
 * consumer can enrich events that lack it (e.g. browser beacons, which carry
 * a real user IP but can't self-report ASN/geo). Keys match the exact property
 * names downstream analytics already read. No raw client IP is captured (PII).
 *
 * Returns undefined only when nothing at all is available, keeping the queue
 * payload byte-identical to before on that path — so this is a pure no-op for
 * ingest when there's nothing to add and can't fail the request.
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

// Maximum raw bytes per Cloudflare Queue message after chunking. CF Queues
// hard-cap each message at 128 KB. Base64 inflates payloads by ~33%, plus
// the JSON wrapper around the QueuePayload (~100 bytes). 90 KB raw stays
// safely under the cap: 90 KB * 4/3 + ~100 ≈ 123 KB encoded.
const MAX_QUEUE_CHUNK_BYTES = 90 * 1024;

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

function encodeBody(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// CF Queues sendBatch caps at 256 KB total per call. Use 240 KB to leave
// headroom for the JSON envelope CF wraps around the message array.
const MAX_BATCH_BYTES = 240 * 1024;

/**
 * Pack chunks into one or more sendBatch calls under the 256 KB-per-call
 * cap. Each batch is one HTTP round trip — for an 8-chunk OTLP request at
 * ~120 KB encoded each, this collapses 8 awaited sends into ~4 awaited
 * batches. Same duplicate-on-retry semantic as the previous per-chunk
 * loop: if a later batch fails after earlier batches enqueued, the
 * producer retries the whole request and downstream sees duplicates.
 */
async function sendChunksBatched(
  queue: Queue<QueuePayload>,
  chunks: Uint8Array[],
  base: Omit<QueuePayload, "body">,
): Promise<void> {
  const baseOverhead = JSON.stringify({ ...base, body: "" }).length;

  let batch: MessageSendRequest<QueuePayload>[] = [];
  let batchBytes = 0;

  for (const chunk of chunks) {
    const encoded = encodeBody(chunk);
    const msgBytes = baseOverhead + encoded.length;

    if (batch.length > 0 && batchBytes + msgBytes > MAX_BATCH_BYTES) {
      await queue.sendBatch(batch);
      batch = [];
      batchBytes = 0;
    }

    batch.push({ body: { ...base, body: encoded } });
    batchBytes += msgBytes;
  }

  if (batch.length > 0) {
    await queue.sendBatch(batch);
  }
}

/**
 * Split an OTLP protobuf body (ExportLogsServiceRequest or
 * ExportTraceServiceRequest) into chunks at the top-level repeated field
 * boundary. In both messages the repeated `resource_logs` / `resource_spans`
 * field uses field number 1, wire type 2 (length-delimited), so the tag byte
 * is 0x0a. Concatenating any subset of those length-delimited entries yields
 * a valid OTLP request containing only those resources — the consumer
 * processes each chunk as an independent batch.
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
    if (i - entryStart > MAX_QUEUE_CHUNK_BYTES) return null;
    entries.push({ start: entryStart, end: i });
  }

  if (entries.length === 0) return null;

  // Pass 2: greedy-pack contiguous entries into chunks under the limit.
  const chunks: Uint8Array[] = [];
  let chunkStart = entries[0].start;
  let chunkEnd = entries[0].end;
  for (let idx = 1; idx < entries.length; idx++) {
    const e = entries[idx];
    if (e.end - chunkStart > MAX_QUEUE_CHUNK_BYTES) {
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
 * top-level array as a fresh request, so the consumer parses it identically.
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
    if (s.byteLength + wrapperOverhead > MAX_QUEUE_CHUNK_BYTES) return null;
  }

  const chunks: Uint8Array[] = [];
  let groupStart = 0;
  let groupBodySize = serialized[0].byteLength;
  for (let i = 1; i < serialized.length; i++) {
    const addedSize = 1 + serialized[i].byteLength; // +1 for comma separator
    if (groupBodySize + addedSize + wrapperOverhead > MAX_QUEUE_CHUNK_BYTES) {
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
 * under MAX_QUEUE_CHUNK_BYTES. Each returned chunk is itself a valid CLEF
 * payload, so the queue-consumer processes it identically to a single
 * smaller request.
 *
 * Returns null if any single line is larger than MAX_QUEUE_CHUNK_BYTES —
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
    if (lineLength > MAX_QUEUE_CHUNK_BYTES) {
      return null; // single line cannot fit in any queue message
    }

    // If appending this line would push the in-progress chunk over the
    // limit, flush what we have first and start a new chunk at this line.
    if (lineEnd - chunkStart > MAX_QUEUE_CHUNK_BYTES && i > chunkStart) {
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
  ) {
    super(message);
  }
}

interface AuthResult {
  record: APIKeyRecord;
  /** Whether the key was resolved from this isolate's cache, skipping D1. */
  cacheHit: boolean;
}

async function authenticate(
  request: Request,
  env: Env,
): Promise<AuthResult> {
  const apiKey = extractAPIKey(request);
  if (!apiKey) throw new AuthError(401, "API key required");

  // Peek before resolving: validateKey populates the cache, so asking
  // afterwards would always say "hit".
  const cacheHit = isKeyCached(apiKey);

  // Distinguish a known auth rejection (bad/disabled key — genuinely the
  // client's fault, safe as a non-retryable 4xx) from everything else (D1
  // outage, query timeout, schema drift — the client did nothing wrong).
  // Seq/Serilog sinks treat 4xx as terminal and drop the batch but retry
  // 5xx, so collapsing both cases into 403 turns a transient D1 blip into
  // silent, permanent log loss across every client at once.
  try {
    return { record: await validateKey(apiKey, env.KEYS_DB), cacheHit };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "Invalid API key" || msg === "API key is disabled") {
      throw new AuthError(403, "Invalid or disabled API key");
    }
    throw new AuthError(500, "Key store unavailable");
  }
}

// --- Route handlers ---

async function handleCLEF(
  request: Request,
  env: Env,
  source: string,
  trace: RequestTrace,
): Promise<Response> {
  const bodyBytes = await readBody(request);
  trace.mark("read");
  trace.bodyBytes = bodyBytes.byteLength;
  const contentType =
    request.headers.get("Content-Type") ?? "application/json";
  const enrich = buildEnrichment(request);

  // Fast path: small bodies go in a single queue message.
  if (bodyBytes.byteLength <= MAX_QUEUE_CHUNK_BYTES) {
    await env.INGEST_QUEUE.send({
      format: "clef",
      source,
      body: encodeBody(bodyBytes),
      contentType,
      enrich,
    });
    trace.mark("enqueue");
    trace.queueMessages = 1;
    return jsonResponse({ MinimumLevelAccepted: null }, 201);
  }

  // Large body: split CLEF (newline-delimited JSON) into chunks that each
  // fit under the CF Queue per-message limit. Without this the entire body
  // is enqueued as a single message and CF Queues' 128 KB cap rejects it,
  // surfacing as a 5xx the producer's Serilog sink retries forever.
  const chunks = chunkCLEFBody(bodyBytes);
  if (chunks === null) {
    return errorResponse(
      413,
      `CLEF event exceeds ${MAX_QUEUE_CHUNK_BYTES} byte queue chunk limit`,
    );
  }

  await sendChunksBatched(env.INGEST_QUEUE, chunks, {
    format: "clef",
    source,
    contentType,
    enrich,
  });
  trace.mark("enqueue");
  trace.queueMessages = chunks.length;

  return jsonResponse({ MinimumLevelAccepted: null }, 201);
}

async function handleWebhook(
  request: Request,
  env: Env,
  source: string,
  trace: RequestTrace,
): Promise<Response> {
  const bodyBytes = await readBody(request);
  trace.mark("read");
  trace.bodyBytes = bodyBytes.byteLength;

  // Cloudflare Logpush validation handshake: non-JSON body → 200 OK
  if (
    bodyBytes.length === 0 ||
    (bodyBytes[0] !== 0x7b && bodyBytes[0] !== 0x5b)
  ) {
    return new Response(null, { status: 200 });
  }

  // NOTE: webhook bodies are also pushed as a single queue message and will
  // hit the same CF Queue 128 KB limit if they exceed ~96 KB raw. Webhooks
  // aren't newline-delimited so chunking is format-specific — left for a
  // follow-up if a webhook producer ever exceeds the cap.
  const preset = new URL(request.url).searchParams.get("preset") ?? "";

  await env.INGEST_QUEUE.send({
    format: "webhook",
    source,
    body: encodeBody(bodyBytes),
    contentType: request.headers.get("Content-Type") ?? "application/json",
    preset: preset || undefined,
  });
  trace.mark("enqueue");
  trace.queueMessages = 1;

  return jsonResponse({ accepted: true });
}

async function handleOTLP(
  request: Request,
  env: Env,
  source: string,
  format: "otlp-logs" | "otlp-traces",
  trace: RequestTrace,
): Promise<Response> {
  const bodyBytes = await readBody(request);
  trace.mark("read");
  trace.bodyBytes = bodyBytes.byteLength;
  const contentType =
    request.headers.get("Content-Type") ?? "application/x-protobuf";
  const key = format === "otlp-logs" ? "rejectedLogRecords" : "rejectedSpans";

  // Fast path: small bodies go in a single queue message.
  if (bodyBytes.byteLength <= MAX_QUEUE_CHUNK_BYTES) {
    await env.INGEST_QUEUE.send({
      format,
      source,
      body: encodeBody(bodyBytes),
      contentType,
    });
    trace.mark("enqueue");
    trace.queueMessages = 1;
    return jsonResponse({ partialSuccess: { [key]: 0, errorMessage: "" } });
  }

  // Large body: split the OTLP request at resource_logs/resource_spans
  // boundaries so each queue message stays under CF's 128 KB per-message
  // cap. Without this the entire batch is enqueued as one message and CF
  // Queues rejects it, surfacing as a 5xx that CF Workers Observability
  // retries (and eventually drops) — exactly the symptom we saw on
  // the /v1/logs route. Dispatch matches the consumer's
  // content-type rule (queue-consumer/otlp.go): exact protobuf media types
  // get the protobuf splitter; everything else is treated as JSON.
  const isProtobuf =
    contentType === "application/x-protobuf" ||
    contentType === "application/proto";
  const chunks = isProtobuf
    ? chunkOTLPBody(bodyBytes)
    : chunkJSONOTLPBody(bodyBytes, format);
  if (chunks === null) {
    return errorResponse(
      413,
      `OTLP resource entry exceeds ${MAX_QUEUE_CHUNK_BYTES} byte queue chunk limit`,
    );
  }

  await sendChunksBatched(env.INGEST_QUEUE, chunks, {
    format,
    source,
    contentType,
  });
  trace.mark("enqueue");
  trace.queueMessages = chunks.length;

  return jsonResponse({ partialSuccess: { [key]: 0, errorMessage: "" } });
}

// --- Slow-request reporting ---

/**
 * Report an ingest request that took at least `SLOW_REQUEST_MS` in the Worker.
 *
 * Two channels, deliberately independent:
 *
 * - `console.warn`, retained by Workers Logs (`[observability]` in
 *   `wrangler.toml`). Costs nothing and survives the case that matters most —
 *   a queue that is itself the slow thing.
 * - A CLEF event on `SLOW_REQUEST_SOURCE`, enqueued in `waitUntil` so it never
 *   adds latency to the caller's request, and throttled per isolate. This is
 *   the channel the dashboard, MCP and `alert-worker` can already read, so
 *   alerting on ingest degradation needs no new machinery.
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
    ctx.waitUntil(
      env.INGEST_QUEUE.send({
        format: "clef",
        source: telemetrySource,
        body: encodeBody(new TextEncoder().encode(line)),
        contentType: "application/vnd.serilog.clef",
      }).catch((e: unknown) => {
        console.warn(
          JSON.stringify({
            event: "slow-ingest-report-failed",
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      }),
    );
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "slow-ingest-report-failed",
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}

// --- Router ---

export default {
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
        adminKey = (await authenticate(request, env)).record;
      } catch (e) {
        if (e instanceof AuthError) return errorResponse(e.status, e.message);
        return errorResponse(500, "Internal error");
      }
      return await handleAdminKeys(request, env.KEYS_DB, adminKey);
    }

    if (request.method !== "POST") {
      return errorResponse(405, "Method not allowed");
    }

    // Timing starts here: everything above is either a cheap string check or
    // a path that never touches D1 or the queue. The auth span below is the
    // first I/O the request does.
    const trace = new RequestTrace();

    // Authenticate
    let key: APIKeyRecord;
    try {
      const auth = await authenticate(request, env);
      key = auth.record;
      trace.keyCacheHit = auth.cacheHit;
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
      return errorResponse(
        status,
        e instanceof AuthError ? e.message : "Internal error",
      );
    }
    trace.mark("auth");
    const source = key.name;

    // Route
    let response: Response;
    // Set before each handler runs, so a throw still reports which parser the
    // request was headed for.
    let format = "unknown";
    try {
      if (path === "/ingest/clef" || path === "/api/events/raw") {
        format = "clef";
        response = await handleCLEF(request, env, source, trace);
      } else if (path === "/ingest/webhook") {
        format = "webhook";
        response = await handleWebhook(request, env, source, trace);
      } else if (path === "/ingest/otlp/logs" || path === "/v1/logs") {
        format = "otlp-logs";
        response = await handleOTLP(request, env, source, "otlp-logs", trace);
      } else if (path === "/ingest/otlp/traces" || path === "/v1/traces") {
        format = "otlp-traces";
        response = await handleOTLP(request, env, source, "otlp-traces", trace);
      } else {
        return errorResponse(404, "Not found");
      }
    } catch (e) {
      // A body the client can fix still spent real time in `read`, so it is
      // worth reporting when it was slow. An unrecognised throw is left to
      // become a 500, which Workers Logs records as an exception outcome.
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
