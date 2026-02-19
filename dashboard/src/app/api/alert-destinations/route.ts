import { NextRequest, NextResponse } from 'next/server';
import {
  getAlertDestinations,
  createAlertDestination,
  updateAlertDestination,
  deleteAlertDestination,
} from '@/lib/clickhouse';

export async function GET() {
  try {
    const destinations = await getAlertDestinations();
    return NextResponse.json(destinations);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch destinations' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, type, config } = body;

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }
    if (type !== 'email' && type !== 'webhook') {
      return NextResponse.json({ error: 'Type must be email or webhook' }, { status: 400 });
    }
    if (!config || typeof config !== 'object') {
      return NextResponse.json({ error: 'Config is required' }, { status: 400 });
    }
    if (type === 'email' && !config.email) {
      return NextResponse.json({ error: 'Email address is required for email destinations' }, { status: 400 });
    }
    if (type === 'webhook' && !config.url) {
      return NextResponse.json({ error: 'URL is required for webhook destinations' }, { status: 400 });
    }

    await createAlertDestination({ name, type, config });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create destination' },
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
    await updateAlertDestination(id, updates);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update destination' },
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
    await deleteAlertDestination(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete destination' },
      { status: 500 }
    );
  }
}
