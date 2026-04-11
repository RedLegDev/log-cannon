// --- Types ---

interface APIKeyEntry {
  name: string;
  enabled: boolean;
}

interface Env {
  INGEST_QUEUE: Queue<QueuePayload>;
  API_KEYS: KVNamespace;
  DISCOVERY_MODE?: string;
}

interface QueuePayload {
  format: "clef" | "webhook" | "otlp-logs" | "otlp-traces";
  source: string;
  /** Raw request body, base64-encoded (queue messages are JSON). */
  body: string;
  contentType: string;
  preset?: string;
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

// In-memory API key cache, scoped to the Worker isolate. Cloudflare reuses
// isolates across many requests, so a Map populated by one request serves
// hits for all subsequent requests in the same isolate at zero KV cost.
// At ~10 distinct API keys × ~27M requests/month, this drops KV reads from
// ~27M to roughly (isolate recycles × distinct keys) — typically <1% of the
// uncached rate.
//
// Trade-off: when a key is disabled or deleted in KV, warm isolates serve
// the stale cached entry for up to KEY_CACHE_TTL_MS. Acceptable for an
// ingest endpoint where compromise response is "rotate + redeploy", not
// "instant revoke."
interface CachedKey {
  entry: APIKeyEntry;
  expiresAt: number;
}
const KEY_CACHE = new Map<string, CachedKey>();
const KEY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function validateAPIKey(apiKey: string, env: Env): Promise<string> {
  const now = Date.now();

  const cached = KEY_CACHE.get(apiKey);
  if (cached && cached.expiresAt > now) {
    if (!cached.entry.enabled) throw new Error("API key is disabled");
    return cached.entry.name;
  }

  const entry = await env.API_KEYS.get<APIKeyEntry>(apiKey, "json");

  if (entry) {
    KEY_CACHE.set(apiKey, { entry, expiresAt: now + KEY_CACHE_TTL_MS });
    if (!entry.enabled) throw new Error("API key is disabled");
    return entry.name;
  }

  if (env.DISCOVERY_MODE === "true") {
    const name = `discovered-${apiKey.slice(0, 8)}`;
    const newEntry: APIKeyEntry = { name, enabled: true };
    await env.API_KEYS.put(apiKey, JSON.stringify(newEntry));
    KEY_CACHE.set(apiKey, { entry: newEntry, expiresAt: now + KEY_CACHE_TTL_MS });
    return name;
  }

  throw new Error("Invalid API key");
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

async function authenticate(request: Request, env: Env): Promise<string> {
  const apiKey = extractAPIKey(request);
  if (!apiKey) throw new AuthError(401, "API key required");

  try {
    return await validateAPIKey(apiKey, env);
  } catch {
    throw new AuthError(403, "Invalid or disabled API key");
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

  // Fast path: small bodies go in a single queue message.
  if (bodyBytes.byteLength <= MAX_QUEUE_CHUNK_BYTES) {
    await env.INGEST_QUEUE.send({
      format: "clef",
      source,
      body: encodeBody(bodyBytes),
      contentType,
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

  // Send each chunk as its own queue message. If a send partway through
  // throws, the producer retries the whole batch — chunks already enqueued
  // produce duplicates downstream. The previous single-message path also
  // duplicated on every send-failure retry, so this is no worse.
  for (const chunk of chunks) {
    await env.INGEST_QUEUE.send({
      format: "clef",
      source,
      body: encodeBody(chunk),
      contentType,
    });
  }

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

  await env.INGEST_QUEUE.send({
    format,
    source,
    body: encodeBody(bodyBytes),
    contentType:
      request.headers.get("Content-Type") ?? "application/x-protobuf",
  });

  const key = format === "otlp-logs" ? "rejectedLogRecords" : "rejectedSpans";
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
    let source: string;
    try {
      source = await authenticate(request, env);
    } catch (e) {
      if (e instanceof AuthError) return errorResponse(e.status, e.message);
      return errorResponse(500, "Internal error");
    }

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
