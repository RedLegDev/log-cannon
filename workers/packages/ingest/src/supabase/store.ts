// D1 state for the Supabase pull (refs #164): per-table cursors and the ids
// sent within the overlap. See migrations/0003_supabase_pull.sql.

export interface CursorState {
  /** Newest row sent to Basin, or null before the first. */
  cursorTs: number | null;
  cursorId: string | null;
  /** How far the table has been read with nothing left behind. */
  readTo: number | null;
}

export async function getCursor(db: D1Database, ref: string, table: string): Promise<CursorState> {
  const row = await db
    .prepare("SELECT cursor_ts, cursor_id, read_to FROM supabase_pull_cursor WHERE ref = ? AND log_table = ?")
    .bind(ref, table)
    .first<{ cursor_ts: number | null; cursor_id: string | null; read_to: number | null }>();
  return { cursorTs: row?.cursor_ts ?? null, cursorId: row?.cursor_id ?? null, readTo: row?.read_to ?? null };
}

export async function loadSeen(db: D1Database, ref: string, table: string, sinceUs: number): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT sb_id FROM supabase_pull_seen WHERE ref = ? AND log_table = ? AND ts >= ?")
    .bind(ref, table, sinceUs)
    .all<{ sb_id: string }>();
  return new Set(results.map((r) => r.sb_id));
}

/** D1 caps a statement at 100 bound parameters; four per seen row. */
const SEEN_ROWS_PER_INSERT = 25;

/**
 * Record a page that Basin accepted: its ids and the table's new position, in
 * one batch so the cursor can't move without the ids that let the next
 * overlap skip them.
 */
export async function commitPage(
  db: D1Database,
  ref: string,
  table: string,
  sent: { id: string; tsUs: number }[],
  state: CursorState,
  now: Date,
): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < sent.length; i += SEEN_ROWS_PER_INSERT) {
    const chunk = sent.slice(i, i + SEEN_ROWS_PER_INSERT);
    stmts.push(
      db
        .prepare(`INSERT OR IGNORE INTO supabase_pull_seen (ref, log_table, sb_id, ts) VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(", ")}`)
        .bind(...chunk.flatMap((r) => [ref, table, r.id, r.tsUs])),
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO supabase_pull_cursor (ref, log_table, cursor_ts, cursor_id, read_to, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(ref, log_table) DO UPDATE SET cursor_ts = excluded.cursor_ts, cursor_id = excluded.cursor_id,
           read_to = excluded.read_to, updated_at = excluded.updated_at`,
      )
      .bind(ref, table, state.cursorTs, state.cursorId, state.readTo, now.toISOString()),
  );
  await db.batch(stmts);
}

export async function pruneSeen(db: D1Database, ref: string, table: string, beforeUs: number): Promise<void> {
  await db.prepare("DELETE FROM supabase_pull_seen WHERE ref = ? AND log_table = ? AND ts < ?").bind(ref, table, beforeUs).run();
}
