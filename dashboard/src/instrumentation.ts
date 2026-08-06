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

  // syncKeyPolicies() calls listKeys(), which throws if LOG_CANNON_ADMIN_KEY
  // is unset or the ingest Worker is unreachable. A dashboard that refuses
  // to boot because the retention projection couldn't sync would be a worse
  // failure than a stale projection, so this must never throw past register().
  try {
    const { syncKeyPolicies } = await import('./lib/key-policies');
    const count = await syncKeyPolicies();
    console.log(`[instrumentation] Synced logs.key_policies on startup: ${count} source(s).`);
  } catch (error) {
    console.error(
      '[instrumentation] Failed to sync logs.key_policies on startup — retention-worker may be trimming a stale or empty projection until the next successful key mutation or restart:',
      error
    );
  }
}
