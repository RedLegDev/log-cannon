import { NextRequest, NextResponse } from 'next/server';
import { listKeys, createKey, updateKey, deleteKey } from '@/lib/key-registry';

const VALID_SCOPES = ['ingest', 'read', 'write', 'admin'];

function fail(error: unknown, fallback: string) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallback },
    { status: 500 }
  );
}

export async function GET() {
  try {
    return NextResponse.json(await listKeys());
  } catch (error) {
    return fail(error, 'Failed to fetch API keys');
  }
}

function normalizeScopes(scopes: unknown): string | NextResponse {
  if (scopes === undefined) return 'ingest';
  const list = typeof scopes === 'string' ? scopes.split(',').map(s => s.trim()) : (scopes as string[]);
  const invalid = list.filter(s => !VALID_SCOPES.includes(s));
  if (invalid.length > 0) {
    return NextResponse.json({ error: `Invalid scopes: ${invalid.join(', ')}` }, { status: 400 });
  }
  return list.join(',');
}

export async function POST(request: NextRequest) {
  try {
    const { name, scopes } = await request.json();
    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    const scopesStr = normalizeScopes(scopes);
    if (scopesStr instanceof NextResponse) return scopesStr;

    const created = await createKey(name, scopesStr);
    return NextResponse.json({ apiKey: created.apiKey, scopes: created.scopes.join(',') });
  } catch (error) {
    return fail(error, 'Failed to create API key');
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { keyId, enabled, name, scopes, retentionDays } = await request.json();
    if (!keyId) {
      return NextResponse.json({ error: 'keyId is required' }, { status: 400 });
    }

    const patch: { name?: string; enabled?: boolean; scopes?: string; retentionDays?: number } = {};

    if (retentionDays !== undefined) {
      const days = Number(retentionDays);
      if (!Number.isInteger(days) || days < 0) {
        return NextResponse.json({ error: 'retentionDays must be an integer >= 0' }, { status: 400 });
      }
      patch.retentionDays = days;
    }
    if (typeof name === 'string') {
      if (!name.trim()) {
        return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 });
      }
      patch.name = name.trim();
    }
    if (typeof enabled === 'boolean') patch.enabled = enabled;
    if (scopes !== undefined) {
      const scopesStr = normalizeScopes(scopes);
      if (scopesStr instanceof NextResponse) return scopesStr;
      patch.scopes = scopesStr;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: 'Either enabled, name, scopes, or retentionDays is required' },
        { status: 400 }
      );
    }

    await updateKey(keyId, patch);
    return NextResponse.json({ success: true });
  } catch (error) {
    return fail(error, 'Failed to update API key');
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { keyId } = await request.json();
    if (!keyId) {
      return NextResponse.json({ error: 'keyId is required' }, { status: 400 });
    }
    await deleteKey(keyId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return fail(error, 'Failed to delete API key');
  }
}
