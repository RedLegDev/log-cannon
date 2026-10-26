// Basin spill replay (refs #166): oldest first, delete only after every row is
// sent, stop on a failed send, the lease, the per-tick bound and deadline, and
// the summary row the backlog alert reads.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLease } from "../src/alerts/store";
import { SPILL_PREFIX, gunzipRows, gzipRows, copyTiming, writeCopy, type LogStream } from "../src/basin";
import { TICK_DEADLINE_MS, replaySummaryCLEF, runBasinSpillReplay, type ReplayDeps } from "../src/basin-spill";
import type { LogRow } from "../src/parse/row";
import { scheduled } from "../src/index";

const NOW = new Date("2026-10-23T16:00:00.000Z");
const bucket = () => env.BASIN_SPILL;

function row(id: string, pad = 0): LogRow {
  return {
    id,
    ts: "2026-10-23T15:30:00.000Z",
    received_at: "2026-10-23T15:30:00.000Z",
    source: "example-app",
    key_id: "key-1",
    format: "clef",
    kind: "log",
    level: "Information",
    message: pad ? "z".repeat(pad) : id,
    message_template: "",
    event_type: "",
    exception: "",
    trace_id: null,
    span_id: null,
    parent_span_id: null,
    duration_ms: null,
    properties: {},
  };
}

async function putSpill(at: string, rows: LogRow[], name = crypto.randomUUID()): Promise<string> {
  const key = `${SPILL_PREFIX}${at}/${name}.ndjson.gz`;
  await bucket().put(key, await gzipRows(rows));
  return key;
}

async function keys(): Promise<string[]> {
  return (await bucket().list({ prefix: SPILL_PREFIX })).objects.map((o) => o.key);
}

function stream(fail: (attempt: number) => boolean = () => false) {
  const sent: LogRow[][] = [];
  let attempts = 0;
  const s: LogStream = {
    send: async (rows) => {
      if (fail(attempts++)) throw new Error("CF_SB_EDGE_INGEST_ERROR: 10037");
      sent.push(rows);
    },
  };
  return { s, sent, attempts: () => attempts };
}

function setup(s: LogStream, over: Partial<ReplayDeps> = {}) {
  const emitted: string[] = [];
  const e = { KEYS_DB: env.KEYS_DB, LOGS: s, BASIN_WRITE: "true", BASIN_SPILL: bucket() };
  const deps: ReplayDeps = { now: () => NOW, emit: async (l) => void emitted.push(...l), ...over };
  return { run: () => runBasinSpillReplay(e, deps), env: e, deps, emitted };
}

beforeEach(async () => {
  const { objects } = await bucket().list();
  if (objects.length) await bucket().delete(objects.map((o) => o.key));
  await env.KEYS_DB.exec("DELETE FROM cron_leases");
});

describe("runBasinSpillReplay", () => {
  it("sends an object's rows, then deletes it, and reports", async () => {
    await putSpill("2026-10-23T15:30:00.000Z", [row("a"), row("b")]);
    const { s, sent } = stream();
    const h = setup(s);
    const tick = await h.run();
    expect(tick).toMatchObject({ replayed: 2, objects: 1, backlog: 0, oldestAgeSeconds: 0 });
    expect(sent.flat().map((r) => r.id)).toEqual(["a", "b"]);
    expect(await keys()).toEqual([]);
    expect(JSON.parse(h.emitted[0])).toMatchObject({ "@l": "Information", Replayed: 2, Objects: 1, Backlog: 0 });
  });

  it("leaves the object, stops the tick and reports when the send fails", async () => {
    const k1 = await putSpill("2026-10-23T15:20:00.000Z", [row("a")]);
    const k2 = await putSpill("2026-10-23T15:21:00.000Z", [row("b")]);
    const { s, attempts } = stream(() => true);
    const h = setup(s);
    const tick = await h.run();
    expect(attempts()).toBe(1); // no retry, and the second object not tried
    expect(tick).toMatchObject({ replayed: 0, objects: 0, backlog: 2, oldestAgeSeconds: 40 * 60, error: "CF_SB_EDGE_INGEST_ERROR: 10037" });
    expect(await keys()).toEqual([k1, k2]);
    expect(JSON.parse(h.emitted[0])).toMatchObject({ "@l": "Warning", Backlog: 2, OldestAgeSeconds: 2400 });
  });

  it("replays oldest first", async () => {
    await putSpill("2026-10-23T15:40:00.000Z", [row("newer")], "a");
    await putSpill("2026-10-23T15:10:00.000Z", [row("older")], "z");
    await putSpill("2026-10-23T15:25:00.000Z", [row("middle")], "m");
    const { s, sent } = stream();
    await setup(s).run();
    expect(sent.map((b) => b[0].id)).toEqual(["older", "middle", "newer"]);
  });

  it("skips while another tick holds the lease", async () => {
    await putSpill("2026-10-23T15:30:00.000Z", [row("a")]);
    await acquireLease(env.KEYS_DB, "basin-spill-replay", "other", NOW.getTime(), 60_000);
    const { s, attempts } = stream();
    const h = setup(s);
    expect(await h.run()).toMatchObject({ skipped: "lease-held" });
    expect(attempts()).toBe(0);
    expect(await keys()).toHaveLength(1);
    expect(h.emitted).toEqual([]);
  });

  it("releases its lease, so the next tick runs", async () => {
    const { s } = stream();
    await setup(s).run();
    expect(await acquireLease(env.KEYS_DB, "basin-spill-replay", "next", NOW.getTime(), 60_000)).toBe(true);
  });

  it("replays at most maxObjects per tick and counts the rest as backlog", async () => {
    for (let i = 0; i < 5; i++) await putSpill(`2026-10-23T15:5${i}:00.000Z`, [row(`r${i}`)]);
    const { s, sent } = stream();
    const tick = await setup(s, { limits: { maxObjects: 2 } }).run();
    expect(tick).toMatchObject({ replayed: 2, objects: 2, backlog: 3, oldestAgeSeconds: 8 * 60 });
    expect(sent.flat().map((r) => r.id)).toEqual(["r0", "r1"]);
    expect(await keys()).toHaveLength(3);
  });

  it("starts no object past the deadline", async () => {
    await putSpill("2026-10-23T15:50:00.000Z", [row("a")]);
    await putSpill("2026-10-23T15:51:00.000Z", [row("b")]);
    let t = 0;
    const { s, sent } = stream();
    // started at 0; after the first object the clock reads past the deadline.
    const h = setup({ send: async (r) => { await s.send(r); t = TICK_DEADLINE_MS; } }, { clock: () => t });
    const tick = await h.run();
    expect(tick).toMatchObject({ objects: 1, backlog: 1 });
    expect(sent.flat().map((r) => r.id)).toEqual(["a"]);
  });

  it("at the deadline inside an object, rewrites it as the unsent remainder", async () => {
    // Two rows over half the send cap each: two batches.
    const key = await putSpill("2026-10-23T15:50:00.000Z", [row("a", 900_000), row("b", 900_000)]);
    let t = 0;
    const { s, sent } = stream();
    const tick = await setup({ send: async (r) => { await s.send(r); t = TICK_DEADLINE_MS; } }, { clock: () => t }).run();
    expect(tick).toMatchObject({ replayed: 1, objects: 0, backlog: 1 });
    expect(tick.error).toBeUndefined();
    expect(sent.flat().map((r) => r.id)).toEqual(["a"]);
    expect((await gunzipRows((await bucket().get(key))!.body)).map((r) => r.id)).toEqual(["b"]);
  });

  it("a send failing part-way through an object keeps only the unsent rows", async () => {
    const key = await putSpill("2026-10-23T15:50:00.000Z", [row("a", 900_000), row("b", 900_000)]);
    const { s, sent } = stream((n) => n === 1);
    const tick = await setup(s).run();
    expect(tick).toMatchObject({ replayed: 1, objects: 0, backlog: 1, error: "CF_SB_EDGE_INGEST_ERROR: 10037" });
    expect(sent.flat().map((r) => r.id)).toEqual(["a"]);
    expect((await gunzipRows((await bucket().get(key))!.body)).map((r) => r.id)).toEqual(["b"]);
  });

  it("leaves an unreadable object for a person and carries on", async () => {
    const bad = `${SPILL_PREFIX}2026-10-23T15:00:00.000Z/bad.ndjson.gz`;
    await bucket().put(bad, "not gzip");
    await putSpill("2026-10-23T15:10:00.000Z", [row("a")]);
    const { s, sent } = stream();
    const h = setup(s);
    const tick = await h.run();
    expect(tick).toMatchObject({ replayed: 1, objects: 1, backlog: 1, unreadable: 1, oldestAgeSeconds: 3600 });
    expect(sent.flat().map((r) => r.id)).toEqual(["a"]);
    expect(await keys()).toEqual([bad]);
    expect(JSON.parse(h.emitted[0])).toMatchObject({ "@l": "Warning", Unreadable: 1 });
  });

  it("is idle and silent with nothing spilled", async () => {
    const { s } = stream();
    const h = setup(s);
    expect(await h.run()).toMatchObject({ replayed: 0, objects: 0, backlog: 0 });
    expect(h.emitted).toEqual([]);
  });

  it("is off while BASIN_WRITE is off or the bucket is unbound", async () => {
    await putSpill("2026-10-23T15:30:00.000Z", [row("a")]);
    const { s, attempts } = stream();
    const deps = { now: () => NOW, emit: async () => {} };
    expect(await runBasinSpillReplay({ KEYS_DB: env.KEYS_DB, LOGS: s, BASIN_WRITE: "false", BASIN_SPILL: bucket() }, deps)).toMatchObject({ skipped: "off" });
    expect(await runBasinSpillReplay({ KEYS_DB: env.KEYS_DB, LOGS: s, BASIN_WRITE: "true" }, deps)).toMatchObject({ skipped: "off" });
    expect(attempts()).toBe(0);
    expect(await keys()).toHaveLength(1);
  });
});

describe("spill then replay", () => {
  const realSleep = copyTiming.sleep;
  beforeEach(() => void (copyTiming.sleep = async () => {}));
  afterEach(() => void (copyTiming.sleep = realSleep));

  it("a spilled-and-replayed row keeps its id", async () => {
    const down = stream(() => true);
    const tried: string[] = [];
    const copy = {
      format: "clef" as const,
      bodies: [new TextEncoder().encode('{"@t":"2026-10-23T15:30:00Z","@m":"one"}\n{"@t":"2026-10-23T15:30:01Z","@m":"two"}\n')],
      contentType: "application/vnd.serilog.clef",
      source: "example-app",
      keyId: "key-1",
      receivedAt: new Date("2026-10-23T15:30:02.000Z"),
    };
    await writeCopy({ send: async (r) => { tried.push(...r.map((x) => x.id)); await down.s.send(r); } }, copy, { spill: bucket() }).catch(() => {});
    const up = stream();
    await setup(up.s).run();
    const replayed = up.sent.flat();
    expect(replayed.map((r) => r.id)).toEqual(tried.slice(0, 2));
    expect(replayed.map((r) => r.message)).toEqual(["one", "two"]);
    expect(replayed[0].received_at).toBe("2026-10-23T15:30:02.000Z");
    expect(await keys()).toEqual([]);
  });
});

describe("replaySummaryCLEF", () => {
  it("stays under 2,000 bytes with a huge error and counts", () => {
    const line = replaySummaryCLEF(
      { replayed: 1e12, objects: 1e9, backlog: 1e9, backlogTruncated: true, oldestAgeSeconds: 1e9, unreadable: 1e9, error: "x".repeat(50_000) },
      NOW,
    );
    expect(new TextEncoder().encode(line).byteLength).toBeLessThan(2000);
  });

  it("is a Warning only past 30 minutes of backlog age", () => {
    const t = { replayed: 0, objects: 0, backlog: 1 };
    expect(JSON.parse(replaySummaryCLEF({ ...t, oldestAgeSeconds: 1800 }, NOW))["@l"]).toBe("Information");
    expect(JSON.parse(replaySummaryCLEF({ ...t, oldestAgeSeconds: 1801 }, NOW))["@l"]).toBe("Warning");
  });
});

describe("scheduled", () => {
  it("runs the replay alongside the other ticks and reports through telemetry", async () => {
    await putSpill("2026-10-23T15:30:00.000Z", [row("a")]);
    const { s, sent } = stream();
    const queued: unknown[] = [];
    await scheduled({ ...env, LOGS: s, BASIN_WRITE: "true", BASIN_SPILL: bucket(), INGEST_QUEUE: { send: async (m: unknown) => void queued.push(m) } } as never);
    // The replayed row, then the summary's own Basin copy.
    expect(sent.flat().map((r) => r.id)[0]).toBe("a");
    expect(sent.flat()[1].message_template).toMatch(/^Basin spill replay sent/);
    expect(await keys()).toEqual([]);
    expect(queued).toHaveLength(1);
  });
});
