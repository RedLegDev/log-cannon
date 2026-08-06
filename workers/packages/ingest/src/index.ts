// --- Types ---

import { validateKey, type APIKeyRecord } from "./keys";

interface Env {
  INGEST_QUEUE: Queue<QueuePayload>;
  KEYS_DB: D1Database;
  DISCOVERY_MODE?: string;
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

async function readBody(request: Request): Promise<Uint8Array> {
  let stream: ReadableStream<Uint8Array>;

  if (request.headers.get("Content-Encoding") === "gzip") {
    const ds = new DecompressionStream("gzip");
    stream = request.body!.pipeThrough(ds);
  } else {
    stream = request.body!;
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;

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

  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds 32 MB limit");
  }
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

async function authenticate(
  request: Request,
  env: Env,
): Promise<APIKeyRecord> {
  const apiKey = extractAPIKey(request);
  if (!apiKey) throw new AuthError(401, "API key required");

  // Distinguish a known auth rejection (bad/disabled key — genuinely the
  // client's fault, safe as a non-retryable 4xx) from everything else (D1
  // outage, query timeout, schema drift — the client did nothing wrong).
  // Seq/Serilog sinks treat 4xx as terminal and drop the batch but retry
  // 5xx, so collapsing both cases into 403 turns a transient D1 blip into
  // silent, permanent log loss across every client at once.
  try {
    return await validateKey(apiKey, env.KEYS_DB);
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
): Promise<Response> {
  const bodyBytes = await readBody(request);
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

  return jsonResponse({ MinimumLevelAccepted: null }, 201);
}

async function handleWebhook(
  request: Request,
  env: Env,
  source: string,
): Promise<Response> {
  const bodyBytes = await readBody(request);

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

  return jsonResponse({ accepted: true });
}

async function handleOTLP(
  request: Request,
  env: Env,
  source: string,
  format: "otlp-logs" | "otlp-traces",
): Promise<Response> {
  const bodyBytes = await readBody(request);
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

  return jsonResponse({ partialSuccess: { [key]: 0, errorMessage: "" } });
}

// --- Router ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "POST" && request.method !== "GET") {
      return errorResponse(405, "Method not allowed");
    }

    const path = new URL(request.url).pathname;

    // Health check (GET)
    if (path === "/health") {
      return jsonResponse({ status: "ok" });
    }

    if (request.method !== "POST") {
      return errorResponse(405, "Method not allowed");
    }

    // Authenticate
    let key: APIKeyRecord;
    try {
      key = await authenticate(request, env);
    } catch (e) {
      if (e instanceof AuthError) return errorResponse(e.status, e.message);
      return errorResponse(500, "Internal error");
    }
    const source = key.name;

    // Route
    try {
      if (path === "/ingest/clef" || path === "/api/events/raw") {
        return await handleCLEF(request, env, source);
      }
      if (path === "/ingest/webhook") {
        return await handleWebhook(request, env, source);
      }
      if (path === "/ingest/otlp/logs" || path === "/v1/logs") {
        return await handleOTLP(request, env, source, "otlp-logs");
      }
      if (path === "/ingest/otlp/traces" || path === "/v1/traces") {
        return await handleOTLP(request, env, source, "otlp-traces");
      }
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        return errorResponse(413, e.message);
      }
      throw e;
    }

    return errorResponse(404, "Not found");
  },
};
