import type { Env, QueuePayload } from "@log-cannon/shared";
import {
  extractAPIKey,
  validateAPIKey,
  handleOptions,
  errorResponse,
  corsHeaders,
} from "@log-cannon/shared";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return handleOptions();
    if (request.method !== "POST") {
      return errorResponse(405, "Method not allowed");
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

    const raw = new Uint8Array(bodyBytes);

    // Handle Cloudflare Logpush validation handshake: if the body doesn't
    // start with '{' or '[', it's a test payload — just return 200.
    if (raw.length === 0 || (raw[0] !== 0x7b && raw[0] !== 0x5b)) {
      return new Response(null, { status: 200 });
    }

    const body = btoa(String.fromCharCode(...raw));

    const preset = new URL(request.url).searchParams.get("preset") ?? "";

    const payload: QueuePayload = {
      format: "webhook",
      source,
      body,
      contentType: request.headers.get("Content-Type") ?? "application/json",
      preset: preset || undefined,
    };

    await env.INGEST_QUEUE.send(payload);

    return new Response(
      JSON.stringify({ accepted: true }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      },
    );
  },
};
