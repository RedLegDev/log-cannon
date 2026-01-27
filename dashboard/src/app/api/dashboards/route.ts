import { NextRequest, NextResponse } from 'next/server';
import { getDashboards, createDashboard, updateDashboard, deleteDashboard, DashboardInput, DashboardConfig } from '@/lib/clickhouse';

function validateDashboard(input: Partial<DashboardInput>): string[] {
  const errors: string[] = [];

  // Name validation
  if (!input.name || typeof input.name !== 'string') {
    errors.push('Name is required');
  } else if (!/^[a-zA-Z0-9_-]+$/.test(input.name)) {
    errors.push('Name must be URL-safe (letters, numbers, dashes, underscores)');
  }

  // Config validation
  if (!input.config) {
    errors.push('Config is required');
  } else {
    const config = input.config as DashboardConfig;

    if (!config.layout || !['auto', 'grid'].includes(config.layout)) {
      errors.push('Config must have a valid layout (auto or grid)');
    }

    if (!config.widgets || !Array.isArray(config.widgets) || config.widgets.length === 0) {
      errors.push('Config must have at least one widget');
    } else {
      config.widgets.forEach((widget, idx) => {
        if (!widget.id || !widget.type || !widget.title) {
          errors.push(`Widget ${idx}: Missing required fields (id, type, title)`);
        }

        if (!['stat', 'line_chart', 'bar_chart', 'table'].includes(widget.type)) {
          errors.push(`Widget ${idx}: Invalid type "${widget.type}"`);
        }

        if (!widget.dataSource || !widget.dataSource.type) {
          errors.push(`Widget ${idx}: Missing dataSource`);
        } else {
          if (widget.dataSource.type === 'endpoint' && !widget.dataSource.endpointName) {
            errors.push(`Widget ${idx}: Endpoint name required for endpoint dataSource`);
          }

          if (widget.dataSource.type === 'inline') {
            if (!widget.dataSource.sql) {
              errors.push(`Widget ${idx}: SQL required for inline dataSource`);
            } else {
              const sql = widget.dataSource.sql.trim().toLowerCase();
              if (!sql.startsWith('select')) {
                errors.push(`Widget ${idx}: Only SELECT statements allowed in inline SQL`);
              }
            }
          }
        }
      });
    }
  }

  return errors;
}

export async function GET() {
  try {
    const dashboards = await getDashboards();
    return NextResponse.json(dashboards);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch dashboards' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, description, config } = body;

    const errors = validateDashboard({ name, description, config });
    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join(', ') }, { status: 400 });
    }

    await createDashboard({ name, description, config });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create dashboard' },
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

    // Validate updates if config is provided
    if (updates.config) {
      const errors = validateDashboard({ name: updates.name || 'temp', config: updates.config });
      if (errors.length > 0) {
        return NextResponse.json({ error: errors.join(', ') }, { status: 400 });
      }
    }

    await updateDashboard(id, updates);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update dashboard' },
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
    await deleteDashboard(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete dashboard' },
      { status: 500 }
    );
  }
}
