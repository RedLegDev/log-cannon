import { NextResponse } from 'next/server';
import { getSystemMetrics } from '@/lib/clickhouse';

export async function GET() {
  try {
    const metrics = await getSystemMetrics();
    return NextResponse.json(metrics);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch system metrics' },
      { status: 500 }
    );
  }
}
