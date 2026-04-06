import type { APIKeyEntry, Env } from "./types";

/**
 * Extract API key from request headers/query params.
 * Checks (in order): X-Api-Key, X-Seq-ApiKey, ?apiKey, Authorization: Bearer.
 */
export function extractAPIKey(request: Request): string {
  const headers = request.headers;

  const xApiKey = headers.get("X-Api-Key");
  if (xApiKey) return xApiKey;

  const xSeqApiKey = headers.get("X-Seq-ApiKey");
  if (xSeqApiKey) return xSeqApiKey;

  const url = new URL(request.url);
  const queryKey = url.searchParams.get("apiKey");
  if (queryKey) return queryKey;

  const auth = headers.get("Authorization");
  if (auth && auth.startsWith("Bearer ")) {
    return auth.slice(7);
  }

  return "";
}

/**
 * Validate an API key against KV. Returns the source name on success.
 * In discovery mode, unknown keys are auto-provisioned in KV.
 */
export async function validateAPIKey(
  apiKey: string,
  env: Env,
): Promise<string> {
  const entry = await env.API_KEYS.get<APIKeyEntry>(apiKey, "json");

  if (entry) {
    if (!entry.enabled) {
      throw new Error("API key is disabled");
    }
    return entry.name;
  }

  // Discovery mode: auto-provision unknown keys
  if (env.DISCOVERY_MODE === "true") {
    const prefix = apiKey.slice(0, 8);
    const name = `discovered-${prefix}`;
    const newEntry: APIKeyEntry = { name, enabled: true };
    await env.API_KEYS.put(apiKey, JSON.stringify(newEntry));
    return name;
  }

  throw new Error("Invalid API key");
}

/** Standard CORS headers for ingest endpoints. */
export function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Seq-ApiKey, X-Api-Key, Authorization",
  };
}

/** Handle CORS preflight. */
export function handleOptions(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

/** Return a JSON error response. */
export function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ Error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}
