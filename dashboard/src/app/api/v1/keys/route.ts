import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError, ApiScope } from '@/lib/api-auth';
import { getAPIKeys, createAPIKey, queryClickHouse } from '@/lib/clickhouse';

const VALID_SCOPES: ApiScope[] = ['ingest', 'read', 'write', 'admin'];

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
    const keys = await getAPIKeys();

    // Don't expose the actual API key values
    const data = keys.map(k => ({
      id: k.key_id,
      name: k.name,
      // Show only prefix of key for identification
      key_prefix: k.api_key.slice(0, 8) + '...',
      enabled: Boolean(k.enabled),
      created_at: k.created_at,
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

    // Create the key (returns the full key value)
    const apiKey = await createAPIKey(validation.data.name);

    // Update scopes for the newly created key
    const updateSql = `
      ALTER TABLE logs.api_keys
      UPDATE scopes = '${validation.data.scopes}'
      WHERE api_key = '${apiKey.replace(/'/g, "''")}'
    `;
    await queryClickHouse(updateSql);

    // Return the full key (only time it's shown)
    return NextResponse.json({
      success: true,
      api_key: apiKey,
      name: validation.data.name,
      scopes: validation.data.scopes,
      message: 'Store this API key securely. It will not be shown again.',
    }, { status: 201 });
  } catch (error) {
    console.error('Error creating API key:', error);
    return apiError('internal_error', 'Failed to create API key', 500);
  }
}
