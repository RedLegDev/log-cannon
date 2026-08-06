import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError, ApiScope } from '@/lib/api-auth';
import { listKeys, updateKey, deleteKey } from '@/lib/key-registry';
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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateApiKey(request, 'admin');
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;

    // Verify the key exists
    const keys = await listKeys();
    const key = keys.find(k => k.keyId === id);

    if (!key) {
      return apiError('not_found', `API key not found: ${id}`, 404);
    }

    const body = await request.json();
    const patch: { name?: string; enabled?: boolean; scopes?: string; retentionDays?: number } = {};

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name) {
        return apiError('validation_error', 'name must be a non-empty string', 400);
      }
      patch.name = body.name;
    }

    if (body.enabled !== undefined) {
      patch.enabled = Boolean(body.enabled);
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

      patch.scopes = scopesStr;
    }

    if (body.retentionDays !== undefined) {
      const days = Number(body.retentionDays);
      if (!Number.isInteger(days) || days < 0) {
        return apiError('validation_error', 'retentionDays must be an integer >= 0', 400);
      }
      patch.retentionDays = days;
    }

    if (Object.keys(patch).length > 0) {
      await updateKey(id, patch);
      await syncKeyPoliciesBestEffort();
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
    const keys = await listKeys();
    const exists = keys.some(k => k.keyId === id);

    if (!exists) {
      return apiError('not_found', `API key not found: ${id}`, 404);
    }

    await deleteKey(id);
    await syncKeyPoliciesBestEffort();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting API key:', error);
    return apiError('internal_error', 'Failed to delete API key', 500);
  }
}
