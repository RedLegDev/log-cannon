import { NextRequest, NextResponse } from 'next/server';
import { lookupKey } from './key-registry';

export type ApiScope = 'ingest' | 'read' | 'write' | 'admin';

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

  try {
    const record = await lookupKey(apiKey);
    if (!record || !record.enabled) {
      return apiError('unauthorized', 'Invalid or disabled API key', 401);
    }

    const scopes = record.scopes as ApiScope[];
    if (!hasScope(scopes, requiredScope)) {
      return apiError(
        'forbidden',
        `This key lacks the required '${requiredScope}' scope`,
        403
      );
    }

    return { keyId: record.keyId, keyName: record.name, scopes };
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
