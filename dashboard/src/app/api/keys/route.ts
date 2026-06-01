import { NextRequest, NextResponse } from 'next/server';
import { getAPIKeys, createAPIKey, toggleAPIKey, renameAPIKey, deleteAPIKey, setAPIKeyRetention, queryClickHouse } from '@/lib/clickhouse';

export async function GET() {
  try {
    const keys = await getAPIKeys();
    return NextResponse.json(keys);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch API keys' },
      { status: 500 }
    );
  }
}

const VALID_SCOPES = ['ingest', 'read', 'write', 'admin'];

export async function POST(request: NextRequest) {
  try {
    const { name, scopes } = await request.json();
    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    // Validate scopes if provided
    let scopesStr = 'ingest'; // default
    if (scopes) {
      const scopeList = typeof scopes === 'string' ? scopes.split(',').map(s => s.trim()) : scopes;
      const invalidScopes = scopeList.filter((s: string) => !VALID_SCOPES.includes(s));
      if (invalidScopes.length > 0) {
        return NextResponse.json({ error: `Invalid scopes: ${invalidScopes.join(', ')}` }, { status: 400 });
      }
      scopesStr = scopeList.join(',');
    }

    const apiKey = await createAPIKey(name, scopesStr);
    return NextResponse.json({ apiKey, scopes: scopesStr });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create API key' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { keyId, enabled, name, scopes, retentionDays } = await request.json();
    if (!keyId) {
      return NextResponse.json({ error: 'keyId is required' }, { status: 400 });
    }

    let updated = false;

    // Handle retention update (0 = keep forever)
    if (retentionDays !== undefined) {
      const days = Number(retentionDays);
      if (!Number.isInteger(days) || days < 0) {
        return NextResponse.json({ error: 'retentionDays must be an integer >= 0' }, { status: 400 });
      }
      await setAPIKeyRetention(keyId, days);
      updated = true;
    }

    // Handle rename
    if (typeof name === 'string') {
      if (!name.trim()) {
        return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 });
      }
      await renameAPIKey(keyId, name.trim());
      updated = true;
    }

    // Handle toggle
    if (typeof enabled === 'boolean') {
      await toggleAPIKey(keyId, enabled);
      updated = true;
    }

    // Handle scopes update
    if (scopes !== undefined) {
      const scopeList = typeof scopes === 'string' ? scopes.split(',').map(s => s.trim()) : scopes;
      const invalidScopes = scopeList.filter((s: string) => !VALID_SCOPES.includes(s));
      if (invalidScopes.length > 0) {
        return NextResponse.json({ error: `Invalid scopes: ${invalidScopes.join(', ')}` }, { status: 400 });
      }
      const scopesStr = scopeList.join(',');
      const escapedKeyId = keyId.replace(/'/g, "''");
      await queryClickHouse(`ALTER TABLE logs.api_keys UPDATE scopes = '${scopesStr}' WHERE key_id = '${escapedKeyId}'`);
      updated = true;
    }

    if (!updated) {
      return NextResponse.json({ error: 'Either enabled, name, scopes, or retentionDays is required' }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update API key' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { keyId } = await request.json();
    if (!keyId) {
      return NextResponse.json({ error: 'keyId is required' }, { status: 400 });
    }
    await deleteAPIKey(keyId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete API key' },
      { status: 500 }
    );
  }
}
