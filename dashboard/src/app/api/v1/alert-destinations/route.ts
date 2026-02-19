import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import {
  getAlertDestinations,
  createAlertDestination,
  updateAlertDestination,
  deleteAlertDestination,
} from '@/lib/clickhouse';

export async function GET(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'read');
  if (auth instanceof NextResponse) return auth;

  try {
    const destinations = await getAlertDestinations();

    const data = destinations.map(d => ({
      id: d.id,
      name: d.name,
      type: d.type,
      config: JSON.parse(d.config || '{}'),
      enabled: Boolean(d.enabled),
      created_at: d.created_at,
    }));

    return NextResponse.json({ data });
  } catch (error) {
    console.error('Error fetching alert destinations:', error);
    return apiError('internal_error', 'Failed to fetch destinations', 500);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const { name, type, config } = body;

    const errors: Record<string, string> = {};
    if (!name || typeof name !== 'string') {
      errors.name = 'Required field';
    }
    if (type !== 'email' && type !== 'webhook') {
      errors.type = 'Must be email or webhook';
    }
    if (!config || typeof config !== 'object') {
      errors.config = 'Required field';
    } else if (type === 'email' && !config.email) {
      errors.config = 'Email address is required';
    } else if (type === 'webhook' && !config.url) {
      errors.config = 'URL is required';
    }

    if (Object.keys(errors).length > 0) {
      return apiError('validation_error', 'Invalid request', 400, { fields: errors });
    }

    await createAlertDestination({ name, type, config });
    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    console.error('Error creating alert destination:', error);
    return apiError('internal_error', 'Failed to create destination', 500);
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) {
      return apiError('validation_error', 'id is required', 400);
    }

    await updateAlertDestination(id, updates);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating alert destination:', error);
    return apiError('internal_error', 'Failed to update destination', 500);
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await request.json();
    if (!id) {
      return apiError('validation_error', 'id is required', 400);
    }
    await deleteAlertDestination(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting alert destination:', error);
    return apiError('internal_error', 'Failed to delete destination', 500);
  }
}
