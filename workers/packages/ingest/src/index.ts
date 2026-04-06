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

async function validateAPIKey(apiKey: string, env: Env): Promise<string> {
  const entry = await env.API_KEYS.get<APIKeyEntry>(apiKey, "json");

  if (entry) {
    if (!entry.enabled) throw new Error("API key is disabled");
    return entry.name;
  }

  if (env.DISCOVERY_MODE === "true") {
    const name = `discovered-${apiKey.slice(0, 8)}`;
    await env.API_KEYS.put(apiKey, JSON.stringify({ name, enabled: true }));
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

async function readBody(request: Request): Promise<ArrayBuffer> {
  if (request.headers.get("Content-Encoding") === "gzip") {
    const ds = new DecompressionStream("gzip");
    const decompressed = request.body!.pipeThrough(ds);
    return new Response(decompressed).arrayBuffer();
  }
  return request.arrayBuffer();
}

function encodeBody(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
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

  await env.INGEST_QUEUE.send({
    format: "clef",
    source,
    body: encodeBody(bodyBytes),
    contentType: request.headers.get("Content-Type") ?? "application/json",
  });

  return jsonResponse({ MinimumLevelAccepted: null }, 201);
}

async function handleWebhook(
  request: Request,
  env: Env,
  source: string,
): Promise<Response> {
  const bodyBytes = await readBody(request);
  const raw = new Uint8Array(bodyBytes);

  // Cloudflare Logpush validation handshake: non-JSON body → 200 OK
  if (raw.length === 0 || (raw[0] !== 0x7b && raw[0] !== 0x5b)) {
    return new Response(null, { status: 200 });
  }

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
    if (path === "/ingest/clef" || path === "/api/events/raw") {
      return handleCLEF(request, env, source);
    }
    if (path === "/ingest/webhook") {
      return handleWebhook(request, env, source);
    }
    if (path === "/ingest/otlp/logs" || path === "/v1/logs") {
      return handleOTLP(request, env, source, "otlp-logs");
    }
    if (path === "/ingest/otlp/traces" || path === "/v1/traces") {
      return handleOTLP(request, env, source, "otlp-traces");
    }

    return errorResponse(404, "Not found");
  },
};
