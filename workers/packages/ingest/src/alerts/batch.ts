// Batched alert queries (refs #194). Basin bills every SQL query at least
// 10 MB, and a typical alert query reads about 1.4 MB, so one query per alert
// pays mostly for the minimum. A tick's due alerts are instead combined into
// one query per batch: each alert's own single-row query becomes a derived
// table, the derived tables are CROSS JOINed, and every output column gets a
// positional key (`m<member>_<column>`) that is mapped back to the alert's own
// column name afterwards, so the condition sees exactly the row it would see
// from the alert's query run alone.
//
// That needs each alert's output column names up front. They are read from
// the query's top-level SELECT list, and only a query whose every item ends in
// an explicit `AS name` is batched. Anything else (`*`, an unnamed item, a
// top-level GROUP BY or set operation that may return other than one row,
// comments, a leading WITH) runs alone, as it always has. Basin keeps
// identifier case (ident normalization is off), so `AS Cnt` names the column
// `Cnt`, and the composed query refers to it as `"Cnt"`.

export interface BatchMember {
  /** SQL that returns exactly one row: the alert query with now() pinned. */
  sql: string;
  /** Its output column names, in order. */
  columns: string[];
}

/**
 * The query with its top-level text separated from string literals and quoted
 * identifiers, so keyword and punctuation scans never look inside a literal.
 * Returns null on an unterminated quote.
 */
function scan(sql: string): { depthAt: number[]; masked: string } | null {
  // `masked` is the SQL with every quoted span replaced by spaces of the same
  // length; `depthAt[i]` is the paren depth at character i.
  const out: string[] = [];
  const depthAt: number[] = [];
  let depth = 0;
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) return null;
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      for (let k = i; k <= j; k++) {
        out.push(" ");
        depthAt.push(depth);
      }
      i = j + 1;
      continue;
    }
    if (c === "(") depth++;
    out.push(c);
    depthAt.push(depth);
    if (c === ")") depth--;
    i++;
  }
  if (depth !== 0) return null;
  return { depthAt, masked: out.join("") };
}

/** Index of each top-level (depth 0) match of `re` in the masked text. */
function topLevel(masked: string, depthAt: number[], re: RegExp): number[] {
  const hits: number[] = [];
  for (const m of masked.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))) {
    if (depthAt[m.index] === 0) hits.push(m.index);
  }
  return hits;
}

/** The query without surrounding whitespace and trailing semicolons. */
export function trimQuery(sql: string): string {
  return sql.trim().replace(/[\s;]+$/, "");
}

/**
 * The output column names of a single-row alert query, or null when the query
 * can't be batched safely and should run alone.
 */
export function selectColumns(query: string): string[] | null {
  const sql = trimQuery(query);
  const s = scan(sql);
  if (!s) return null;
  const { masked, depthAt } = s;
  // Comments and a second statement would end up inside a derived table.
  if (/--|\/\*|;/.test(masked)) return null;
  const head = /^SELECT\s+/i.exec(masked);
  if (!head) return null;
  if (/^(DISTINCT|ALL)\b/i.test(masked.slice(head[0].length))) return null;
  // Anything at the top level that can make the result other than one row.
  if (topLevel(masked, depthAt, /\b(UNION|INTERSECT|EXCEPT|GROUP\s+BY|HAVING|LIMIT|OFFSET)\b/i).length) return null;
  const from = topLevel(masked, depthAt, /\bFROM\b/i)[0] ?? masked.length;
  const start = head[0].length;

  const items: string[] = [];
  let at = start;
  for (const comma of topLevel(masked.slice(0, from), depthAt, /,/)) {
    if (comma < start) continue;
    items.push(sql.slice(at, comma));
    at = comma + 1;
  }
  items.push(sql.slice(at, from));

  const columns: string[] = [];
  for (const item of items) {
    // A bare column (`SELECT started, …` over a subquery) is named after itself.
    const bare = /^\s*("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(item);
    const m = bare ?? /\bAS\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(item);
    if (!m) return null;
    if (!bare) {
      // The alias must be top level in the item, not the tail of a quoted span.
      const masks = scan(item);
      if (!masks || masks.depthAt[m.index] !== 0 || !/^AS\b/i.test(masks.masked.slice(m.index))) return null;
    }
    const name = m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1];
    if (!name) return null;
    columns.push(name);
  }
  if (!columns.length || new Set(columns).size !== columns.length) return null;
  return columns;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The output key for member `m`'s column `c` in a batched row. */
export function batchKey(m: number, c: number): string {
  return `m${m}_${c}`;
}

/** One query that returns every member's row side by side, in one row. */
export function composeBatch(members: BatchMember[]): string {
  if (!members.length) throw new Error("composeBatch needs at least one member");
  const select = members.flatMap((m, i) => m.columns.map((col, j) => `t${i}.${quoteIdent(col)} AS "${batchKey(i, j)}"`));
  const from = members.map((m, i) => `(${trimQuery(m.sql)}) t${i}`).join(" CROSS JOIN ");
  return `SELECT ${select.join(", ")} FROM ${from}`;
}

/**
 * Each member's own row, keyed by its own column names, from a batched result.
 * Throws when the result isn't exactly one row holding every key, which the
 * caller treats as a failed batch.
 */
export function splitBatch(rows: Record<string, unknown>[], members: BatchMember[]): Record<string, unknown>[] {
  if (rows.length !== 1) throw new Error(`batched query returned ${rows.length} rows`);
  const row = rows[0];
  return members.map((m, i) => {
    const own: Record<string, unknown> = {};
    m.columns.forEach((col, j) => {
      const key = batchKey(i, j);
      if (!Object.hasOwn(row, key)) throw new Error(`batched query is missing ${key}`);
      own[col] = row[key];
    });
    return own;
  });
}

/** Split `items` into consecutive chunks of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
