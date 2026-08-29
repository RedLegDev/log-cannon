import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiKey, apiError } from '@/lib/api-auth';
import { listBackups } from '@/lib/backups';

export async function GET(request: NextRequest) {
  const auth = await authenticateApiKey(request, 'read');
  if (auth instanceof NextResponse) return auth;

  try {
    const backups = await listBackups();
    return NextResponse.json({ backups });
  } catch (e) {
    return apiError(
      'internal_error',
      `Failed to list backups: ${e instanceof Error ? e.message : 'unknown error'}`,
      500
    );
  }
}
