import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { getEndpoints, createEndpoint } from '@/lib/clickhouse';

function validateEndpointInput(body: unknown): { valid: true; data: { name: string; description?: string; sql_query: string; cache_ttl_seconds?: number } } | { valid: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: { body: 'Request body is required' } };
  }

  const { name, description, sql_query, cache_ttl_seconds } = body as Record<string, unknown>;

  if (!name || typeof name !== 'string') {
    errors.name = 'Required field';
  } else if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    errors.name = 'Must be URL-safe (letters, numbers, dashes, underscores)';
  }

  if (description !== undefined && typeof description !== 'string') {
    errors.description = 'Must be a string';
  }

  if (!sql_query || typeof sql_query !== 'string') {
    errors.sql_query = 'Required field';
  } else {
    const trimmed = sql_query.trim().toLowerCase();
    if (!trimmed.startsWith('select')) {
      errors.sql_query = 'Must be a SELECT statement';
    }
  }

  if (cache_ttl_seconds !== undefined && (typeof cache_ttl_seconds !== 'number' || cache_ttl_seconds < 0)) {
    errors.cache_ttl_seconds = 'Must be a non-negative number';
  }

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    data: {
      name: name as string,
      description: description as string | undefined,
      sql_query: sql_query as string,
      cache_ttl_seconds: cache_ttl_seconds as number | undefined,
    },
  };
}

// Extract @param placeholders from SQL
function extractParameters(sql: string): string[] {
  const matches = sql.match(/@[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
  return [...new Set(matches.map(m => m.slice(1)))];
}

export async function GET(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'read');
  if (auth instanceof NextResponse) return auth;

  try {
    const endpoints = await getEndpoints();

    const data = endpoints.map(e => ({
      id: e.id,
      name: e.name,
      description: e.description,
      sql_query: e.sql_query,
      parameters: extractParameters(e.sql_query),
      cache_ttl_seconds: e.cache_ttl_seconds,
      enabled: Boolean(e.enabled),
      created_at: e.created_at,
    }));

    return NextResponse.json({ data });
  } catch (error) {
    console.error('Error fetching endpoints:', error);
    return apiError('internal_error', 'Failed to fetch endpoints', 500);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const validation = validateEndpointInput(body);

    if (!validation.valid) {
      return apiError('validation_error', 'Invalid request', 400, { fields: validation.errors });
    }

    await createEndpoint(validation.data);

    return NextResponse.json({
      success: true,
      name: validation.data.name,
      parameters: extractParameters(validation.data.sql_query),
    }, { status: 201 });
  } catch (error) {
    console.error('Error creating endpoint:', error);
    return apiError('internal_error', 'Failed to create endpoint', 500);
  }
}
