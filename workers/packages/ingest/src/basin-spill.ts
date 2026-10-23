// Basin spill replay (refs #166): a copy whose sends still fail after their
// retries spills its unsent rows to the `BASIN_SPILL` bucket (`writeCopy` in
// basin.ts). This tick, on the once-a-minute cron, sends them on.
//
// Oldest object first. An object is deleted only after every row in it was
// sent. A failed send ends the tick and leaves the rest for the next one,
// because the stream is what's down; there is no hard retrying in here. If the
// object was part-sent, the unsent remainder replaces it, so the next tick
// doesn't send those rows again. Rows keep their `id`, so a duplicate (a send
// that failed after Basin took it) shows as count(*) > count(DISTINCT id).

import { acquireLease, releaseLease } from "./alerts/store";
import {
  SPILL_PREFIX,
  basinWriteEnabled,
  batchRows,
  gunzipRows,
  gzipRows,
  spillKeyTime,
  type LogStream,
} from "./basin";
import type { LogRow } from "./parse/row";

export interface SpillReplayEnv {
  KEYS_DB: D1Database;
  LOGS?: LogStream;
  BASIN_WRITE?: string;
  BASIN_SPILL?: R2Bucket;
}

export interface ReplayLimits {
  /** Objects replayed per tick at most; the rest wait for the next. */
  maxObjects: number;
  /** Keys listed per tick: the backlog count is capped here. */
  listLimit: number;
}

/** A spilled copy is at most one 32 MB request, so 20 is a few hundred MB of
 * NDJSON in the worst case and a few dozen sends in the usual one. */
export const DEFAULT_REPLAY_LIMITS: ReplayLimits = { maxObjects: 20, listLimit: 1000 };

const LEASE_NAME = "basin-spill-replay";
export const LEASE_TTL_MS = 5 * 60_000;
/** Stop starting objects, or batches within one, this long into a tick, so a
 * tick ends before the next cron fires and well inside the lease. */
export const TICK_DEADLINE_MS = 45_000;
/** The summary goes from Information to Warning past this backlog age. */
export const STALE_BACKLOG_SECONDS = 30 * 60;

export interface ReplayDeps {
  now: () => Date;
  /** Wall clock for the tick deadline; defaults to Date.now. */
  clock?: () => number;
  /** CLEF lines for the Worker's telemetry source. Never throws. */
  emit: (lines: string[]) => Promise<void>;
  limits?: Partial<ReplayLimits>;
}

export interface ReplayTick {
  skipped?: "off" | "lease-held";
  /** Rows sent this tick. */
  replayed: number;
  /** Objects fully sent and deleted this tick. */
  objects: number;
  /** Objects still waiting after the tick. */
  backlog: number;
  /** More keys exist than were listed, so `backlog` is a floor. */
  backlogTruncated?: boolean;
  /** Age of the oldest waiting object's rows (their received_at), 0 when none. */
  oldestAgeSeconds: number;
  /** Objects that couldn't be read back; left in place for a person. */
  unreadable?: number;
  /** The send failure that ended the tick. */
  error?: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runBasinSpillReplay(env: SpillReplayEnv, deps: ReplayDeps): Promise<ReplayTick> {
  const tick: ReplayTick = { replayed: 0, objects: 0, backlog: 0, oldestAgeSeconds: 0 };
  if (!basinWriteEnabled(env.BASIN_WRITE, env.LOGS) || !env.BASIN_SPILL) return { ...tick, skipped: "off" };
  const stream = env.LOGS;
  const bucket = env.BASIN_SPILL;
  const limits = { ...DEFAULT_REPLAY_LIMITS, ...deps.limits };
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const pastDeadline = () => clock() - started >= TICK_DEADLINE_MS;
  const holder = crypto.randomUUID();
  if (!(await acquireLease(env.KEYS_DB, LEASE_NAME, holder, deps.now().getTime(), LEASE_TTL_MS))) {
    return { ...tick, skipped: "lease-held" };
  }
  try {
    // One list per tick: it is a Class A operation, and the cron runs 43,200
    // times a month whether or not anything spilled.
    const listed = await bucket.list({ prefix: SPILL_PREFIX, limit: limits.listLimit });
    const waiting: string[] = [];
    let attempted = 0;
    for (const { key } of listed.objects) {
      if (tick.error !== undefined || attempted >= limits.maxObjects || pastDeadline()) {
        waiting.push(key);
        continue;
      }
      attempted++;
      const r = await replayObject(bucket, stream, key, pastDeadline);
      tick.replayed += r.sent;
      if (r.done) {
        tick.objects++;
        continue;
      }
      waiting.push(key);
      if (r.unreadable) tick.unreadable = (tick.unreadable ?? 0) + 1;
      else if (r.error !== undefined) tick.error = r.error;
      // Neither: stopped at the deadline with the remainder saved.
    }
    tick.backlog = waiting.length;
    if (listed.truncated) tick.backlogTruncated = true;
    const oldest = waiting.length ? spillKeyTime(waiting[0]) : NaN;
    if (Number.isFinite(oldest)) tick.oldestAgeSeconds = Math.max(0, Math.round((deps.now().getTime() - oldest) / 1000));
    if (tick.replayed || tick.objects || tick.backlog) await deps.emit([replaySummaryCLEF(tick, deps.now())]);
    return tick;
  } finally {
    await releaseLease(env.KEYS_DB, LEASE_NAME, holder).catch(() => {});
  }
}

interface ObjectResult {
  sent: number;
  done: boolean;
  unreadable?: boolean;
  error?: string;
}

async function replayObject(
  bucket: R2Bucket,
  stream: LogStream,
  key: string,
  pastDeadline: () => boolean,
): Promise<ObjectResult> {
  const obj = await bucket.get(key);
  // Gone between the list and the get: another tick finished it.
  if (!obj) return { sent: 0, done: true };
  let rows: LogRow[];
  try {
    rows = await gunzipRows(obj.body);
  } catch (e) {
    console.error(JSON.stringify({ event: "basin-spill-unreadable", key, error: message(e) }));
    return { sent: 0, done: false, unreadable: true };
  }
  const batches = batchRows(rows);
  let sent = 0;
  for (let i = 0; i < batches.length; i++) {
    let error: string | undefined;
    if (i === 0 || !pastDeadline()) {
      try {
        await stream.send(batches[i]);
        sent += batches[i].length;
        continue;
      } catch (e) {
        error = message(e);
      }
    }
    // Stopping inside the object. Rewrite it as the unsent remainder so the
    // rows already sent aren't sent again; if that put fails, the original
    // stays and they are (duplicates, never losses).
    if (sent > 0) {
      await bucket
        .put(key, await gzipRows(batches.slice(i).flat()), {
          httpMetadata: { contentType: "application/x-ndjson" },
          customMetadata: { rows: String(rows.length - sent) },
        })
        .catch((e) => console.error(JSON.stringify({ event: "basin-spill-rewrite-failed", key, error: message(e) })));
    }
    return { sent, done: false, error };
  }
  await bucket.delete(key);
  return { sent, done: true };
}

/** One summary per tick that did work or saw a backlog, for the backlog alert.
 * Bounded: the error is cut, so the row stays well under Basin's 2,000-byte
 * `json_get` limit. */
export function replaySummaryCLEF(t: ReplayTick, at: Date): string {
  return JSON.stringify({
    "@t": at.toISOString(),
    "@l": t.oldestAgeSeconds > STALE_BACKLOG_SECONDS ? "Warning" : "Information",
    "@mt": "Basin spill replay sent {Replayed} rows from {Objects} objects; {Backlog} objects waiting, oldest {OldestAgeSeconds}s",
    Replayed: t.replayed,
    Objects: t.objects,
    Backlog: t.backlog,
    OldestAgeSeconds: t.oldestAgeSeconds,
    BacklogTruncated: t.backlogTruncated,
    Unreadable: t.unreadable,
    Error: t.error?.slice(0, 500),
  });
}
