import { NextRequest, NextResponse } from 'next/server';
import { countLogs, parseOperatorFromValue, PropertyFilter } from '@/lib/clickhouse';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;

    const source = searchParams.get('source') || undefined;
    const level = searchParams.get('level') || undefined;
    const search = searchParams.get('search') || undefined;

    // Parse property filters
    const propertyFilters: PropertyFilter[] = [];
    searchParams.forEach((value, key) => {
      if (key.startsWith('prop.')) {
        const propKey = key.slice(5);
        const { operator, value: parsedValue } = parseOperatorFromValue(value);
        propertyFilters.push({ key: propKey, value: parsedValue, operator });
      }
    });

    // Require at least one filter
    if (!source && !level && !search && propertyFilters.length === 0) {
      return NextResponse.json({ error: 'At least one filter is required' }, { status: 400 });
    }

    const count = await countLogs(source, level, search, propertyFilters);
    return NextResponse.json({ count });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to count logs' },
      { status: 500 }
    );
  }
}
