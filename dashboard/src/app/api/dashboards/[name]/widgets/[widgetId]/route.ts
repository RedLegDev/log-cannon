import { NextRequest, NextResponse } from 'next/server';
import { getDashboardByName, executeWidgetQuery, DashboardConfig } from '@/lib/clickhouse';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string; widgetId: string }> }
) {
  try {
    const { name, widgetId } = await params;

    // Fetch dashboard
    const dashboard = await getDashboardByName(name);
    if (!dashboard) {
      return NextResponse.json(
        { error: 'Dashboard not found' },
        { status: 404 }
      );
    }

    if (!dashboard.enabled) {
      return NextResponse.json(
        { error: 'Dashboard is disabled' },
        { status: 403 }
      );
    }

    // Parse config
    const config: DashboardConfig = JSON.parse(dashboard.config);

    // Find widget
    const widget = config.widgets.find(w => w.id === widgetId);
    if (!widget) {
      return NextResponse.json(
        { error: 'Widget not found' },
        { status: 404 }
      );
    }

    // Execute widget query
    const data = await executeWidgetQuery(widget);

    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to execute widget query' },
      { status: 500 }
    );
  }
}
