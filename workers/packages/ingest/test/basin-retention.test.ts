// Basin retention (refs #167): window resolution, the Avro manifest round
// trip, the day-partition drop against a fake catalog and in-memory storage
// (dry run, commit, conflict retry), the lease, and the summary row.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { acquireLease } from "../src/alerts/store";
import { inflateRaw, readAvro, writeAvro, type AvroSchema } from "../src/avro";
import {
  CatalogError,
  cutoffDay,
  dropPartitionsBefore,
  parseDefaultDays,
  parseJSONBig,
  r2Store,
  resolveWindows,
  retentionMode,
  retentionSummaryCLEF,
  runBasinRetention,
  stringifyJSONBig,
  windowFor,
  type Catalog,
  type ObjectStore,
  type RetentionDeps,
  type TableMetadata,
} from "../src/basin-retention";

const NOW = new Date("2026-12-01T12:00:00.000Z");
const day = (iso: string) => Math.floor(Date.parse(iso) / 86_400_000);
const LOC = "s3://events-bucket/__r2_data_catalog/ns/tbl";
// Past 2^53, as real snapshot ids are; a Number would round these.
const BASE_SNAPSHOT = 1404392646563886685n;
const OLD_SNAPSHOT = 5171990664848147877n;

// A cut-down Iceberg v2 manifest entry schema: the same shapes (nullable longs,
// a partition record, a date int, an array of key/value records) as the real one.
const ENTRY_SCHEMA: AvroSchema = {
  type: "record",
  name: "manifest_entry",
  fields: [
    { name: "status", type: "int" },
    { name: "snapshot_id", type: ["null", "long"] },
    { name: "sequence_number", type: ["null", "long"] },
    { name: "file_sequence_number", type: ["null", "long"] },
    {
      name: "data_file",
      type: {
        type: "record",
        name: "r2",
        fields: [
          { name: "content", type: "int" },
          { name: "file_path", type: "string" },
          { name: "file_format", type: "string" },
          {
            name: "partition",
            type: { type: "record", name: "r102", fields: [{ name: "__ingest_ts_day", type: ["null", { type: "int", logicalType: "date" }] }] },
          },
          { name: "record_count", type: "long" },
          { name: "file_size_in_bytes", type: "long" },
          {
            name: "lower_bounds",
            type: ["null", { type: "array", items: { type: "record", name: "k126_v127", fields: [{ name: "key", type: "int" }, { name: "value", type: "bytes" }] } }],
          },
        ],
      },
    },
  ],
};

const LIST_SCHEMA: AvroSchema = {
  type: "record",
  name: "manifest_file",
  fields: [
    { name: "manifest_path", type: "string" },
    { name: "manifest_length", type: "long" },
    { name: "partition_spec_id", type: "int" },
    { name: "content", type: "int" },
    { name: "sequence_number", type: "long" },
    { name: "min_sequence_number", type: "long" },
    { name: "added_snapshot_id", type: "long" },
    { name: "added_files_count", type: "int" },
    { name: "existing_files_count", type: "int" },
    { name: "deleted_files_count", type: "int" },
    { name: "added_rows_count", type: "long" },
    { name: "existing_rows_count", type: "long" },
    { name: "deleted_rows_count", type: "long" },
    {
      name: "partitions",
      type: [
        "null",
        {
          type: "array",
          items: {
            type: "record",
            name: "r508",
            fields: [
              { name: "contains_null", type: "boolean" },
              { name: "contains_nan", type: ["null", "boolean"] },
              { name: "lower_bound", type: ["null", "bytes"] },
              { name: "upper_bound", type: ["null", "bytes"] },
            ],
          },
        },
      ],
    },
    { name: "key_metadata", type: ["null", "bytes"] },
  ],
};

function int32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return b;
}
const fromInt32 = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, 4).getInt32(0, true);

function memStore() {
  const files = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    async get(p) {
      const b = files.get(p);
      if (!b) throw new Error(`${p} not found`);
      return b;
    },
    async put(p, b) {
      files.set(p, b);
    },
    async delete(p) {
      files.delete(p);
    },
  };
  return { files, store };
}

interface FileSpec {
  day: number;
  rows: number;
  status?: number;
}

/**
 * Three manifests: one all before the cutoff, one straddling it (written by an
 * older snapshot, entries inheriting their sequence number), one after it.
 */
function seedTable(store: ReturnType<typeof memStore>, cutoff: number) {
  let n = 0;
  const manifest = (seq: bigint, snap: bigint, files: FileSpec[]) => {
    const path = `${LOC}/metadata/m${n++}.avro`;
    const bytes = writeAvro({
      schema: ENTRY_SCHEMA,
      metadata: { "format-version": "2", content: "data", "partition-spec-id": "0" },
      records: files.map((f, i) => ({
        status: f.status ?? 1,
        snapshot_id: null,
        sequence_number: null,
        file_sequence_number: null,
        data_file: {
          content: 0,
          file_path: `${LOC}/data/${path.slice(-6, -5)}-${i}.parquet`,
          file_format: "PARQUET",
          partition: { __ingest_ts_day: f.day },
          record_count: BigInt(f.rows),
          file_size_in_bytes: BigInt(f.rows * 10),
          lower_bounds: [{ key: 3, value: new Uint8Array([1, 2, 3]) }],
        },
      })),
    });
    store.files.set(path, bytes);
    const days = files.map((f) => f.day);
    return {
      manifest_path: path,
      manifest_length: BigInt(bytes.length),
      partition_spec_id: 0,
      content: 0,
      sequence_number: seq,
      min_sequence_number: seq,
      added_snapshot_id: snap,
      added_files_count: files.length,
      existing_files_count: 0,
      deleted_files_count: 0,
      added_rows_count: BigInt(files.reduce((s, f) => s + f.rows, 0)),
      existing_rows_count: 0n,
      deleted_rows_count: 0n,
      partitions: [{ contains_null: false, contains_nan: false, lower_bound: int32(Math.min(...days)), upper_bound: int32(Math.max(...days)) }],
      key_metadata: null,
    };
  };
  const old = manifest(3n, OLD_SNAPSHOT, [
    { day: cutoff - 3, rows: 100 },
    { day: cutoff - 2, rows: 50 },
    { day: cutoff - 2, rows: 7, status: 2 }, // already deleted; must not come back
  ]);
  const mixed = manifest(5n, OLD_SNAPSHOT, [
    { day: cutoff - 1, rows: 20 },
    { day: cutoff, rows: 30 },
  ]);
  const fresh = manifest(9n, BASE_SNAPSHOT, [{ day: cutoff + 5, rows: 40 }]);
  const listPath = `${LOC}/metadata/snap-base.avro`;
  store.files.set(listPath, writeAvro({ schema: LIST_SCHEMA, metadata: { "format-version": "2", "snapshot-id": String(BASE_SNAPSHOT) }, records: [old, mixed, fresh] }));
  const meta: TableMetadata = {
    "table-uuid": "uuid-1",
    location: LOC,
    "current-snapshot-id": BASE_SNAPSHOT,
    "last-sequence-number": 9,
    "current-schema-id": 0,
    "partition-specs": [{ "spec-id": 0, fields: [{ "source-id": 1, name: "__ingest_ts_day", transform: "day" }] }],
    schemas: [{ "schema-id": 0, fields: [{ id: 1, name: "__ingest_ts" }, { id: 6, name: "key_id" }] }],
    snapshots: [{ "snapshot-id": BASE_SNAPSHOT, "manifest-list": listPath, summary: { "total-records": "240", "total-data-files": "5" } }],
  };
  return { meta, paths: { old: old.manifest_path, mixed: mixed.manifest_path, fresh: fresh.manifest_path } };
}

function fakeCatalog(meta: TableMetadata, conflicts = 0) {
  const commits: any[] = [];
  let left = conflicts;
  const catalog: Catalog = {
    loadTable: async () => meta,
    commit: async (_ns, _t, body) => {
      // Round-trip through the wire format, as the real catalog would see it.
      const wire = parseJSONBig(stringifyJSONBig(body));
      if (left-- > 0) throw new CatalogError(409, "CommitFailedException");
      commits.push(wire);
    },
  };
  return { catalog, commits };
}

describe("windows", () => {
  it("resolves per key, maps 0 to the default, and takes the longest", () => {
    const w = resolveWindows(
      [
        { key_id: "a", retention_days: 21 },
        { key_id: "b", retention_days: 0 },
        { key_id: "c", retention_days: 45 },
      ],
      30,
    );
    expect(windowFor(w, "a")).toBe(21);
    expect(windowFor(w, "b")).toBe(30);
    expect(windowFor(w, "not-in-d1")).toBe(30);
    expect(w.longestDays).toBe(45);
    expect(resolveWindows([{ key_id: "a", retention_days: 21 }], 30).longestDays).toBe(30);
  });

  it("parses the default and the mode, falling back safely", () => {
    expect(parseDefaultDays("14")).toBe(14);
    expect(parseDefaultDays("0")).toBe(30);
    expect(parseDefaultDays("abc")).toBe(30);
    expect(parseDefaultDays(undefined)).toBe(30);
    expect(retentionMode(" dry-run ")).toBe("dry-run");
    expect(retentionMode("delete")).toBe("delete");
    expect(retentionMode("yes")).toBe("off");
    expect(retentionMode(undefined)).toBe("off");
  });

  it("keeps a partition until the whole day is past the window", () => {
    // 30 days before 2026-12-01T12:00 is 2026-11-01T12:00: 10-31 is wholly
    // past, 11-01 is not.
    expect(cutoffDay(NOW, 30)).toBe(day("2026-11-01"));
    expect(cutoffDay(new Date("2026-12-01T00:00:00Z"), 30)).toBe(day("2026-11-01"));
  });
});

describe("JSON with 64-bit ids", () => {
  it("round-trips snapshot ids exactly", () => {
    const parsed = parseJSONBig(`{"current-snapshot-id":2576384493690919913,"n":5,"f":1.5}`);
    expect(parsed["current-snapshot-id"]).toBe(2576384493690919913n);
    expect(parsed.n).toBe(5);
    expect(stringifyJSONBig({ id: 2576384493690919913n, s: "x" })).toBe(`{"id":2576384493690919913,"s":"x"}`);
  });
});

describe("avro", () => {
  it("reads back what it writes, longs as exact bigints", async () => {
    const s = memStore();
    const { paths } = seedTable(s, 100);
    const f = await readAvro(s.files.get(paths.old)!);
    expect(f.metadata["format-version"]).toBe("2");
    expect(f.records).toHaveLength(3);
    expect(f.records[0]).toMatchObject({ status: 1, snapshot_id: null, data_file: { partition: { __ingest_ts_day: 97 }, record_count: 100n } });
    const again = await readAvro(writeAvro(f));
    expect(again.records).toEqual(f.records);
    expect((await readAvro(writeAvro({ schema: "long", metadata: {}, records: [BASE_SNAPSHOT as any] }))).records).toEqual([BASE_SNAPSHOT]);
  });

  it("inflates raw deflate, including PyIceberg's three trailing checksum bytes", async () => {
    const plain = new TextEncoder().encode("manifest entries ".repeat(200));
    const raw = new Uint8Array(await new Response(new Blob([plain]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
    expect(await inflateRaw(raw)).toEqual(plain);
    const pyiceberg = new Uint8Array([...raw, 0x12, 0x34, 0x56]);
    expect(await inflateRaw(pyiceberg)).toEqual(plain);
    await expect(inflateRaw(new Uint8Array([0xff, 0xff, 0xff]))).rejects.toThrow();
  });

  it("refuses a codec it can't read rather than misreading it", async () => {
    const bytes = writeAvro({ schema: "int", metadata: { "avro.codec": "snappy" }, records: [] });
    await expect(readAvro(bytes)).rejects.toThrow(/unsupported codec snappy/);
  });
});

describe("dropPartitionsBefore", () => {
  const CUTOFF = day("2026-11-01");

  it("dry run reports the partitions and rows and writes nothing", async () => {
    const s = memStore();
    const { meta } = seedTable(s, CUTOFF);
    const before = new Set(s.files.keys());
    const { catalog, commits } = fakeCatalog(meta);
    const r = await dropPartitionsBefore(catalog, s.store, CUTOFF, { dryRun: true });
    expect(r).toEqual({ partitions: ["2026-10-29", "2026-10-30", "2026-10-31"], files: 3, records: 170, bytes: 1700, attempts: 1 });
    expect(commits).toEqual([]);
    expect(new Set(s.files.keys())).toEqual(before);
  });

  it("commits one delete snapshot: dropped files DELETED, the rest carried, other manifests untouched", async () => {
    const s = memStore();
    const { meta, paths } = seedTable(s, CUTOFF);
    const { catalog, commits } = fakeCatalog(meta);
    const r = await dropPartitionsBefore(catalog, s.store, CUTOFF, { dryRun: false, now: () => NOW });
    expect(r.files).toBe(3);
    expect(commits).toHaveLength(1);
    const [c] = commits;
    expect(c.requirements).toEqual([
      { type: "assert-table-uuid", uuid: "uuid-1" },
      { type: "assert-ref-snapshot-id", ref: "main", "snapshot-id": BASE_SNAPSHOT },
    ]);
    const snap = c.updates[0].snapshot;
    expect(BigInt(snap["snapshot-id"]).toString()).toBe(r.snapshotId);
    expect(snap["parent-snapshot-id"]).toBe(BASE_SNAPSHOT);
    expect(snap["sequence-number"]).toBe(10);
    expect(snap.summary).toMatchObject({ operation: "delete", "deleted-data-files": "3", "deleted-records": "170", "total-records": "70", "total-data-files": "2" });
    expect(c.updates[1]).toMatchObject({ action: "set-snapshot-ref", "ref-name": "main", type: "branch" });

    const list = await readAvro(s.files.get(snap["manifest-list"])!);
    expect(list.metadata).toMatchObject({ "snapshot-id": r.snapshotId, "parent-snapshot-id": String(BASE_SNAPSHOT), "sequence-number": "10" });
    const listed = list.records as any[];
    expect(listed.map((m) => m.manifest_path)).toContain(paths.fresh);
    expect(listed.map((m) => m.manifest_path)).not.toContain(paths.old);
    expect(listed.map((m) => m.manifest_path)).not.toContain(paths.mixed);
    const rewritten = listed.filter((m) => m.added_snapshot_id === BigInt(r.snapshotId!));
    expect(rewritten).toHaveLength(2);

    const entries = (await Promise.all(rewritten.map((m) => readAvro(s.files.get(m.manifest_path)!)))).flatMap((f) => f.records as any[]);
    const byDay = (d: number) => entries.filter((e) => e.data_file.partition.__ingest_ts_day === d);
    // Everything before the cutoff is DELETED by the new snapshot, keeping its
    // original sequence numbers; the earlier DELETED entry is gone, not revived.
    for (const d of [CUTOFF - 3, CUTOFF - 2, CUTOFF - 1]) {
      for (const e of byDay(d)) expect(e).toMatchObject({ status: 2, snapshot_id: BigInt(r.snapshotId!) });
    }
    expect(byDay(CUTOFF - 2)).toHaveLength(1);
    expect(byDay(CUTOFF - 3)[0]).toMatchObject({ sequence_number: 3n, file_sequence_number: 3n });
    // The cutoff day stays, as EXISTING, with what it inherited made explicit.
    expect(byDay(CUTOFF)).toEqual([expect.objectContaining({ status: 0, snapshot_id: OLD_SNAPSHOT, sequence_number: 5n, file_sequence_number: 5n })]);
    expect(byDay(CUTOFF)[0].data_file.lower_bounds).toEqual([{ key: 3, value: new Uint8Array([1, 2, 3]) }]);

    const mixed = rewritten.find((m) => m.existing_files_count === 1)!;
    expect(mixed).toMatchObject({ sequence_number: 10n, min_sequence_number: 5n, deleted_files_count: 1, existing_rows_count: 30n, deleted_rows_count: 20n, added_files_count: 0 });
    expect(fromInt32(mixed.partitions[0].lower_bound)).toBe(CUTOFF - 1);
    expect(fromInt32(mixed.partitions[0].upper_bound)).toBe(CUTOFF);
  });

  it("doesn't re-read a manifest it already emptied on the next run", async () => {
    const s = memStore();
    const { meta } = seedTable(s, CUTOFF);
    const { catalog, commits } = fakeCatalog(meta);
    const r = await dropPartitionsBefore(catalog, s.store, CUTOFF, { dryRun: false });
    const listPath = commits[0].updates[0].snapshot["manifest-list"];
    const next = { ...meta, "current-snapshot-id": BigInt(r.snapshotId!), snapshots: [{ "snapshot-id": BigInt(r.snapshotId!), "manifest-list": listPath }] };
    const emptied = ((await readAvro(s.files.get(listPath)!)).records as any[]).find((m) => m.deleted_files_count === 2)!.manifest_path;
    const reads: string[] = [];
    const counting = { ...s.store, get: (p: string) => (reads.push(p), s.store.get(p)) };
    const again = await dropPartitionsBefore(fakeCatalog(next).catalog, counting, CUTOFF, { dryRun: true });
    expect(again.files).toBe(0);
    expect(reads).not.toContain(emptied);
  });

  it("writes nothing when no partition is old enough", async () => {
    const s = memStore();
    const { meta } = seedTable(s, CUTOFF);
    const { catalog, commits } = fakeCatalog(meta);
    const r = await dropPartitionsBefore(catalog, s.store, CUTOFF - 10, { dryRun: false });
    expect(r).toMatchObject({ partitions: [], files: 0 });
    expect(commits).toEqual([]);
  });

  it("retries a commit conflict from a fresh load and removes the losing attempt's files", async () => {
    const s = memStore();
    const { meta } = seedTable(s, CUTOFF);
    const before = s.files.size;
    const { catalog, commits } = fakeCatalog(meta, 1);
    const r = await dropPartitionsBefore(catalog, s.store, CUTOFF, { dryRun: false });
    expect(r.attempts).toBe(2);
    expect(commits).toHaveLength(1);
    // One manifest list and two manifests from the winning attempt only.
    expect(s.files.size).toBe(before + 3);
  });

  it("gives up after repeated conflicts", async () => {
    const s = memStore();
    const { meta } = seedTable(s, CUTOFF);
    const { catalog } = fakeCatalog(meta, 99);
    await expect(dropPartitionsBefore(catalog, s.store, CUTOFF, { dryRun: false })).rejects.toThrow(/gave up after 4 commit conflicts/);
  });
});

describe("r2Store", () => {
  it("maps s3:// paths onto its own bucket and refuses another", async () => {
    const store = r2Store(env.BASIN_SPILL, "events-bucket");
    await store.put("s3://events-bucket/a/b.avro", new Uint8Array([7]));
    expect(await store.get("s3://events-bucket/a/b.avro")).toEqual(new Uint8Array([7]));
    await store.delete("s3://events-bucket/a/b.avro");
    await expect(store.get("s3://other/a/b.avro")).rejects.toThrow(/not in bucket events-bucket/);
  });
});

describe("runBasinRetention", () => {
  const CUTOFF = day("2026-11-01");

  beforeEach(async () => {
    await env.KEYS_DB.exec("DELETE FROM cron_leases");
    await env.KEYS_DB.exec("DELETE FROM api_keys");
    await env.KEYS_DB.prepare(
      `INSERT INTO api_keys (api_key, key_id, name, enabled, scopes, retention_days, created_at)
       VALUES ('k1', 'short', 'a', 1, '["ingest"]', 21, 0), ('k2', 'forever', 'b', 1, '["ingest"]', 0, 0)`,
    ).run();
  });

  function setup(mode: string, over: Partial<RetentionDeps> & { token?: string } = {}) {
    const s = memStore();
    const { meta } = seedTable(s, CUTOFF);
    const { catalog, commits } = fakeCatalog(meta);
    const emitted: string[] = [];
    const deps: RetentionDeps = {
      now: () => NOW,
      emit: async (l) => void emitted.push(...l),
      catalog,
      store: s.store,
      oldestByKey: async () =>
        new Map([
          ["short", { ingest: new Date("2026-11-02T00:00:00Z"), ts: new Date("2026-11-01T23:00:00Z") }], // 29.5 days: past its 21
          // Inside the 30-day default by ingest time, though its event ts is a year old.
          ["forever", { ingest: new Date("2026-11-05T00:00:00Z"), ts: new Date("2025-10-22T21:00:00Z") }],
        ]),
      ...over,
    };
    const e = { KEYS_DB: env.KEYS_DB, BASIN_RETENTION_MODE: mode, BASIN_RETENTION_DEFAULT_DAYS: "30", BASIN_CATALOG_TOKEN: over.token };
    return { run: () => runBasinRetention(e, deps), commits, emitted };
  }

  it("is off unless a mode is set", async () => {
    const h = setup("");
    expect(await h.run()).toEqual({ mode: "off", skipped: "off" });
    expect(h.emitted).toEqual([]);
  });

  it("skips while another run holds the lease", async () => {
    await acquireLease(env.KEYS_DB, "basin-retention", "other", NOW.getTime(), 60_000);
    const h = setup("dry-run");
    expect(await h.run()).toEqual({ mode: "dry-run", skipped: "lease-held" });
  });

  it("releases its lease, so the next run goes ahead", async () => {
    await setup("dry-run").run();
    expect((await setup("dry-run").run()).skipped).toBeUndefined();
  });

  it("dry run plans against the longest window, reports, and commits nothing", async () => {
    const h = setup("dry-run");
    const run = await h.run();
    expect(run).toMatchObject({ mode: "dry-run", cutoff: "2026-11-01", longestWindowDays: 30, defaultWindowDays: 30, oldestIngestAgeDays: 29, oldestTs: "2025-10-22T21:00:00.000Z", overdue: false });
    expect(run.drop).toMatchObject({ files: 3, records: 170 });
    expect(run.drop?.snapshotId).toBeUndefined();
    expect(run.keysPastOwnWindow).toEqual([{ keyId: "short", windowDays: 21, oldest: "2026-11-02T00:00:00.000Z", ageDays: 29 }]);
    expect(h.commits).toEqual([]);
    expect(h.emitted).toHaveLength(1);
    const clef = JSON.parse(h.emitted[0]);
    expect(clef).toMatchObject({ "@l": "Information", Mode: "dry-run", Files: 3, Records: 170, Partitions: 3, FirstPartition: "2026-10-29", KeysPastOwnWindow: 1 });
    expect(clef["@mt"]).toMatch(/would drop/);
  });

  it("delete mode without the catalog token deletes nothing and reports an error", async () => {
    const h = setup("delete");
    const run = await h.run();
    expect(run.error).toMatch(/BASIN_CATALOG_TOKEN/);
    expect(run.drop?.files).toBe(3);
    expect(h.commits).toEqual([]);
    expect(JSON.parse(h.emitted[0])["@l"]).toBe("Warning");
  });

  it("delete mode with the token commits", async () => {
    const h = setup("delete", { token: "t" });
    const run = await h.run();
    expect(run.error).toBeUndefined();
    expect(run.drop?.snapshotId).toMatch(/^\d+$/);
    expect(h.commits).toHaveLength(1);
    expect(JSON.parse(h.emitted[0])["@mt"]).toMatch(/^Basin retention dropped/);
  });

  it("flags rows older than the longest window plus the grace as overdue", async () => {
    const old = new Date("2026-10-29T00:00:00Z");
    const h = setup("dry-run", { oldestByKey: async () => new Map([["forever", { ingest: old, ts: old }]]) });
    const run = await h.run();
    expect(run).toMatchObject({ oldestIngestAgeDays: 33, overdue: true });
    expect(JSON.parse(h.emitted[0])["@l"]).toBe("Warning");
  });

  it("still reports the oldest rows when the catalog fails", async () => {
    const h = setup("dry-run", {
      catalog: {
        loadTable: async () => {
          throw new CatalogError(503, "catalog GET: 503");
        },
        commit: async () => {},
      },
    });
    const run = await h.run();
    expect(run.error).toMatch(/503/);
    expect(run.oldestIngest).toBe("2026-11-02T00:00:00.000Z");
    expect(h.emitted).toHaveLength(1);
  });
});

describe("retentionSummaryCLEF", () => {
  it("stays small and cuts a long error", () => {
    const line = retentionSummaryCLEF({ mode: "dry-run", error: "x".repeat(5000) }, NOW);
    expect(line.length).toBeLessThan(2000);
  });
});
