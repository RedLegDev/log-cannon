import { NextRequest, NextResponse } from 'next/server';
import { getAPIKeys, createAPIKey, toggleAPIKey, deleteAPIKey } from '@/lib/clickhouse';

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
    const { keyId, enabled } = await request.json();
    if (!keyId || typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'keyId and enabled are required' }, { status: 400 });
    }
    await toggleAPIKey(keyId, enabled);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to toggle API key' },
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
