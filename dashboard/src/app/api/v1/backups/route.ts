import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const BACKUP_DIR = '/backups';
const NAME_PATTERN = /^logs-\d{4}-\d{2}-\d{2}-\d{6}$/;

async function getDirSize(dirPath: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await getDirSize(fullPath);
    } else {
      const stat = await fs.stat(fullPath);
      total += stat.size;
    }
  }
  return total;
}

export async function GET() {
  try {
    const entries = await fs.readdir(BACKUP_DIR, { withFileTypes: true });
    const backups = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !NAME_PATTERN.test(entry.name)) continue;

      // Parse timestamp from name: logs-YYYY-MM-DD-HHMMSS
      const match = entry.name.match(/^logs-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/);
      let timestamp = '';
      if (match) {
        const [, y, mo, d, h, mi, s] = match;
        timestamp = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
      }

      const size = await getDirSize(path.join(BACKUP_DIR, entry.name));
      backups.push({ name: entry.name, timestamp, size });
    }

    backups.sort((a, b) => b.name.localeCompare(a.name));

    return NextResponse.json({ backups });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ backups: [] });
    }
    return NextResponse.json(
      { error: 'Failed to list backups' },
      { status: 500 }
    );
  }
}
