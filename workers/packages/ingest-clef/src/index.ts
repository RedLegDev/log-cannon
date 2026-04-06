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

    // Read raw body and enqueue
    const bodyBytes = await request.arrayBuffer();
    const body = btoa(
      String.fromCharCode(...new Uint8Array(bodyBytes)),
    );

    const payload: QueuePayload = {
      format: "clef",
      source,
      body,
      contentType: request.headers.get("Content-Type") ?? "application/json",
    };

    await env.INGEST_QUEUE.send(payload);

    return new Response(
      JSON.stringify({ MinimumLevelAccepted: null }),
      {
        status: 201,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      },
    );
  },
};
