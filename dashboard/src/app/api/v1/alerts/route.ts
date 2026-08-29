import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { getAlerts, createAlert, updateAlert, deleteAlert } from '@/lib/clickhouse';
import { isSqlInteger, optionalSqlInteger } from '@/lib/sql-integer';

export async function GET(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'read');
  if (auth instanceof NextResponse) return auth;

  try {
    const alerts = await getAlerts();

    const data = alerts.map(a => ({
      id: a.id,
      name: a.name,
      description: a.description,
      query: a.query,
      condition: a.condition,
      interval_seconds: a.interval_seconds,
      cooldown_seconds: a.cooldown_seconds,
      recipients: JSON.parse(a.recipients || '[]'),
      destination_ids: JSON.parse(a.destination_ids || '[]'),
      subject: a.subject,
      enabled: Boolean(a.enabled),
      created_at: a.created_at,
      last_triggered_at: a.last_triggered_at,
    }));

    return NextResponse.json({ data });
  } catch (error) {
    console.error('Error fetching alerts:', error);
    return apiError('internal_error', 'Failed to fetch alerts', 500);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const { name, description, query, condition, interval_seconds, cooldown_seconds, recipients, destination_ids, subject } = body;

    // Validation
    const errors: Record<string, string> = {};

    if (!name || typeof name !== 'string') {
      errors.name = 'Required field';
    }

    if (!query || typeof query !== 'string') {
      errors.query = 'Required field';
    } else if (!query.trim().toLowerCase().startsWith('select')) {
      errors.query = 'Only SELECT statements are allowed';
    }

    if (!condition || typeof condition !== 'string') {
      errors.condition = 'Required field';
    }

    if (!subject || typeof subject !== 'string') {
      errors.subject = 'Required field';
    }

    const hasDestinations = Array.isArray(destination_ids) && destination_ids.length > 0;
    const hasRecipients = Array.isArray(recipients) && recipients.length > 0;
    if (!hasDestinations && !hasRecipients) {
      errors.destination_ids = 'At least one destination or recipient is required';
    }

    const intervalSecs = optionalSqlInteger(interval_seconds, 60);
    if (intervalSecs === null || intervalSecs < 30) {
      errors.interval_seconds = 'Must be an integer >= 30';
    }

    const cooldownSecs = optionalSqlInteger(cooldown_seconds, 300);
    if (cooldownSecs === null || cooldownSecs < 0) {
      errors.cooldown_seconds = 'Must be an integer >= 0';
    }

    if (Object.keys(errors).length > 0) {
      return apiError('validation_error', 'Invalid request', 400, { fields: errors });
    }

    // Narrowed: errors return above if either value is null
    await createAlert({
      name,
      description: description || '',
      query,
      condition,
      interval_seconds: intervalSecs as number,
      cooldown_seconds: cooldownSecs as number,
      recipients: recipients || [],
      destination_ids: destination_ids || [],
      subject,
    });

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    console.error('Error creating alert:', error);
    return apiError('internal_error', 'Failed to create alert', 500);
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

    // Validate query if provided
    if (updates.query && !updates.query.trim().toLowerCase().startsWith('select')) {
      return apiError('validation_error', 'Only SELECT statements are allowed', 400);
    }

    if (updates.interval_seconds !== undefined) {
      if (!isSqlInteger(updates.interval_seconds) || updates.interval_seconds < 30) {
        return apiError('validation_error', 'interval_seconds must be an integer >= 30', 400);
      }
    }
    if (updates.cooldown_seconds !== undefined) {
      if (!isSqlInteger(updates.cooldown_seconds) || updates.cooldown_seconds < 0) {
        return apiError('validation_error', 'cooldown_seconds must be an integer >= 0', 400);
      }
    }

    await updateAlert(id, updates);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating alert:', error);
    return apiError('internal_error', 'Failed to update alert', 500);
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
    await deleteAlert(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting alert:', error);
    return apiError('internal_error', 'Failed to delete alert', 500);
  }
}
