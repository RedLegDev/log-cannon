import type { LogRow, ParseContext } from "../../src/parse/row";

/** The parser's clock in every test. Later than every fixture timestamp, so
 * only deliberately-future events clamp. */
export const RECEIVED_AT = new Date("2026-10-22T00:00:00.000Z");

export function ctx(source = "svc", enrich?: Record<string, string>): ParseContext {
  return { source, keyId: "key-1", receivedAt: RECEIVED_AT, enrich };
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function base64Bytes(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Invariants every row holds regardless of format. */
export function expectRowShape(row: LogRow, expect: (v: unknown) => any): void {
  expect(row.id).toMatch(UUID);
  expect(row.key_id).toBe("key-1");
  expect(row.received_at).toBe(RECEIVED_AT.toISOString());
  expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
}
