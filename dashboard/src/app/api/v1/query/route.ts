import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { queryClickHouse } from '@/lib/clickhouse';

const MAX_ROWS = 10000;
const QUERY_TIMEOUT_MS = 30000;

export async function POST(request: NextRequest) {
  // Authenticate
  const auth = await authenticateApiKey(request, 'read');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const { sql } = body;

    if (!sql || typeof sql !== 'string') {
      return apiError('validation_error', 'SQL query is required', 400, {
        fields: { sql: 'Required field' },
      });
    }

    // Security: Only allow SELECT statements
    const trimmed = sql.trim().toLowerCase();
    if (!trimmed.startsWith('select')) {
      return apiError('query_error', 'Only SELECT statements are allowed', 400);
    }

    // Add LIMIT if not present to prevent massive result sets
    const hasLimit = /\blimit\s+\d+/i.test(sql);
    const limitedSql = hasLimit ? sql : `${sql} LIMIT ${MAX_ROWS}`;

    const startTime = Date.now();

    // Execute with timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Query timeout')), QUERY_TIMEOUT_MS);
    });

    const queryPromise = queryClickHouse<unknown>(limitedSql);
    const data = await Promise.race([queryPromise, timeoutPromise]);

    const elapsedMs = Date.now() - startTime;

    return NextResponse.json({
      data,
      meta: {
        rows: Array.isArray(data) ? data.length : 0,
        elapsed_ms: elapsedMs,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Query failed';

    if (message === 'Query timeout') {
      return apiError('query_timeout', 'Query exceeded 30 second timeout', 408);
    }

    // Check if it's a ClickHouse syntax error
    if (message.includes('ClickHouse query failed')) {
      return apiError('query_error', message, 400);
    }

    console.error('Query error:', error);
    return apiError('internal_error', 'Query execution failed', 500);
  }
}
