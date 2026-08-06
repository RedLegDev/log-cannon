import {
  createKey,
  deleteKey,
  hasScope,
  invalidScopes,
  listKeys,
  parseScopes,
  updateKey,
  type APIKeyRecord,
} from "./keys";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Admin API for the key registry. This is the only write path into `api_keys`
 * — the dashboard calls it rather than writing a store of its own, so the
 * path that creates a key is the path that authenticates it.
 */
export async function handleAdminKeys(
  request: Request,
  db: D1Database,
  key: APIKeyRecord,
): Promise<Response> {
  if (!hasScope(key, "admin")) {
    return json({ error: "admin scope required" }, 403);
  }

  const path = new URL(request.url).pathname;
  const keyId = path.startsWith("/v1/keys/")
    ? decodeURIComponent(path.slice("/v1/keys/".length))
    : null;

  if (!keyId) {
    if (request.method === "GET") {
      const keys = await listKeys(db);
      return json({ keys });
    }

    if (request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        name?: string;
        scopes?: string | string[];
      } | null;

      if (!body?.name || typeof body.name !== "string" || !body.name.trim()) {
        return json({ error: "name is required" }, 400);
      }

      const scopeList = Array.isArray(body.scopes)
        ? body.scopes
        : parseScopes(body.scopes ?? "ingest");
      const bad = invalidScopes(scopeList);
      if (bad.length > 0) {
        return json({ error: `Invalid scopes: ${bad.join(", ")}` }, 400);
      }

      const created = await createKey(db, body.name.trim(), scopeList.join(","));
      return json(created, 201);
    }

    return json({ error: "Method not allowed" }, 405);
  }

  if (request.method === "PATCH") {
    const body = (await request.json().catch(() => null)) as {
      name?: string;
      enabled?: boolean;
      scopes?: string | string[];
      retentionDays?: number;
    } | null;
    if (!body) return json({ error: "Invalid JSON body" }, 400);

    if (body.scopes !== undefined) {
      const scopeList = Array.isArray(body.scopes)
        ? body.scopes
        : parseScopes(body.scopes);
      const bad = invalidScopes(scopeList);
      if (bad.length > 0) {
        return json({ error: `Invalid scopes: ${bad.join(", ")}` }, 400);
      }
      body.scopes = scopeList.join(",");
    }

    if (
      body.retentionDays !== undefined &&
      (!Number.isInteger(body.retentionDays) || body.retentionDays < 0)
    ) {
      return json({ error: "retentionDays must be an integer >= 0" }, 400);
    }

    const changed = await updateKey(db, keyId, {
      name: body.name,
      enabled: body.enabled,
      scopes: body.scopes as string | undefined,
      retentionDays: body.retentionDays,
    });
    if (!changed) return json({ error: "Key not found or no fields to update" }, 404);
    return json({ success: true });
  }

  if (request.method === "DELETE") {
    const deleted = await deleteKey(db, keyId);
    if (!deleted) return json({ error: "Key not found" }, 404);
    return json({ success: true });
  }

  return json({ error: "Method not allowed" }, 405);
}
