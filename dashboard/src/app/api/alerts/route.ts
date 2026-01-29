import { NextRequest, NextResponse } from 'next/server';
import { getAlerts, createAlert, updateAlert, deleteAlert } from '@/lib/clickhouse';

export async function GET() {
  try {
    const alerts = await getAlerts();
    return NextResponse.json(alerts);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch alerts' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, description, query, condition, interval_seconds, cooldown_seconds, recipients, subject } = body;

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    if (!query || typeof query !== 'string') {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 });
    }

    if (!condition || typeof condition !== 'string') {
      return NextResponse.json({ error: 'Condition is required' }, { status: 400 });
    }

    if (!subject || typeof subject !== 'string') {
      return NextResponse.json({ error: 'Subject is required' }, { status: 400 });
    }

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return NextResponse.json({ error: 'At least one recipient is required' }, { status: 400 });
    }

    // Validate SQL is a SELECT statement
    if (!query.trim().toLowerCase().startsWith('select')) {
      return NextResponse.json({ error: 'Only SELECT statements are allowed' }, { status: 400 });
    }

    // Validate interval is at least 30 seconds
    const intervalSecs = interval_seconds || 60;
    if (intervalSecs < 30) {
      return NextResponse.json({ error: 'Interval must be at least 30 seconds' }, { status: 400 });
    }

    await createAlert({
      name,
      description,
      query,
      condition,
      interval_seconds: intervalSecs,
      cooldown_seconds: cooldown_seconds || 300,
      recipients,
      subject
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create alert' },
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

    // Validate SQL if provided
    if (updates.query && !updates.query.trim().toLowerCase().startsWith('select')) {
      return NextResponse.json({ error: 'Only SELECT statements are allowed' }, { status: 400 });
    }

    // Validate interval if provided
    if (updates.interval_seconds !== undefined && updates.interval_seconds < 30) {
      return NextResponse.json({ error: 'Interval must be at least 30 seconds' }, { status: 400 });
    }

    await updateAlert(id, updates);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update alert' },
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
    await deleteAlert(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete alert' },
      { status: 500 }
    );
  }
}
