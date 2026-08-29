/**
 * Values safe to splice unquoted into ClickHouse SQL.
 *
 * Rejects strings (even numeric-looking), floats, NaN, and Infinity.
 * Do NOT coerce with Number(x) — Number("60; DROP…") === 60 and would
 * pass a subsequent Number.isInteger check after coercion.
 */
export function isSqlInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

export function requireSqlInteger(value: unknown, field: string): number {
  if (!isSqlInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  return value;
}

/** Omit/null → default. Present but non-integer → null (caller returns 400). */
export function optionalSqlInteger(
  value: unknown,
  defaultValue: number
): number | null {
  if (value === undefined || value === null) return defaultValue;
  if (!isSqlInteger(value)) return null;
  return value;
}
