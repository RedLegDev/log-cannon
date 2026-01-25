import { NextRequest, NextResponse } from 'next/server';
import { getSavedQueries, createSavedQuery, deleteSavedQuery } from '@/lib/clickhouse';

export async function GET() {
  try {
    const queries = await getSavedQueries();
    return NextResponse.json(queries);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch saved queries' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, description, source, level, search, propertyFilters } = body;

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    await createSavedQuery({ name, description, source, level, search, propertyFilters });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create saved query' },
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
    await deleteSavedQuery(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete saved query' },
      { status: 500 }
    );
  }
}
