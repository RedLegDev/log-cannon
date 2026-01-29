import { NextRequest, NextResponse } from 'next/server';
import { getAlertById, testAlertQuery } from '@/lib/clickhouse';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const alert = await getAlertById(id);
    if (!alert) {
      return NextResponse.json({ error: 'Alert not found' }, { status: 404 });
    }

    const results = await testAlertQuery(alert.query);

    return NextResponse.json({
      success: true,
      results,
      query: alert.query,
      condition: alert.condition
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to test alert query' },
      { status: 500 }
    );
  }
}
