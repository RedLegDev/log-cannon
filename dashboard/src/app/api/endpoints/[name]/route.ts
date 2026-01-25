import { NextRequest, NextResponse } from 'next/server';
import { getEndpointByName, executeEndpointQuery } from '@/lib/clickhouse';
import * as cache from '@/lib/cache';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const { name } = await params;
    const endpoint = await getEndpointByName(name);

    if (!endpoint) {
      return NextResponse.json({ error: 'Endpoint not found' }, { status: 404 });
    }

    if (!endpoint.enabled) {
      return NextResponse.json({ error: 'Endpoint is disabled' }, { status: 404 });
    }

    // Extract query parameters for interpolation
    const queryParams: Record<string, string> = {};
    request.nextUrl.searchParams.forEach((value, key) => {
      queryParams[key] = value;
    });

    // Create cache key from endpoint name and params
    const cacheKey = `endpoint:${name}:${JSON.stringify(queryParams)}`;

    // Check cache
    if (endpoint.cache_ttl_seconds > 0) {
      const cached = cache.get(cacheKey);
      if (cached) {
        return NextResponse.json({
          data: cached,
          cached: true,
          endpoint: name
        });
      }
    }

    // Execute query
    const data = await executeEndpointQuery(endpoint.sql_query, queryParams);

    // Store in cache
    if (endpoint.cache_ttl_seconds > 0) {
      cache.set(cacheKey, data, endpoint.cache_ttl_seconds);
    }

    return NextResponse.json({
      data,
      cached: false,
      endpoint: name
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to execute endpoint' },
      { status: 500 }
    );
  }
}
