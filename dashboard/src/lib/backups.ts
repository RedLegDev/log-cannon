import { queryClickHouse } from '@/lib/clickhouse';

interface BackupRow {
  name: string;
  status: string;
  start_time: string;
  end_time: string;
  total_size: string;
  uncompressed_size: string;
}

export interface BackupListItem {
  name: string;
  timestamp: string;
  size: number;
  size_formatted: string;
  type: 'full' | 'incremental' | 'legacy';
}

function getBackupType(name: string): BackupListItem['type'] {
  if (name.startsWith('logs-full-')) return 'full';
  if (name.startsWith('logs-incr-')) return 'incremental';
  return 'legacy';
}

export async function listBackups(): Promise<BackupListItem[]> {
  const rows = await queryClickHouse<BackupRow>(
    `SELECT name, status, start_time, end_time, formatReadableSize(total_size) as total_size, total_size as uncompressed_size
     FROM system.backups
     WHERE status = 'BACKUP_CREATED'
     ORDER BY start_time DESC`
  );

  return rows.map((row) => ({
    name: row.name,
    timestamp: row.start_time,
    size: Number(row.uncompressed_size),
    size_formatted: row.total_size,
    type: getBackupType(row.name),
  }));
}
