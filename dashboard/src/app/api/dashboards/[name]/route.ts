import { NextRequest, NextResponse } from 'next/server';
import { getDashboardByName } from '@/lib/clickhouse';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const { name } = await params;
    const dashboard = await getDashboardByName(name);

    if (!dashboard) {
      return NextResponse.json(
        { error: 'Dashboard not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(dashboard);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch dashboard' },
      { status: 500 }
    );
  }
}
