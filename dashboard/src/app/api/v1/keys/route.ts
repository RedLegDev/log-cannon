import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError, ApiScope } from '@/lib/api-auth';
import { listKeys, createKey } from '@/lib/key-registry';
import { syncKeyPolicies } from '@/lib/key-policies';

const VALID_SCOPES: ApiScope[] = ['ingest', 'read', 'write', 'admin'];

// The D1 write is the source of truth and has already succeeded by the time
// this runs — a projection failure must never fail the key mutation.
async function syncKeyPoliciesBestEffort(): Promise<void> {
  try {
    await syncKeyPolicies();
  } catch (error) {
    console.error('Failed to sync key policies to ClickHouse:', error);
  }
}

function validateKeyInput(body: unknown): { valid: true; data: { name: string; scopes: string } } | { valid: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: { body: 'Request body is required' } };
  }

  const { name, scopes } = body as Record<string, unknown>;

  if (!name || typeof name !== 'string') {
    errors.name = 'Required field';
  }

  let scopesStr = 'read'; // Default scope
  if (scopes !== undefined) {
    if (typeof scopes === 'string') {
      const scopeList = scopes.split(',').map(s => s.trim());
      const invalidScopes = scopeList.filter(s => !VALID_SCOPES.includes(s as ApiScope));
      if (invalidScopes.length > 0) {
        errors.scopes = `Invalid scopes: ${invalidScopes.join(', ')}. Valid: ${VALID_SCOPES.join(', ')}`;
      } else {
        scopesStr = scopeList.join(',');
      }
    } else if (Array.isArray(scopes)) {
      const invalidScopes = scopes.filter(s => !VALID_SCOPES.includes(s as ApiScope));
      if (invalidScopes.length > 0) {
        errors.scopes = `Invalid scopes: ${invalidScopes.join(', ')}. Valid: ${VALID_SCOPES.join(', ')}`;
      } else {
        scopesStr = scopes.join(',');
      }
    } else {
      errors.scopes = 'Must be a string or array of scopes';
    }
  }

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    data: { name: name as string, scopes: scopesStr },
  };
}

export async function GET(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  try {
    const keys = await listKeys();

    // Don't expose the actual API key values
    const data = keys.map(k => ({
      id: k.keyId,
      name: k.name,
      // Show only prefix of key for identification
      key_prefix: k.apiKey.slice(0, 8) + '...',
      enabled: k.enabled,
      created_at: k.createdAt,
    }));

    return NextResponse.json({ data });
  } catch (error) {
    console.error('Error fetching API keys:', error);
    return apiError('internal_error', 'Failed to fetch API keys', 500);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const validation = validateKeyInput(body);

    if (!validation.valid) {
      return apiError('validation_error', 'Invalid request', 400, { fields: validation.errors });
    }

    // Create the key (returns the full key value and its final scopes)
    const created = await createKey(validation.data.name, validation.data.scopes);
    await syncKeyPoliciesBestEffort();

    // Return the full key (only time it's shown)
    return NextResponse.json({
      success: true,
      api_key: created.apiKey,
      name: created.name,
      scopes: created.scopes.join(','),
      message: 'Store this API key securely. It will not be shown again.',
    }, { status: 201 });
  } catch (error) {
    console.error('Error creating API key:', error);
    return apiError('internal_error', 'Failed to create API key', 500);
  }
}
