import type { Env, QueuePayload } from "@log-cannon/shared";
import {
  extractAPIKey,
  validateAPIKey,
  handleOptions,
  errorResponse,
  corsHeaders,
} from "@log-cannon/shared";

/**
 * Determine the OTel format (logs or traces) from the request path.
 * Supports /ingest/otlp/logs, /ingest/otlp/traces, /v1/logs, /v1/traces.
 */
function formatFromPath(pathname: string): "otlp-logs" | "otlp-traces" | null {
  if (pathname.endsWith("/logs")) return "otlp-logs";
  if (pathname.endsWith("/traces")) return "otlp-traces";
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return handleOptions();
    if (request.method !== "POST") {
      return errorResponse(405, "Method not allowed");
    }

    const url = new URL(request.url);
    const format = formatFromPath(url.pathname);
    if (!format) {
      return errorResponse(404, "Unknown OTel path — use /v1/logs or /v1/traces");
    }

    // Authenticate
    const apiKey = extractAPIKey(request);
    if (!apiKey) return errorResponse(401, "API key required");

    let source: string;
    try {
      source = await validateAPIKey(apiKey, env);
    } catch {
      return errorResponse(403, "Invalid or disabled API key");
    }

    // Decompress gzip if needed, then read raw body
    let bodyBytes: ArrayBuffer;
    if (request.headers.get("Content-Encoding") === "gzip") {
      const ds = new DecompressionStream("gzip");
      const decompressed = request.body!.pipeThrough(ds);
      const resp = new Response(decompressed);
      bodyBytes = await resp.arrayBuffer();
    } else {
      bodyBytes = await request.arrayBuffer();
    }

    const body = btoa(String.fromCharCode(...new Uint8Array(bodyBytes)));

    const payload: QueuePayload = {
      format,
      source,
      body,
      contentType: request.headers.get("Content-Type") ?? "application/x-protobuf",
    };

    await env.INGEST_QUEUE.send(payload);

    // Return format matching what OTel SDKs expect
    const responseKey =
      format === "otlp-logs" ? "rejectedLogRecords" : "rejectedSpans";

    return new Response(
      JSON.stringify({
        partialSuccess: { [responseKey]: 0, errorMessage: "" },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      },
    );
  },
};
