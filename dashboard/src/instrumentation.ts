// Next.js instrumentation hook. With a `src/` directory, Next.js loads this
// file from `src/instrumentation.ts` (root `instrumentation.ts` otherwise)
// and calls `register()` once when the server process starts — for every
// runtime (Node.js, Edge) and, in dev, on every rebuild. See:
// https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
//
// This is the only startup hook Next.js provides, so it's where we
// re-populate `logs.key_policies` in ClickHouse from the D1 key registry.
// Task 9 wired `retention-worker` to read that table instead of the frozen
// `logs.api_keys`, but the table is otherwise only written by the key
// mutation routes (POST/PATCH/DELETE) — a fresh deploy would boot with an
// empty projection and silently stop trimming every existing source until a
// human happened to edit a key. Running the sync here on every server start
// means every deploy re-populates the projection unconditionally.
export async function register() {
  // instrumentation.ts runs under every Next.js runtime, but syncKeyPolicies
  // depends on Node APIs (fetch to ClickHouse + the D1 admin key flow via
  // listKeys) that only make sense in the Node.js server runtime. Skip Edge
  // and any other invocation so this never runs during static generation or
  // the edge runtime.
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  const { syncKeyPolicies } = await import('./lib/key-policies');

  // syncKeyPolicies() calls listKeys(), which throws if LOG_CANNON_ADMIN_KEY
  // is unset or the ingest Worker is unreachable. A dashboard that refuses
  // to boot because the retention projection couldn't sync would be a worse
  // failure than a stale projection, so this must never throw past register().
  let lastSyncedCount: number | null = null;
  try {
    lastSyncedCount = await syncKeyPolicies();
    console.log(`[instrumentation] Synced logs.key_policies on startup: ${lastSyncedCount} source(s).`);
  } catch (error) {
    console.error(
      '[instrumentation] Failed to sync logs.key_policies on startup — retention-worker may be trimming a stale or empty projection until the next successful key mutation or restart:',
      error
    );
  }

  // The mutation hooks (POST/PATCH/DELETE on /v1/keys) keep the projection
  // fresh for changes made through the dashboard, but the Worker's own admin
  // API (workers/packages/ingest/src/admin.ts) can't reach ClickHouse by
  // design — it only writes D1. So a retention change made directly against
  // the Worker's /v1/keys (which README.md documents as a supported path)
  // never reaches logs.key_policies until the dashboard happens to restart
  // or perform its own mutation. A periodic timer closes that gap.
  //
  // 15 minutes: retention-worker's own pass is governed by
  // RETENTION_INTERVAL_HOURS (default 24h), so there's no value in syncing
  // faster than roughly "well within a day." 15 minutes keeps drift small
  // relative to that window without adding meaningful load — listKeys() is a
  // single Worker fetch and the ClickHouse write is a handful of small
  // inserts/deletes against a table with, at most, low hundreds of rows.
  const SYNC_INTERVAL_MS = 15 * 60 * 1000;

  let syncInFlight = false;
  const interval = setInterval(() => {
    if (syncInFlight) {
      // Previous tick's sync is still running (slow ClickHouse/Worker) —
      // skip this tick rather than stacking overlapping syncs.
      return;
    }
    syncInFlight = true;
    syncKeyPolicies()
      .then((count) => {
        // Only log on failure or when the synced source count changes, so
        // this doesn't spam the logs every 15 minutes in the steady state.
        if (count !== lastSyncedCount) {
          console.log(
            `[instrumentation] Periodic sync of logs.key_policies: ${count} source(s) (was ${lastSyncedCount ?? 'unknown'}).`
          );
          lastSyncedCount = count;
        }
      })
      .catch((error) => {
        // Never let this reach the interval callback as a throw/unhandled
        // rejection — that can crash the Node process.
        console.error('[instrumentation] Periodic sync of logs.key_policies failed:', error);
      })
      .finally(() => {
        syncInFlight = false;
      });
  }, SYNC_INTERVAL_MS);

  // Don't let this timer hold the process open on shutdown. Node.js only;
  // guard defensively in case of a non-Node timer implementation.
  interval.unref?.();
}
