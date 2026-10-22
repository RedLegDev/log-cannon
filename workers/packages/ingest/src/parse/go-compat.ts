/**
 * Go standard-library behaviour the parsers depend on, reproduced so v2 rows
 * render the same messages and event types the Go consumer did: MurmurHash3
 * event types, fmt's `%g`, encoding/json's output, strict RFC 3339 parsing and
 * strconv.ParseFloat. Checked against output from the Go code itself in
 * test/parse/golden.json.
 */

const utf8 = new TextEncoder();

/** MurmurHash3 x86 32-bit, seed 0 (github.com/twmb/murmur3 Sum32). */
export function murmur3_32(bytes: Uint8Array): number {
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  const n = bytes.length;
  const blocks = n & ~3;
  let h = 0;
  for (let i = 0; i < blocks; i += 4) {
    let k =
      bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  switch (n & 3) {
    case 3:
      k ^= bytes[blocks + 2] << 16;
    // falls through
    case 2:
      k ^= bytes[blocks + 1] << 8;
    // falls through
    case 1:
      k ^= bytes[blocks];
      k = Math.imul(k, c1);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, c2);
      h ^= k;
  }
  h ^= n;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** `0x` + 8 hex digits of the template's hash (the message's when there is no
 * template); "" when both are empty. Port of queue-consumer/hash.go. */
export function computeEventType(messageTemplate: string, message: string): string {
  const input = messageTemplate || message;
  if (!input) return "";
  return "0x" + murmur3_32(utf8.encode(input)).toString(16).padStart(8, "0");
}

/** fmt.Sprintf("%g", v) for a float64. */
export function goFormatG(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "+Inf";
  if (v === -Infinity) return "-Inf";
  if (v === 0) return Object.is(v, -0) ? "-0" : "0";
  const sign = v < 0 ? "-" : "";
  // toExponential() with no argument yields the shortest round-tripping
  // digits, which is what Go's %g (precision -1) uses too.
  const [mant, expStr] = Math.abs(v).toExponential().split("e");
  const digits = mant.replace(".", "");
  const exp = Number(expStr);
  // With shortest precision Go switches to %e when exp < -4 || exp >= 6.
  if (exp < -4 || exp >= 6) {
    const frac = digits.length > 1 ? "." + digits.slice(1) : "";
    const e = Math.abs(exp).toString().padStart(2, "0");
    return `${sign}${digits[0]}${frac}e${exp < 0 ? "-" : "+"}${e}`;
  }
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  if (digits.length <= exp + 1) return sign + digits + "0".repeat(exp + 1 - digits.length);
  return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
}

const INT64_MIN = -(2 ** 63);
const INT64_LIMIT = 2 ** 63;

/** How renderMessageTemplate prints a JSON number: `%d` when the float64 is
 * integral and survives an int64 round trip, `%g` otherwise. */
function formatTemplateNumber(v: number): string {
  if (Number.isInteger(v) && v >= INT64_MIN && v < INT64_LIMIT) {
    return BigInt(v).toString();
  }
  return goFormatG(v);
}

const HTML_UNSAFE = /[<>&\u2028\u2029]/g;

function goJSONString(s: string): string {
  // Go held U+FFFD where JS can hold a lone surrogate; toWellFormed matches it.
  const wellFormed = (s as { toWellFormed?: () => string }).toWellFormed?.() ?? s;
  return JSON.stringify(wellFormed).replace(
    HTML_UNSAFE,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/**
 * json.Marshal of a decoded JSON value: map keys sorted, `<`, `>`, `&`,
 * U+2028 and U+2029 escaped. Numbers already match (JSON.stringify and Go
 * switch to exponent form at the same thresholds), except -0. bigint is the
 * OTLP int64 case and prints its exact digits.
 */
export function goJSON(value: unknown): string {
  if (value === null || value === undefined) return "null";
  switch (typeof value) {
    case "string":
      return goJSONString(value);
    case "number":
      return Object.is(value, -0) ? "-0" : JSON.stringify(value);
    case "bigint":
      return value.toString();
    case "boolean":
      return value ? "true" : "false";
  }
  if (Array.isArray(value)) return "[" + value.map(goJSON).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => goJSONString(k) + ":" + goJSON(obj[k])).join(",") + "}";
}

/** One property value as renderMessageTemplate substitutes it. */
function templateValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return formatTemplateNumber(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v === null || v === undefined) return "null";
  return goJSON(v);
}

/** A rendered message stops growing past this many UTF-16 units. */
export const MAX_RENDERED_CHARS = 1 << 20;

const PLACEHOLDER = /\{([^{}]*)\}/g;

/**
 * Replace `{Key}` with that property's value. Port of clef.go
 * renderMessageTemplate (used by the webhook presets too), with two
 * deliberate differences:
 *
 * - One left-to-right pass over the template. Go ran strings.ReplaceAll once
 *   per property in random map order, so a value containing another `{Key}`
 *   was sometimes substituted again and sometimes not. Here a substituted value
 *   is never rescanned, which also keeps rendering linear in the template.
 * - Bounded output. A substitution that would push the message past
 *   MAX_RENDERED_CHARS is skipped and its placeholder left literal, so a small
 *   line with many placeholders and one large value can't render into hundreds
 *   of megabytes.
 *
 * Replacement is literal: `$&`, `$$` and friends in a value are just text.
 */
export function renderMessageTemplate(
  template: string,
  properties: Record<string, unknown>,
): string {
  if (!template) return "";
  const cache = new Map<string, string>();
  let out = "";
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    const key = m[1];
    if (!Object.hasOwn(properties, key)) continue;
    let rep = cache.get(key);
    if (rep === undefined) {
      rep = templateValue(properties[key]);
      cache.set(key, rep);
    }
    const literal = template.slice(last, m.index);
    out += literal;
    out += out.length + rep.length > MAX_RENDERED_CHARS ? m[0] : rep;
    last = m.index + m[0].length;
  }
  return out + template.slice(last);
}

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

function daysIn(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one. setUTCFullYear,
  // not Date.UTC, because Date.UTC maps years 0–99 to 1900–1999.
  const d = new Date(0);
  d.setUTCFullYear(year, month, 0);
  return d.getUTCDate();
}

/**
 * time.Parse(time.RFC3339Nano, s) → epoch ms, or null where Go errors.
 * Strict like Go: uppercase T and Z, two-digit fields, range-checked. Sub-ms
 * digits are truncated, which is how a Go time formats at ms precision.
 */
export function parseRFC3339(s: string): number | null {
  const m = RFC3339.exec(s);
  if (!m) return null;
  const [year, month, day, hour, min, sec] = m.slice(1, 7).map(Number);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysIn(year, month)) return null;
  if (hour > 23 || min > 59 || sec > 59) return null;
  let offsetMin = 0;
  if (m[8] !== "Z") {
    const oh = Number(m[10]);
    const om = Number(m[11]);
    if (oh > 23 || om > 59) return null;
    offsetMin = (m[9] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0;
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, min, sec, ms);
  return d.getTime() - offsetMin * 60_000;
}

const DECIMAL_FLOAT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** strconv.ParseFloat(s, 64), or null where Go returns an error (including
 * out-of-range). Hex-float and underscore forms are not supported. */
export function goParseFloat(s: string): number | null {
  if (/^[+-]?(?:inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  if (!DECIMAL_FLOAT.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/** time.Unix(0, ns) at ms precision (floor, as Go formatting truncates). */
export function nanosToMs(ns: bigint): number {
  const q = ns / 1_000_000n;
  return Number(ns % 1_000_000n < 0n ? q - 1n : q);
}

/** Go's int64(f) for a finite float: truncate toward zero. */
export function truncToBigInt(f: number): bigint {
  return BigInt(Math.trunc(f));
}
