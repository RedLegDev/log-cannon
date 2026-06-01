import { NextResponse } from 'next/server';
import { getBuildInfo } from '@/lib/build-info';

// Static stamp, but read env overrides at request time and never cache.
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(getBuildInfo());
}
