import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  const path = process.env.AUTH_DB_PATH || "/app/data/auth.db";
  mkdirSync(dirname(path), { recursive: true });
  const handle = new Database(path);
  handle.pragma("journal_mode = WAL");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS otps (
      email      TEXT PRIMARY KEY,
      code_hash  TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  db = handle;
  return handle;
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export function putOtp(email: string, code: string, ttlSeconds: number): void {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  getDb()
    .prepare(
      `INSERT INTO otps (email, code_hash, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         code_hash  = excluded.code_hash,
         expires_at = excluded.expires_at`,
    )
    .run(email, hashCode(code), expiresAt);
}

export function consumeOtp(email: string, code: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const row = getDb()
    .prepare(
      `DELETE FROM otps
       WHERE email = ? AND code_hash = ? AND expires_at > ?
       RETURNING email`,
    )
    .get(email, hashCode(code), now);
  return row !== undefined;
}
