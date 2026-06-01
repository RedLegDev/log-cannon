import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError, ApiScope } from '@/lib/api-auth';
import { toggleAPIKey, renameAPIKey, deleteAPIKey, getAPIKeys, setAPIKeyRetention, queryClickHouse } from '@/lib/clickhouse';

const VALID_SCOPES: ApiScope[] = ['ingest', 'read', 'write', 'admin'];

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateApiKey(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;

    // Verify the key exists
    const keys = await getAPIKeys();
    const key = keys.find(k => k.key_id === id);

    if (!key) {
      return apiError('not_found', `API key not found: ${id}`, 404);
    }

    const body = await request.json();

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name) {
        return apiError('validation_error', 'name must be a non-empty string', 400);
      }
      await renameAPIKey(id, body.name);
    }

    if (body.enabled !== undefined) {
      await toggleAPIKey(id, Boolean(body.enabled));
    }

    if (body.scopes !== undefined) {
      let scopesStr: string;
      if (typeof body.scopes === 'string') {
        scopesStr = body.scopes;
      } else if (Array.isArray(body.scopes)) {
        scopesStr = body.scopes.join(',');
      } else {
        return apiError('validation_error', 'scopes must be a string or array', 400);
      }

      const scopeList = scopesStr.split(',').map(s => s.trim());
      const invalidScopes = scopeList.filter(s => !VALID_SCOPES.includes(s as ApiScope));
      if (invalidScopes.length > 0) {
        return apiError('validation_error', `Invalid scopes: ${invalidScopes.join(', ')}`, 400);
      }

      const updateSql = `
        ALTER TABLE logs.api_keys
        UPDATE scopes = '${scopesStr}'
        WHERE key_id = '${id.replace(/'/g, "''")}'
      `;
      await queryClickHouse(updateSql);
    }

    if (body.retentionDays !== undefined) {
      const days = Number(body.retentionDays);
      if (!Number.isInteger(days) || days < 0) {
        return apiError('validation_error', 'retentionDays must be an integer >= 0', 400);
      }
      await setAPIKeyRetention(id, days);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating API key:', error);
    return apiError('internal_error', 'Failed to update API key', 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateApiKey(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;

    // Verify the key exists
    const keys = await getAPIKeys();
    const exists = keys.some(k => k.key_id === id);

    if (!exists) {
      return apiError('not_found', `API key not found: ${id}`, 404);
    }

    await deleteAPIKey(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting API key:', error);
    return apiError('internal_error', 'Failed to delete API key', 500);
  }
}
