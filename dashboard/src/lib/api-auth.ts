import { NextRequest, NextResponse } from 'next/server';
import { queryClickHouse } from './clickhouse';

export type ApiScope = 'ingest' | 'read' | 'write' | 'admin';

interface ApiKeyRecord {
  key_id: string;
  api_key: string;
  name: string;
  scopes: string;
  enabled: number;
}

export interface AuthenticatedRequest {
  keyId: string;
  keyName: string;
  scopes: ApiScope[];
}

// Scope hierarchy: admin > write > read > ingest
const SCOPE_HIERARCHY: Record<ApiScope, ApiScope[]> = {
  admin: ['admin', 'write', 'read', 'ingest'],
  write: ['write', 'read', 'ingest'],
  read: ['read', 'ingest'],
  ingest: ['ingest'],
};

function parseScopes(scopesStr: string): ApiScope[] {
  if (!scopesStr) return ['ingest'];
  return scopesStr.split(',').map(s => s.trim()) as ApiScope[];
}

function hasScope(keyScopes: ApiScope[], requiredScope: ApiScope): boolean {
  for (const scope of keyScopes) {
    if (SCOPE_HIERARCHY[scope]?.includes(requiredScope)) {
      return true;
    }
  }
  return false;
}

export function apiError(
  error: string,
  message: string,
  status: number,
  details?: Record<string, unknown>
): NextResponse {
  return NextResponse.json(
    { error, message, ...(details && { details }) },
    { status }
  );
}

export async function authenticateApiKey(
  request: NextRequest,
  requiredScope: ApiScope
): Promise<AuthenticatedRequest | NextResponse> {
  // Extract API key from headers
  const apiKey =
    request.headers.get('x-api-key') ||
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');

  if (!apiKey) {
    return apiError('unauthorized', 'Missing API key. Provide X-Api-Key header or Authorization: Bearer <key>', 401);
  }

  // Look up the key
  const sql = `
    SELECT
      toString(key_id) as key_id,
      api_key,
      name,
      scopes,
      enabled
    FROM logs.api_keys
    WHERE api_key = '${apiKey.replace(/'/g, "''")}'
    LIMIT 1
  `;

  try {
    const results = await queryClickHouse<ApiKeyRecord>(sql);

    if (results.length === 0) {
      return apiError('unauthorized', 'Invalid API key', 401);
    }

    const key = results[0];

    if (!key.enabled) {
      return apiError('unauthorized', 'API key is disabled', 401);
    }

    const scopes = parseScopes(key.scopes);

    if (!hasScope(scopes, requiredScope)) {
      return apiError('forbidden', `API key lacks required scope: ${requiredScope}`, 403);
    }

    return {
      keyId: key.key_id,
      keyName: key.name,
      scopes,
    };
  } catch (error) {
    console.error('API key authentication error:', error);
    return apiError('internal_error', 'Authentication failed', 500);
  }
}

// Helper for route handlers
export function withApiAuth(requiredScope: ApiScope) {
  return async function authenticate(request: NextRequest): Promise<AuthenticatedRequest | NextResponse> {
    return authenticateApiKey(request, requiredScope);
  };
}
