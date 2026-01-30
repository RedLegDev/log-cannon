import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { getRecentLogs, deleteLogs, parseOperatorFromValue, PropertyFilter } from '@/lib/clickhouse';

export async function GET(request: NextRequest) {
  // Authenticate
  const auth = await authenticateApiKey(request, 'read');
  if (auth instanceof NextResponse) return auth;

  try {
    const { searchParams } = new URL(request.url);

    // Parse query parameters
    const source = searchParams.get('source') || undefined;
    const level = searchParams.get('level') || undefined;
    const search = searchParams.get('search') || undefined;
    const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10), 1000);

    // Parse property filters (prop.key=value or prop.key=>value)
    const propertyFilters: PropertyFilter[] = [];
    for (const [key, value] of searchParams.entries()) {
      if (key.startsWith('prop.')) {
        const propKey = key.slice(5); // Remove 'prop.' prefix
        const { operator, value: parsedValue } = parseOperatorFromValue(value);
        propertyFilters.push({ key: propKey, value: parsedValue, operator });
      }
    }

    const logs = await getRecentLogs(source, level, search, propertyFilters, limit);

    // Transform to API format
    const data = logs.map(log => ({
      id: log.id,
      timestamp: log.timestamp,
      level: log.level,
      message: log.message,
      message_template: log.message_template,
      source: log.source,
      exception: log.exception || undefined,
      properties: log.properties ? JSON.parse(log.properties) : {},
    }));

    return NextResponse.json({
      data,
      meta: { count: data.length, limit },
    });
  } catch (error) {
    console.error('Error fetching logs:', error);
    return apiError('internal_error', 'Failed to fetch logs', 500);
  }
}

export async function DELETE(request: NextRequest) {
  // Authenticate with write scope
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const { searchParams } = new URL(request.url);

    // Parse query parameters
    const source = searchParams.get('source') || undefined;
    const level = searchParams.get('level') || undefined;
    const search = searchParams.get('search') || undefined;

    // Parse property filters (prop.key=value or prop.key=>value)
    const propertyFilters: PropertyFilter[] = [];
    for (const [key, value] of searchParams.entries()) {
      if (key.startsWith('prop.')) {
        const propKey = key.slice(5);
        const { operator, value: parsedValue } = parseOperatorFromValue(value);
        propertyFilters.push({ key: propKey, value: parsedValue, operator });
      }
    }

    // Require at least one filter
    if (!source && !level && !search && propertyFilters.length === 0) {
      return apiError('validation_error', 'At least one filter (source, level, search, or prop.*) is required', 400);
    }

    const deletedCount = await deleteLogs(source, level, search, propertyFilters);

    return NextResponse.json({
      message: `Deleted ${deletedCount} log(s)`,
      meta: { deleted: deletedCount },
    });
  } catch (error) {
    console.error('Error deleting logs:', error);
    return apiError('internal_error', 'Failed to delete logs', 500);
  }
}
