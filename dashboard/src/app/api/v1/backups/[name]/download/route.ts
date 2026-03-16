import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const BACKUP_DIR = '/backups';
const NAME_PATTERN = /^logs-\d{4}-\d{2}-\d{2}-\d{6}$/;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;

  if (!NAME_PATTERN.test(name)) {
    return NextResponse.json({ error: 'Invalid backup name' }, { status: 400 });
  }

  const backupPath = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isDirectory()) {
    return NextResponse.json({ error: 'Backup not found' }, { status: 404 });
  }

  try {
    fs.accessSync(backupPath, fs.constants.R_OK);
  } catch {
    return NextResponse.json(
      { error: 'Backup not readable. Run a new backup to fix permissions, or chmod from the backup container.' },
      { status: 403 }
    );
  }

  try {
    const tarBuffer = execSync(`tar -czf - -C "${BACKUP_DIR}" "${name}"`, {
      maxBuffer: 1024 * 1024 * 1024, // 1GB
    });

    return new NextResponse(tarBuffer, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${name}.tar.gz"`,
        'Content-Length': tarBuffer.length.toString(),
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to create archive: ${e instanceof Error ? e.message : 'unknown error'}` },
      { status: 500 }
    );
  }
}
