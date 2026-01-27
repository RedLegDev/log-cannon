import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { getDashboards, createDashboard, DashboardConfig } from '@/lib/clickhouse';

function validateDashboardInput(body: unknown): { valid: true; data: { name: string; description?: string; config: DashboardConfig } } | { valid: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: { body: 'Request body is required' } };
  }

  const { name, description, config } = body as Record<string, unknown>;

  if (!name || typeof name !== 'string') {
    errors.name = 'Required field';
  } else if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    errors.name = 'Must be URL-safe (letters, numbers, dashes, underscores)';
  }

  if (description !== undefined && typeof description !== 'string') {
    errors.description = 'Must be a string';
  }

  if (!config || typeof config !== 'object') {
    errors.config = 'Required field';
  } else {
    const cfg = config as Record<string, unknown>;
    if (!cfg.layout || !['auto', 'grid'].includes(cfg.layout as string)) {
      errors['config.layout'] = 'Must be "auto" or "grid"';
    }
    if (!Array.isArray(cfg.widgets) || cfg.widgets.length === 0) {
      errors['config.widgets'] = 'Must have at least one widget';
    }
  }

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    data: {
      name: name as string,
      description: description as string | undefined,
      config: config as DashboardConfig,
    },
  };
}

export async function GET(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'read');
  if (auth instanceof NextResponse) return auth;

  try {
    const dashboards = await getDashboards();

    const data = dashboards.map(d => ({
      id: d.id,
      name: d.name,
      description: d.description,
      config: JSON.parse(d.config),
      enabled: Boolean(d.enabled),
      created_at: d.created_at,
      updated_at: d.updated_at,
    }));

    return NextResponse.json({ data });
  } catch (error) {
    console.error('Error fetching dashboards:', error);
    return apiError('internal_error', 'Failed to fetch dashboards', 500);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const validation = validateDashboardInput(body);

    if (!validation.valid) {
      return apiError('validation_error', 'Invalid request', 400, { fields: validation.errors });
    }

    await createDashboard(validation.data);

    return NextResponse.json({ success: true, name: validation.data.name }, { status: 201 });
  } catch (error) {
    console.error('Error creating dashboard:', error);
    return apiError('internal_error', 'Failed to create dashboard', 500);
  }
}
