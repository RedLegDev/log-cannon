import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { getDashboardByName, updateDashboard, deleteDashboard } from '@/lib/clickhouse';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const auth = await authenticateApiKey(request, 'read');
  if (auth instanceof NextResponse) return auth;

  try {
    const { name } = await params;
    const dashboard = await getDashboardByName(name);

    if (!dashboard) {
      return apiError('not_found', `Dashboard not found: ${name}`, 404);
    }

    return NextResponse.json({
      id: dashboard.id,
      name: dashboard.name,
      description: dashboard.description,
      config: JSON.parse(dashboard.config),
      enabled: Boolean(dashboard.enabled),
      created_at: dashboard.created_at,
      updated_at: dashboard.updated_at,
    });
  } catch (error) {
    console.error('Error fetching dashboard:', error);
    return apiError('internal_error', 'Failed to fetch dashboard', 500);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const { name } = await params;
    const dashboard = await getDashboardByName(name);

    if (!dashboard) {
      return apiError('not_found', `Dashboard not found: ${name}`, 404);
    }

    const body = await request.json();
    const updates: Record<string, unknown> = {};

    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.config !== undefined) updates.config = body.config;
    if (body.enabled !== undefined) updates.enabled = body.enabled;

    if (Object.keys(updates).length === 0) {
      return apiError('validation_error', 'No valid fields to update', 400);
    }

    await updateDashboard(dashboard.id, updates);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating dashboard:', error);
    return apiError('internal_error', 'Failed to update dashboard', 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const { name } = await params;
    const dashboard = await getDashboardByName(name);

    if (!dashboard) {
      return apiError('not_found', `Dashboard not found: ${name}`, 404);
    }

    await deleteDashboard(dashboard.id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting dashboard:', error);
    return apiError('internal_error', 'Failed to delete dashboard', 500);
  }
}
