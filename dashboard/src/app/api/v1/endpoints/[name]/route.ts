import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { getEndpointByName, updateEndpoint, deleteEndpoint, executeEndpointQuery } from '@/lib/clickhouse';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const auth = await authenticateApiKey(request, 'read');
  if (auth instanceof NextResponse) return auth;

  try {
    const { name } = await params;
    const endpoint = await getEndpointByName(name);

    if (!endpoint) {
      return apiError('not_found', `Endpoint not found: ${name}`, 404);
    }

    if (!endpoint.enabled) {
      return apiError('forbidden', `Endpoint is disabled: ${name}`, 403);
    }

    // Extract query parameters for execution
    const { searchParams } = new URL(request.url);
    const queryParams: Record<string, string> = {};
    for (const [key, value] of searchParams.entries()) {
      queryParams[key] = value;
    }

    const data = await executeEndpointQuery(endpoint.sql_query, queryParams);

    return NextResponse.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Execution failed';
    console.error('Error executing endpoint:', error);

    if (message.includes('ClickHouse query failed')) {
      return apiError('query_error', message, 400);
    }

    return apiError('internal_error', 'Failed to execute endpoint', 500);
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
    const endpoint = await getEndpointByName(name);

    if (!endpoint) {
      return apiError('not_found', `Endpoint not found: ${name}`, 404);
    }

    const body = await request.json();
    const updates: Record<string, unknown> = {};

    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.sql_query !== undefined) {
      const trimmed = body.sql_query.trim().toLowerCase();
      if (!trimmed.startsWith('select')) {
        return apiError('validation_error', 'sql_query must be a SELECT statement', 400);
      }
      updates.sql_query = body.sql_query;
    }
    if (body.cache_ttl_seconds !== undefined) updates.cache_ttl_seconds = body.cache_ttl_seconds;
    if (body.enabled !== undefined) updates.enabled = body.enabled;

    if (Object.keys(updates).length === 0) {
      return apiError('validation_error', 'No valid fields to update', 400);
    }

    await updateEndpoint(endpoint.id, updates);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating endpoint:', error);
    return apiError('internal_error', 'Failed to update endpoint', 500);
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
    const endpoint = await getEndpointByName(name);

    if (!endpoint) {
      return apiError('not_found', `Endpoint not found: ${name}`, 404);
    }

    await deleteEndpoint(endpoint.id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting endpoint:', error);
    return apiError('internal_error', 'Failed to delete endpoint', 500);
  }
}
