// Basin retention (refs #167): once a day, drop the rows in `logs.events` that
// every key's retention window has passed.
//
// Basin SQL is read-only, so a row-level `DELETE ... WHERE key_id = …` isn't
// available, and the table is partitioned by `day(__ingest_ts)` only. What a
// Worker can do is commit an Iceberg `delete` snapshot through the REST catalog
// that drops whole day partitions: it rewrites the affected manifests with
// those data files marked DELETED and the rest carried as EXISTING, writes a
// new manifest list, and swaps `main` to it under `assert-ref-snapshot-id`.
// Nothing is rewritten in Parquet. The catalog's own snapshot expiration
// (7 days, keep 5, hourly) then removes the dropped files from R2.
//
// The cost of day partitions: a partition goes only when it ended before
// `now - longest window`, so every key keeps rows for the longest window (plus
// up to a day), not its own. Windows still resolve per key so the summary can
// say how many keys hold rows past their own window.
//
// `BASIN_RETENTION_MODE`: `off` (default), `dry-run` (plan, report, change
// nothing) or `delete`. Delete also needs the `BASIN_CATALOG_TOKEN` secret
// (R2 Data Catalog write); without it the run reports an error and deletes
// nothing.

import { readAvro, writeAvro, type AvroFile } from "./avro";
import { acquireLease, releaseLease } from "./alerts/store";
import { parseBasinTimestamp, queryBasin, type BasinSqlEnv } from "./basin-sql";

export interface RetentionEnv extends BasinSqlEnv {
  KEYS_DB: D1Database;
  /** R2 binding to the catalog's bucket, for reading and writing manifests. */
  BASIN_EVENTS?: R2Bucket;
  BASIN_CATALOG_TOKEN?: string;
  BASIN_RETENTION_MODE?: string;
  BASIN_RETENTION_DEFAULT_DAYS?: string;
}

/** The daily cron in wrangler.toml that runs this, and nothing else. */
export const RETENTION_CRON = "17 20 * * *";
const LEASE_NAME = "basin-retention";
export const LEASE_TTL_MS = 15 * 60_000;
/** For keys whose `retention_days` is 0 (v1's "forever"), and key_ids not in D1. */
export const DEFAULT_RETENTION_DAYS = 30;
/** The summary turns Warning when the oldest row's ingest day is this far past the longest window. */
export const OVERDUE_GRACE_DAYS = 2;
const MAX_COMMIT_ATTEMPTS = 4;
const DAY_MS = 86_400_000;
const NAMESPACE = "logs";
const TABLE = "events";

export type RetentionMode = "off" | "dry-run" | "delete";

export function retentionMode(v: string | undefined): RetentionMode {
  const m = v?.trim();
  return m === "dry-run" || m === "delete" ? m : "off";
}

// --- Windows ---

export interface Windows {
  defaultDays: number;
  /** Keys with their own window; anything else gets `defaultDays`. */
  byKey: Map<string, number>;
  longestDays: number;
}

export function parseDefaultDays(v: string | undefined): number {
  const n = Number(v?.trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

export function resolveWindows(rows: { key_id: string; retention_days: number }[], defaultDays: number): Windows {
  const byKey = new Map<string, number>();
  let longestDays = defaultDays;
  for (const r of rows) {
    if (r.retention_days > 0) byKey.set(r.key_id, r.retention_days);
    longestDays = Math.max(longestDays, r.retention_days);
  }
  return { defaultDays, byKey, longestDays };
}

export const windowFor = (w: Windows, keyId: string) => w.byKey.get(keyId) ?? w.defaultDays;

/** First day partition to keep: every earlier one ended before `now - longestDays`. */
export function cutoffDay(now: Date, longestDays: number): number {
  return Math.floor((now.getTime() - longestDays * DAY_MS) / DAY_MS);
}

export const dayToDate = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

// --- JSON with 63-bit snapshot ids ---

/** Parse catalog JSON, keeping integers past 2^53 (snapshot ids) exact as bigint. */
export function parseJSONBig(text: string): any {
  return JSON.parse(text, (_k, v, ctx?: { source?: string }) => {
    if (typeof v !== "number" || Number.isSafeInteger(v) || !Number.isInteger(v)) return v;
    if (!ctx?.source) throw new Error("this runtime can't parse 64-bit JSON integers exactly");
    return BigInt(ctx.source);
  });
}

export function stringifyJSONBig(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `\u0000big:${x}` : x)).replace(/"\\u0000big:(-?\d+)"/g, "$1");
}

// --- Catalog and storage ---

export class CatalogError extends Error {
  override name = "CatalogError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Catalog {
  loadTable(ns: string, table: string): Promise<TableMetadata>;
  /** Throws CatalogError; 409 means someone committed first. */
  commit(ns: string, table: string, body: unknown): Promise<void>;
}

export interface TableMetadata {
  "table-uuid": string;
  location: string;
  "current-snapshot-id"?: bigint | number | null;
  "last-sequence-number": number;
  "current-schema-id": number;
  "partition-specs": { "spec-id": number; fields: { "source-id": number; name: string; transform: string }[] }[];
  schemas: { "schema-id": number; fields: { id: number; name: string }[] }[];
  snapshots?: { "snapshot-id": bigint | number; "manifest-list": string; summary?: Record<string, string> }[];
}

/** Basin Catalog's Iceberg REST endpoint for one bucket. */
export function restCatalog(opts: { account: string; bucket: string; token: string; fetch?: typeof fetch }): Catalog {
  const doFetch = opts.fetch ?? fetch;
  const base = `https://catalog.cloudflarestorage.com/${opts.account}/${opts.bucket}/v1`;
  let prefix: Promise<string> | undefined;
  const call = async (path: string, init: RequestInit = {}): Promise<string> => {
    const res = await doFetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    if (!res.ok) throw new CatalogError(res.status, `catalog ${init.method ?? "GET"} ${path}: ${res.status} ${body.slice(0, 300)}`);
    return body;
  };
  const tablePath = async (ns: string, table: string) => {
    prefix ??= call(`/config?warehouse=${opts.account}_${opts.bucket}`).then((b) => JSON.parse(b).overrides.prefix as string);
    return `/${await prefix}/namespaces/${encodeURIComponent(ns)}/tables/${encodeURIComponent(table)}`;
  };
  return {
    async loadTable(ns, table) {
      return parseJSONBig(await call(await tablePath(ns, table))).metadata as TableMetadata;
    },
    async commit(ns, table, body) {
      await call(await tablePath(ns, table), { method: "POST", body: stringifyJSONBig(body) });
    },
  };
}

/** Manifest storage, addressed by the `s3://bucket/key` paths the catalog uses. */
export interface ObjectStore {
  get(path: string): Promise<Uint8Array>;
  put(path: string, bytes: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
}

export function r2Store(bucket: R2Bucket, bucketName: string): ObjectStore {
  const key = (path: string) => {
    const m = /^s3a?:\/\/([^/]+)\/(.+)$/.exec(path);
    if (!m || m[1] !== bucketName) throw new Error(`${path} is not in bucket ${bucketName}`);
    return m[2];
  };
  return {
    async get(path) {
      const o = await bucket.get(key(path));
      if (!o) throw new Error(`${path} not found`);
      return new Uint8Array(await o.arrayBuffer());
    },
    async put(path, bytes) {
      await bucket.put(key(path), bytes);
    },
    async delete(path) {
      await bucket.delete(key(path));
    },
  };
}

// --- Dropping day partitions ---

export interface DropResult {
  /** Day partitions (YYYY-MM-DD) dropped, or that a dry run would drop. */
  partitions: string[];
  files: number;
  records: number;
  bytes: number;
  /** The committed `delete` snapshot; absent on a dry run or when nothing matched. */
  snapshotId?: string;
  attempts: number;
  /** Manifests left alone because their partition spec has no `day(__ingest_ts)` field. */
  unreadableSpecs?: number;
}

type ManifestRec = Record<string, unknown> & {
  manifest_path: string;
  partition_spec_id: number;
  content: number;
  sequence_number: bigint;
  added_snapshot_id: bigint;
  added_files_count: number;
  existing_files_count: number;
  partitions: { lower_bound: Uint8Array | null; upper_bound: Uint8Array | null }[] | null;
};

type Entry = Record<string, unknown> & {
  status: number;
  snapshot_id: bigint | null;
  sequence_number: bigint | null;
  file_sequence_number: bigint | null;
  data_file: Record<string, unknown> & { partition: Record<string, unknown>; record_count: bigint; file_size_in_bytes: bigint };
};

const int32 = (b: Uint8Array | null | undefined) => (b && b.length === 4 ? new DataView(b.buffer, b.byteOffset, 4).getInt32(0, true) : null);

function int32Bytes(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return b;
}

interface DayField {
  name: string;
  index: number;
}

/** The partition field holding `day(__ingest_ts)`, and its position, per spec id. */
function dayFields(meta: TableMetadata): Map<number, DayField> {
  const schema = meta.schemas.find((s) => s["schema-id"] === meta["current-schema-id"]) ?? meta.schemas[meta.schemas.length - 1];
  const ingestId = schema.fields.find((f) => f.name === "__ingest_ts")?.id;
  const out = new Map<number, DayField>();
  for (const spec of meta["partition-specs"]) {
    const index = spec.fields.findIndex((f) => f["source-id"] === ingestId && f.transform === "day");
    if (index !== -1) out.set(spec["spec-id"], { name: spec.fields[index].name, index });
  }
  return out;
}

function randomSnapshotId(): bigint {
  const b = crypto.getRandomValues(new BigUint64Array(1))[0];
  return BigInt.asUintN(63, b) || 1n;
}

export interface DropOptions {
  dryRun: boolean;
  ns?: string;
  table?: string;
  now?: () => Date;
}

/**
 * Drop every data file whose day partition is before `cutoff` (days since the
 * epoch), as one `delete` snapshot. Retries from a fresh load when another
 * writer (the Pipelines sink, compaction) commits first.
 */
export async function dropPartitionsBefore(catalog: Catalog, store: ObjectStore, cutoff: number, opts: DropOptions): Promise<DropResult> {
  const ns = opts.ns ?? NAMESPACE;
  const table = opts.table ?? TABLE;
  const now = opts.now ?? (() => new Date());
  for (let attempt = 1; ; attempt++) {
    const meta = await catalog.loadTable(ns, table);
    const plan = await planDrop(meta, store, cutoff);
    const result: DropResult = { ...plan.stats, attempts: attempt };
    if (opts.dryRun || plan.stats.files === 0) return result;

    const written: string[] = [];
    const put = async (path: string, bytes: Uint8Array) => {
      await store.put(path, bytes);
      written.push(path);
      return bytes.length;
    };
    try {
      const { snapshotId, commit } = await writeSnapshot(meta, plan, now(), put);
      await catalog.commit(ns, table, commit);
      return { ...result, snapshotId: snapshotId.toString() };
    } catch (e) {
      // Only a 409 is a known non-commit, so only then are our files safe to
      // remove. Anything else may have committed; leave them.
      if (!(e instanceof CatalogError && e.status === 409)) throw e;
      await Promise.all(written.map((p) => store.delete(p).catch(() => {})));
      if (attempt >= MAX_COMMIT_ATTEMPTS) throw new Error(`gave up after ${attempt} commit conflicts`);
    }
  }
}

interface Rewrite {
  source: ManifestRec;
  file: AvroFile;
  field: DayField;
  dropped: Entry[];
  kept: Entry[];
}

interface Plan {
  baseSnapshotId: bigint;
  manifestListFile: AvroFile;
  untouched: ManifestRec[];
  rewrites: Rewrite[];
  stats: Omit<DropResult, "attempts" | "snapshotId">;
}

async function planDrop(meta: TableMetadata, store: ObjectStore, cutoff: number): Promise<Plan> {
  const current = meta["current-snapshot-id"];
  const snap = meta.snapshots?.find((s) => BigInt(s["snapshot-id"]) === BigInt(current ?? -1));
  if (current == null || !snap) throw new Error("table has no current snapshot");
  const manifestListFile = await readAvro(await store.get(snap["manifest-list"]));
  const fields = dayFields(meta);
  const untouched: ManifestRec[] = [];
  const candidates: { rec: ManifestRec; field: DayField }[] = [];
  let unreadableSpecs = 0;
  for (const rec of manifestListFile.records as ManifestRec[]) {
    const field = fields.get(rec.partition_spec_id);
    const lower = field ? int32(rec.partitions?.[field.index]?.lower_bound) : null;
    // Delete manifests, anything this can't place by day, and manifests wholly
    // inside the window stay as they are.
    // A manifest with no live files (one this job already rewrote, all DELETED)
    // is carried as is rather than re-read every day.
    const live = Number(rec.added_files_count) + Number(rec.existing_files_count);
    if (rec.content === 0 && !field) unreadableSpecs++;
    if (rec.content !== 0 || !field || lower === null || lower >= cutoff || live === 0) untouched.push(rec);
    else candidates.push({ rec, field });
  }
  const files = await Promise.all(candidates.map(async ({ rec }) => readAvro(await store.get(rec.manifest_path))));

  const days = new Set<number>();
  let records = 0;
  let bytes = 0;
  const rewrites: Rewrite[] = [];
  for (const [i, { rec, field }] of candidates.entries()) {
    const rw: Rewrite = { source: rec, file: files[i], field, dropped: [], kept: [] };
    for (const e of files[i].records as Entry[]) {
      if (e.status === 2) continue; // deleted by an earlier snapshot; not live
      // Materialise what an ADDED entry inherits from its manifest, since it
      // moves to a manifest written by a different snapshot.
      const entry: Entry = {
        ...e,
        snapshot_id: e.snapshot_id ?? rec.added_snapshot_id,
        sequence_number: e.sequence_number ?? rec.sequence_number,
        file_sequence_number: e.file_sequence_number ?? rec.sequence_number,
      };
      const day = e.data_file.partition[field.name];
      if (typeof day === "number" && day < cutoff) {
        rw.dropped.push(entry);
        days.add(day);
        records += Number(e.data_file.record_count);
        bytes += Number(e.data_file.file_size_in_bytes);
      } else {
        rw.kept.push(entry);
      }
    }
    if (rw.dropped.length) rewrites.push(rw);
    else untouched.push(rec);
  }
  return {
    baseSnapshotId: BigInt(current),
    manifestListFile,
    untouched,
    rewrites,
    stats: {
      partitions: [...days].sort((a, b) => a - b).map(dayToDate),
      files: rewrites.reduce((n, rw) => n + rw.dropped.length, 0),
      records,
      bytes,
      ...(unreadableSpecs ? { unreadableSpecs } : {}),
    },
  };
}

/** Write the new manifests and manifest list; return the catalog commit that swaps `main` to them. */
async function writeSnapshot(
  meta: TableMetadata,
  plan: Plan,
  at: Date,
  put: (path: string, bytes: Uint8Array) => Promise<number>,
): Promise<{ snapshotId: bigint; commit: unknown }> {
  const snapshotId = randomSnapshotId();
  const seq = BigInt(meta["last-sequence-number"]) + 1n;
  const dir = `${meta.location.replace(/\/$/, "")}/metadata`;
  const sum = (es: Entry[]) => es.reduce((n, e) => n + e.data_file.record_count, 0n);

  const newManifests: ManifestRec[] = [];
  for (const [i, rw] of plan.rewrites.entries()) {
    const entries: Entry[] = [
      ...rw.dropped.map((e) => ({ ...e, status: 2, snapshot_id: snapshotId })),
      ...rw.kept.map((e) => ({ ...e, status: 0 })),
    ];
    const path = `${dir}/${crypto.randomUUID()}-m${i}.avro`;
    const length = await put(path, writeAvro({ ...rw.file, records: entries }));
    const days = entries.map((e) => e.data_file.partition[rw.field.name] as number);
    const partitions = (rw.source.partitions ?? []).map((p, idx) =>
      idx === rw.field.index ? { ...p, lower_bound: int32Bytes(Math.min(...days)), upper_bound: int32Bytes(Math.max(...days)) } : p,
    );
    newManifests.push({
      ...rw.source,
      manifest_path: path,
      manifest_length: BigInt(length),
      sequence_number: seq,
      min_sequence_number: entries.reduce((m, e) => (e.sequence_number! < m ? e.sequence_number! : m), seq),
      added_snapshot_id: snapshotId,
      added_files_count: 0,
      existing_files_count: rw.kept.length,
      deleted_files_count: rw.dropped.length,
      added_rows_count: 0n,
      existing_rows_count: sum(rw.kept),
      deleted_rows_count: sum(rw.dropped),
      partitions,
    });
  }

  const listPath = `${dir}/snap-${snapshotId}-1-${crypto.randomUUID()}.avro`;
  await put(
    listPath,
    writeAvro({
      schema: plan.manifestListFile.schema,
      metadata: {
        ...plan.manifestListFile.metadata,
        "snapshot-id": snapshotId.toString(),
        "parent-snapshot-id": plan.baseSnapshotId.toString(),
        "sequence-number": seq.toString(),
      },
      records: [...newManifests, ...plan.untouched],
    }),
  );

  const { files, records, bytes, partitions } = plan.stats;
  const parent = meta.snapshots?.find((s) => BigInt(s["snapshot-id"]) === plan.baseSnapshotId)?.summary ?? {};
  const summary: Record<string, string> = {
    operation: "delete",
    "deleted-data-files": String(files),
    "deleted-records": String(records),
    "removed-files-size": String(bytes),
    "changed-partition-count": String(partitions.length),
  };
  for (const [total, less] of Object.entries({ "total-data-files": files, "total-records": records, "total-files-size": bytes })) {
    const n = Number(parent[total]);
    if (Number.isFinite(n)) summary[total] = String(Math.max(0, n - less));
  }

  const commit = {
    requirements: [
      { type: "assert-table-uuid", uuid: meta["table-uuid"] },
      { type: "assert-ref-snapshot-id", ref: "main", "snapshot-id": plan.baseSnapshotId },
    ],
    updates: [
      {
        action: "add-snapshot",
        snapshot: {
          "snapshot-id": snapshotId,
          "parent-snapshot-id": plan.baseSnapshotId,
          "sequence-number": seq,
          "timestamp-ms": at.getTime(),
          "manifest-list": listPath,
          summary,
          "schema-id": meta["current-schema-id"],
        },
      },
      { action: "set-snapshot-ref", "ref-name": "main", type: "branch", "snapshot-id": snapshotId },
    ],
  };
  return { snapshotId, commit };
}

// --- The daily run ---

export interface RetentionDeps {
  now: () => Date;
  /** CLEF lines for the Worker's telemetry source. Never throws. */
  emit: (lines: string[]) => Promise<void>;
  catalog?: Catalog;
  store?: ObjectStore;
  /** Oldest rows per key_id; defaults to one Basin SQL query. */
  oldestByKey?: () => Promise<Map<string, OldestRows>>;
}

/**
 * Retention works on ingest time (`__ingest_ts`, the partition source), so the
 * overdue and per-key checks do too. `ts` is the sender's event time and can be
 * far older than ingest (a backdated probe row carries a 2025 `ts`); it's
 * reported, never judged.
 */
export interface OldestRows {
  ingest: Date;
  ts: Date;
}

export interface KeyAge {
  keyId: string;
  windowDays: number;
  oldest: string;
  ageDays: number;
}

export interface RetentionRun {
  skipped?: "off" | "lease-held";
  mode: RetentionMode;
  cutoff?: string;
  longestWindowDays?: number;
  defaultWindowDays?: number;
  drop?: DropResult;
  /** Oldest `__ingest_ts`, and its age in whole days. */
  oldestIngest?: string;
  oldestIngestAgeDays?: number;
  /** Oldest event `ts`, for information only. */
  oldestTs?: string;
  /** Keys holding rows ingested more than a day past their own window. */
  keysPastOwnWindow?: KeyAge[];
  overdue?: boolean;
  error?: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runBasinRetention(env: RetentionEnv, deps: RetentionDeps): Promise<RetentionRun> {
  const mode = retentionMode(env.BASIN_RETENTION_MODE);
  if (mode === "off") return { mode, skipped: "off" };
  const holder = crypto.randomUUID();
  if (!(await acquireLease(env.KEYS_DB, LEASE_NAME, holder, deps.now().getTime(), LEASE_TTL_MS))) {
    return { mode, skipped: "lease-held" };
  }
  const run: RetentionRun = { mode };
  try {
    const now = deps.now();
    const { results } = await env.KEYS_DB.prepare("SELECT key_id, retention_days FROM api_keys").all<{ key_id: string; retention_days: number }>();
    const windows = resolveWindows(results, parseDefaultDays(env.BASIN_RETENTION_DEFAULT_DAYS));
    const cutoff = cutoffDay(now, windows.longestDays);
    run.cutoff = dayToDate(cutoff);
    run.longestWindowDays = windows.longestDays;
    run.defaultWindowDays = windows.defaultDays;

    try {
      const account = env.BASIN_SQL_ACCOUNT?.trim();
      const bucket = env.BASIN_SQL_BUCKET?.trim();
      const readToken = env.BASIN_CATALOG_TOKEN?.trim() || env.BASIN_SQL_TOKEN?.trim();
      const store = deps.store ?? (env.BASIN_EVENTS && bucket ? r2Store(env.BASIN_EVENTS, bucket) : undefined);
      const catalog = deps.catalog ?? (account && bucket && readToken ? restCatalog({ account, bucket, token: readToken }) : undefined);
      if (!catalog || !store) throw new Error("not configured: needs BASIN_EVENTS, BASIN_SQL_ACCOUNT, BASIN_SQL_BUCKET and a catalog token");
      // Delete mode without a write token plans like a dry run and says why.
      const canDelete = mode === "delete" && !!env.BASIN_CATALOG_TOKEN?.trim();
      if (mode === "delete" && !canDelete) run.error = "delete mode needs the BASIN_CATALOG_TOKEN secret; nothing deleted";
      run.drop = await dropPartitionsBefore(catalog, store, cutoff, { dryRun: !canDelete, now: deps.now });
    } catch (e) {
      run.error = message(e);
    }

    try {
      const oldest = await (deps.oldestByKey ?? (() => oldestByKey(env)))();
      const past: KeyAge[] = [];
      let minIngest: Date | undefined;
      let minTs: Date | undefined;
      for (const [keyId, o] of oldest) {
        if (!minIngest || o.ingest < minIngest) minIngest = o.ingest;
        if (!minTs || o.ts < minTs) minTs = o.ts;
        const windowDays = windowFor(windows, keyId);
        const ageDays = (now.getTime() - o.ingest.getTime()) / DAY_MS;
        if (ageDays > windowDays + 1) past.push({ keyId, windowDays, oldest: o.ingest.toISOString(), ageDays: Math.floor(ageDays) });
      }
      if (minIngest) {
        run.oldestIngest = minIngest.toISOString();
        run.oldestIngestAgeDays = Math.floor((now.getTime() - minIngest.getTime()) / DAY_MS);
        run.overdue = run.oldestIngestAgeDays > windows.longestDays + OVERDUE_GRACE_DAYS;
      }
      if (minTs) run.oldestTs = minTs.toISOString();
      run.keysPastOwnWindow = past;
    } catch (e) {
      run.error = [run.error, `oldest-row query: ${message(e)}`].filter(Boolean).join("; ");
    }

    await deps.emit([retentionSummaryCLEF(run, now)]);
    return run;
  } finally {
    await releaseLease(env.KEYS_DB, LEASE_NAME, holder).catch(() => {});
  }
}

async function oldestByKey(env: RetentionEnv): Promise<Map<string, OldestRows>> {
  const { rows } = await queryBasin<{ key_id: string; oldest_ingest: string; oldest_ts: string }>(
    env,
    `SELECT key_id, CAST(min(__ingest_ts) AS VARCHAR) AS oldest_ingest, CAST(min(ts) AS VARCHAR) AS oldest_ts
     FROM ${NAMESPACE}.${TABLE} GROUP BY key_id`,
  );
  const out = new Map<string, OldestRows>();
  for (const r of rows) {
    const ingest = parseBasinTimestamp(r.oldest_ingest);
    const ts = parseBasinTimestamp(r.oldest_ts);
    if (!ingest || !ts) throw new Error(`unreadable timestamps for ${r.key_id}: ${r.oldest_ingest}, ${r.oldest_ts}`);
    out.set(r.key_id, { ingest, ts });
  }
  return out;
}

/** One summary per run. Aggregates only, so the row stays well under Basin's
 * 2,000-byte `json_get` limit; the per-key detail goes to Workers Logs. A
 * failed or overdue run is a Warning, never an Error: `level = 'Error'` on
 * this source is what the enqueue-loss alert pages on. */
export function retentionSummaryCLEF(r: RetentionRun, at: Date): string {
  const d = r.drop;
  return JSON.stringify({
    "@t": at.toISOString(),
    "@l": r.error || r.overdue ? "Warning" : "Information",
    "@mt":
      r.mode === "delete" && !r.error
        ? "Basin retention dropped {Records} rows in {Files} files from {Partitions} day partitions before {Cutoff}; oldest row ingested {OldestIngest}"
        : "Basin retention ({Mode}) would drop {Records} rows in {Files} files from {Partitions} day partitions before {Cutoff}; oldest row ingested {OldestIngest}",
    Mode: r.mode,
    Cutoff: r.cutoff,
    LongestWindowDays: r.longestWindowDays,
    DefaultWindowDays: r.defaultWindowDays,
    Partitions: d?.partitions.length ?? 0,
    FirstPartition: d?.partitions[0],
    LastPartition: d?.partitions[d.partitions.length - 1],
    Files: d?.files ?? 0,
    Records: d?.records ?? 0,
    Bytes: d?.bytes ?? 0,
    SnapshotId: d?.snapshotId,
    Attempts: d?.attempts,
    UnreadableSpecs: d?.unreadableSpecs,
    OldestIngest: r.oldestIngest,
    OldestIngestAgeDays: r.oldestIngestAgeDays,
    OldestTs: r.oldestTs,
    KeysPastOwnWindow: r.keysPastOwnWindow?.length,
    Overdue: r.overdue,
    Error: r.error?.slice(0, 500),
  });
}
