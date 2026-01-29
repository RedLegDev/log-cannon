import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { testAlertQuery } from '@/lib/clickhouse';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateApiKey(request, 'read');
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const { query } = body;

    if (!query || typeof query !== 'string') {
      return apiError('validation_error', 'query is required', 400);
    }

    if (!query.trim().toLowerCase().startsWith('select')) {
      return apiError('validation_error', 'Only SELECT statements are allowed', 400);
    }

    const results = await testAlertQuery(query);
    return NextResponse.json({ data: results });
  } catch (error) {
    console.error('Error testing alert query:', error);
    return apiError('internal_error', 'Failed to test query', 500);
  }
}
