import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { getSavedQueries, createSavedQuery, PropertyFilter } from '@/lib/clickhouse';

interface SavedQueryInput {
  name: string;
  description?: string;
  filters: {
    source?: string;
    level?: string;
    search?: string;
    properties?: Record<string, string>;
  };
}

function validateSavedQueryInput(body: unknown): { valid: true; data: SavedQueryInput } | { valid: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: { body: 'Request body is required' } };
  }

  const { name, description, filters } = body as Record<string, unknown>;

  if (!name || typeof name !== 'string') {
    errors.name = 'Required field';
  }

  if (description !== undefined && typeof description !== 'string') {
    errors.description = 'Must be a string';
  }

  if (!filters || typeof filters !== 'object') {
    errors.filters = 'Required field';
  }

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    data: body as SavedQueryInput,
  };
}

export async function GET(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'read');
  if (auth instanceof NextResponse) return auth;

  try {
    const queries = await getSavedQueries();

    const data = queries.map(q => ({
      id: q.id,
      name: q.name,
      description: q.description,
      filters: {
        source: q.source || undefined,
        level: q.level || undefined,
        search: q.search || undefined,
        properties: q.property_filters ? JSON.parse(q.property_filters) : undefined,
      },
      created_at: q.created_at,
    }));

    return NextResponse.json({ data });
  } catch (error) {
    console.error('Error fetching saved queries:', error);
    return apiError('internal_error', 'Failed to fetch saved queries', 500);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const validation = validateSavedQueryInput(body);

    if (!validation.valid) {
      return apiError('validation_error', 'Invalid request', 400, { fields: validation.errors });
    }

    const { name, description, filters } = validation.data;

    // Convert properties to PropertyFilter array
    const propertyFilters: PropertyFilter[] = [];
    if (filters.properties) {
      for (const [key, value] of Object.entries(filters.properties)) {
        propertyFilters.push({ key, value, operator: '=' });
      }
    }

    await createSavedQuery({
      name,
      description,
      source: filters.source,
      level: filters.level,
      search: filters.search,
      propertyFilters,
    });

    return NextResponse.json({ success: true, name }, { status: 201 });
  } catch (error) {
    console.error('Error creating saved query:', error);
    return apiError('internal_error', 'Failed to create saved query', 500);
  }
}
