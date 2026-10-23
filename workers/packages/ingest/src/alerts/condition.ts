// Alert conditions (refs #165): a port of alert-worker's evaluateCondition,
// quirks included, so a condition that fires in v1 fires here.
//
// Grammar: `col OP number`, joined by `&&` / `||`. `&&` is split first, then
// `||`, each at its first occurrence, with no precedence or parentheses beyond
// that. Operators are tried in the order >=, <=, !=, ==, >, <. A missing or
// non-numeric column, or a right-hand side that isn't a number, is an error,
// and an error never fires an alert.

export class ConditionError extends Error {
  override name = "ConditionError";
}

const OPERATORS = [">=", "<=", "!=", "==", ">", "<"] as const;

export function evaluateCondition(condition: string, row: Record<string, unknown>): boolean {
  const c = condition.trim();

  for (const joiner of ["&&", "||"] as const) {
    const at = c.indexOf(joiner);
    if (at === -1) continue;
    const left = evaluateCondition(c.slice(0, at), row);
    const right = evaluateCondition(c.slice(at + joiner.length), row);
    return joiner === "&&" ? left && right : left || right;
  }

  for (const op of OPERATORS) {
    const at = c.indexOf(op);
    if (at === -1) continue;
    const name = c.slice(0, at).trim();
    const rhs = c.slice(at + op.length).trim();
    if (!Object.hasOwn(row, name)) throw new ConditionError(`variable ${name} not found in result`);
    const value = toNumber(row[name]);
    if (value === null) {
      throw new ConditionError(`cannot convert ${name} (${JSON.stringify(row[name])}) to number`);
    }
    const target = parseFloatStrict(rhs);
    if (target === null) throw new ConditionError(`cannot parse comparison value: ${rhs}`);
    switch (op) {
      case ">=":
        return value >= target;
      case "<=":
        return value <= target;
      case "!=":
        return value !== target;
      case "==":
        return value === target;
      case ">":
        return value > target;
      case "<":
        return value < target;
    }
  }

  throw new ConditionError(`could not parse condition: ${c}`);
}

/**
 * Basin returns JSON, where a 64-bit count may arrive as a number or, past
 * 2^53, as a string. Either counts as numeric; anything else (bool, null,
 * text) is the error v1 gave for a non-numeric column.
 */
function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return parseFloatStrict(v);
  return null;
}

/** Go's strconv.ParseFloat for the inputs conditions use: a whole decimal literal, nothing trailing. */
function parseFloatStrict(s: string): number | null {
  const t = s.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  return Number(t);
}
