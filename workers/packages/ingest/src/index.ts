import type { Env, QueuePayload } from "@log-cannon/shared";
import {
  extractAPIKey,
  validateAPIKey,
  handleOptions,
  errorResponse,
  corsHeaders,
} from "@log-cannon/shared";

/**
 * Read the request body, handling gzip decompression if present.
 */
async function readBody(request: Request): Promise<ArrayBuffer> {
  if (request.headers.get("Content-Encoding") === "gzip") {
    const ds = new DecompressionStream("gzip");
    const decompressed = request.body!.pipeThrough(ds);
    return new Response(decompressed).arrayBuffer();
  }
  return request.arrayBuffer();
}

/** Base64-encode an ArrayBuffer for queue transport. */
function encodeBody(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

/** Authenticate the request. Returns the source name. */
async function authenticate(request: Request, env: Env): Promise<string> {
  const apiKey = extractAPIKey(request);
  if (!apiKey) throw new AuthError(401, "API key required");

  try {
    return await validateAPIKey(apiKey, env);
  } catch {
    throw new AuthError(403, "Invalid or disabled API key");
  }
}

class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// --- Route handlers ---

async function handleCLEF(
  request: Request,
  env: Env,
  source: string,
): Promise<Response> {
  const bodyBytes = await request.arrayBuffer();

  const payload: QueuePayload = {
    format: "clef",
    source,
    body: encodeBody(bodyBytes),
    contentType: request.headers.get("Content-Type") ?? "application/json",
  };

  await env.INGEST_QUEUE.send(payload);

  return new Response(JSON.stringify({ MinimumLevelAccepted: null }), {
    status: 201,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
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

  const payload: QueuePayload = {
    format: "webhook",
    source,
    body: encodeBody(bodyBytes),
    contentType: request.headers.get("Content-Type") ?? "application/json",
    preset: preset || undefined,
  };

  await env.INGEST_QUEUE.send(payload);

  return new Response(JSON.stringify({ accepted: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function handleOTLP(
  request: Request,
  env: Env,
  source: string,
  format: "otlp-logs" | "otlp-traces",
): Promise<Response> {
  const bodyBytes = await readBody(request);

  const payload: QueuePayload = {
    format,
    source,
    body: encodeBody(bodyBytes),
    contentType:
      request.headers.get("Content-Type") ?? "application/x-protobuf",
  };

  await env.INGEST_QUEUE.send(payload);

  const responseKey =
    format === "otlp-logs" ? "rejectedLogRecords" : "rejectedSpans";

  return new Response(
    JSON.stringify({ partialSuccess: { [responseKey]: 0, errorMessage: "" } }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    },
  );
}

// --- Router ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return handleOptions();
    if (request.method !== "POST") {
      return errorResponse(405, "Method not allowed");
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Authenticate (shared across all routes)
    let source: string;
    try {
      source = await authenticate(request, env);
    } catch (e) {
      if (e instanceof AuthError) return errorResponse(e.status, e.message);
      return errorResponse(500, "Internal error");
    }

    // Route to handler
    if (path === "/ingest/clef" || path === "/api/events/raw") {
      return handleCLEF(request, env, source);
    }

    if (path === "/ingest/webhook") {
      return handleWebhook(request, env, source);
    }

    if (
      path === "/ingest/otlp/logs" ||
      path === "/v1/logs"
    ) {
      return handleOTLP(request, env, source, "otlp-logs");
    }

    if (
      path === "/ingest/otlp/traces" ||
      path === "/v1/traces"
    ) {
      return handleOTLP(request, env, source, "otlp-traces");
    }

    if (path === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return errorResponse(404, "Not found");
  },
};
