#!/usr/bin/env node
// Builds idempotent seed SQL for the D1 api_keys table from the two legacy
// registries. KV is authoritative for existence and name (it is what
// authenticates live traffic); ClickHouse contributes scopes and retention.
//
// Usage:
//   node scripts/seed-d1-keys.mjs --kv .seed-kv.json --clickhouse .seed-ch.json > .seed.sql
//
// --kv         JSON array of { key, value } where value is the KV JSON string
//              or object: { name, enabled }
// --clickhouse JSON array of rows from:
//              SELECT key_id, name, api_key, enabled, scopes, retention_days,
//                     toString(created_at) AS created_at FROM logs.api_keys

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

function arg(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i === process.argv.length - 1) {
    throw new Error(`missing required flag ${flag}`);
  }
  return process.argv[i + 1];
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function buildSeed(kvEntries, chRows) {
  const chByKey = new Map();
  for (const row of chRows) chByKey.set(row.api_key, row);

  const statements = [];
  const seen = new Set();

  for (const entry of kvEntries) {
    const value =
      typeof entry.value === "string" ? JSON.parse(entry.value) : entry.value;
    const ch = chByKey.get(entry.key);

    // KV wins on name only when ClickHouse has no row; a human-set ClickHouse
    // name is preferred over a generated discovered-* label.
    const name =
      ch && !String(value.name).startsWith("discovered-")
        ? value.name
        : (ch?.name ?? value.name);

    statements.push({
      apiKey: entry.key,
      keyId: ch?.key_id ?? randomUUID(),
      name,
      enabled: value.enabled === false ? 0 : 1,
      scopes: ch?.scopes || "ingest",
      retentionDays: Number(ch?.retention_days ?? 0),
      createdAt: ch?.created_at ?? new Date(0).toISOString(),
    });
    seen.add(entry.key);
  }

  // ClickHouse-only keys never authenticated (this is the bug being fixed).
  // Carry them forward enabled so UI-created keys start working.
  for (const row of chRows) {
    if (seen.has(row.api_key)) continue;
    statements.push({
      apiKey: row.api_key,
      keyId: row.key_id,
      name: row.name,
      enabled: Number(row.enabled) === 0 ? 0 : 1,
      scopes: row.scopes || "ingest",
      retentionDays: Number(row.retention_days ?? 0),
      createdAt: row.created_at,
    });
  }

  return statements
    .map(
      (s) =>
        `INSERT INTO api_keys (api_key, key_id, name, enabled, scopes, retention_days, created_at) VALUES (` +
        [
          sqlString(s.apiKey),
          sqlString(s.keyId),
          sqlString(s.name),
          s.enabled,
          sqlString(s.scopes),
          s.retentionDays,
          sqlString(s.createdAt),
        ].join(", ") +
        `) ON CONFLICT(api_key) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, ` +
        `scopes=excluded.scopes, retention_days=excluded.retention_days;`,
    )
    .join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const kv = JSON.parse(readFileSync(arg("--kv"), "utf8"));
  const ch = JSON.parse(readFileSync(arg("--clickhouse"), "utf8"));
  process.stdout.write(buildSeed(kv, ch) + "\n");
}
