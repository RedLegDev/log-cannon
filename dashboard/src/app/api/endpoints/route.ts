import { NextRequest, NextResponse } from 'next/server';
import { getEndpoints, createEndpoint, updateEndpoint, deleteEndpoint } from '@/lib/clickhouse';

export async function GET() {
  try {
    const endpoints = await getEndpoints();
    return NextResponse.json(endpoints);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch endpoints' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, description, sql_query, cache_ttl_seconds } = body;

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    if (!sql_query || typeof sql_query !== 'string') {
      return NextResponse.json({ error: 'SQL query is required' }, { status: 400 });
    }

    // Validate name is URL-safe
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return NextResponse.json({ error: 'Name must be URL-safe (letters, numbers, dashes, underscores)' }, { status: 400 });
    }

    // Validate SQL is a SELECT statement
    if (!sql_query.trim().toLowerCase().startsWith('select')) {
      return NextResponse.json({ error: 'Only SELECT statements are allowed' }, { status: 400 });
    }

    await createEndpoint({ name, description, sql_query, cache_ttl_seconds });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create endpoint' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    // Validate SQL if provided
    if (updates.sql_query && !updates.sql_query.trim().toLowerCase().startsWith('select')) {
      return NextResponse.json({ error: 'Only SELECT statements are allowed' }, { status: 400 });
    }

    await updateEndpoint(id, updates);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update endpoint' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { id } = await request.json();
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }
    await deleteEndpoint(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete endpoint' },
      { status: 500 }
    );
  }
}
