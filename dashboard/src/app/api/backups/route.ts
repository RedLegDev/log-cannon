import { NextResponse } from 'next/server';
import { listBackups } from '@/lib/backups';

export async function GET() {
  try {
    const backups = await listBackups();
    return NextResponse.json({ backups });
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to list backups: ${e instanceof Error ? e.message : 'unknown error'}` },
      { status: 500 }
    );
  }
}
