import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { deleteSavedQuery, getSavedQueries } from '@/lib/clickhouse';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateApiKey(request, 'write');
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;

    // Verify the saved query exists
    const queries = await getSavedQueries();
    const exists = queries.some(q => q.id === id);

    if (!exists) {
      return apiError('not_found', `Saved query not found: ${id}`, 404);
    }

    await deleteSavedQuery(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting saved query:', error);
    return apiError('internal_error', 'Failed to delete saved query', 500);
  }
}
