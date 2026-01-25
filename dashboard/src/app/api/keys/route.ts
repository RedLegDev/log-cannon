import { NextRequest, NextResponse } from 'next/server';
import { getAPIKeys, createAPIKey, toggleAPIKey, renameAPIKey, deleteAPIKey } from '@/lib/clickhouse';

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

export async function POST(request: NextRequest) {
  try {
    const { name } = await request.json();
    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }
    const apiKey = await createAPIKey(name);
    return NextResponse.json({ apiKey });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create API key' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { keyId, enabled, name } = await request.json();
    if (!keyId) {
      return NextResponse.json({ error: 'keyId is required' }, { status: 400 });
    }

    // Handle rename
    if (typeof name === 'string') {
      if (!name.trim()) {
        return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 });
      }
      await renameAPIKey(keyId, name.trim());
      return NextResponse.json({ success: true });
    }

    // Handle toggle
    if (typeof enabled === 'boolean') {
      await toggleAPIKey(keyId, enabled);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Either enabled or name is required' }, { status: 400 });
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
