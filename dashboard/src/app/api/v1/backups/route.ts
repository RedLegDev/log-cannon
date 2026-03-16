import { NextResponse } from 'next/server';
import { queryClickHouse } from '@/lib/clickhouse';

interface BackupRow {
  name: string;
  status: string;
  start_time: string;
  end_time: string;
  total_size: string;
  uncompressed_size: string;
}

export async function GET() {
  try {
    const rows = await queryClickHouse<BackupRow>(
      `SELECT name, status, start_time, end_time, formatReadableSize(total_size) as total_size, total_size as uncompressed_size
       FROM system.backups
       WHERE status = 'BACKUP_CREATED'
       ORDER BY start_time DESC`
    );

    const backups = rows.map((row) => ({
      name: row.name,
      timestamp: row.start_time,
      size: Number(row.uncompressed_size),
      size_formatted: row.total_size,
    }));

    return NextResponse.json({ backups });
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to list backups: ${e instanceof Error ? e.message : 'unknown error'}` },
      { status: 500 }
    );
  }
}
