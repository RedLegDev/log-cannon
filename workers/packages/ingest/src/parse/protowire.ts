/**
 * Minimal protobuf wire-format reader: just enough to decode the OTLP export
 * requests in otlp.ts. Hand-written because those messages are small and
 * stable, and a generated-code dependency would add more to the bundle than
 * this file does. Field numbers are checked against Go-encoded fixtures in
 * test/parse/golden.json.
 */

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LEN = 2;
export const WIRE_START_GROUP = 3;
export const WIRE_END_GROUP = 4;
export const WIRE_FIXED32 = 5;

/** Proto3 strings must be valid UTF-8; Go's proto.Unmarshal rejects them
 * otherwise. ignoreBOM keeps a leading U+FEFF as content, as Go does. */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class ProtoReader {
  pos: number;
  private readonly view: DataView;

  constructor(
    readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  done(): boolean {
    return this.pos >= this.end;
  }

  private need(n: number): void {
    if (this.pos + n > this.end) throw new Error("protobuf: unexpected end of data");
  }

  /** A varint as a 64-bit unsigned bigint. */
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      this.need(1);
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) return BigInt.asUintN(64, result);
      shift += 7n;
    }
    throw new Error("protobuf: varint overflow");
  }

  /** A varint known to be a small length or tag. */
  uint32(): number {
    let result = 0;
    for (let i = 0; i < 5; i++) {
      this.need(1);
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * 2 ** (7 * i);
      if (b < 0x80) return result;
    }
    // Longer encodings are legal for uint32 fields; the high bits are dropped.
    const big = (BigInt(result) | (this.varintTail() << 35n)) & 0xffffffffn;
    return Number(big);
  }

  private varintTail(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 5; i++) {
      this.need(1);
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) return result;
      shift += 7n;
    }
    throw new Error("protobuf: varint overflow");
  }

  int64(): bigint {
    return BigInt.asIntN(64, this.varint());
  }

  /** An int32/enum field: the varint truncated to 32 bits, signed. */
  int32(): number {
    return Number(BigInt.asIntN(32, this.varint()));
  }

  fixed64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }

  double(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** Bounds of a length-delimited field's payload; advances past it. */
  lengthDelimited(): [start: number, end: number] {
    const len = this.uint32();
    this.need(len);
    const start = this.pos;
    this.pos += len;
    return [start, start + len];
  }

  bytes(): Uint8Array {
    const [start, end] = this.lengthDelimited();
    return this.buf.subarray(start, end);
  }

  string(): string {
    try {
      return strictUtf8.decode(this.bytes());
    } catch {
      throw new Error("protobuf: string field contains invalid UTF-8");
    }
  }

  /** A sub-reader over an embedded message. */
  message(): ProtoReader {
    const [start, end] = this.lengthDelimited();
    return new ProtoReader(this.buf, start, end);
  }

  /** Skip a field we don't read, by wire type. */
  skip(wireType: number, fieldNumber: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_FIXED64:
        this.need(8);
        this.pos += 8;
        return;
      case WIRE_LEN:
        this.lengthDelimited();
        return;
      case WIRE_FIXED32:
        this.need(4);
        this.pos += 4;
        return;
      case WIRE_START_GROUP:
        for (;;) {
          const [f, wt] = this.tag();
          if (wt === WIRE_END_GROUP) {
            if (f !== fieldNumber) throw new Error("protobuf: mismatched end group");
            return;
          }
          this.skip(wt, f);
        }
      default:
        throw new Error(`protobuf: invalid wire type ${wireType}`);
    }
  }

  tag(): [fieldNumber: number, wireType: number] {
    const t = this.uint32();
    const field = Math.floor(t / 8);
    if (field === 0) throw new Error("protobuf: invalid field number 0");
    return [field, t & 7];
  }

  /**
   * Visit each field. The handler returns true when it consumed the field; a
   * field it doesn't recognise, or one with an unexpected wire type, is
   * skipped, which is how Go treats unknown fields.
   */
  fields(handler: (field: number, wireType: number) => boolean): void {
    while (!this.done()) {
      const [field, wt] = this.tag();
      if (wt === WIRE_END_GROUP) throw new Error("protobuf: unexpected end group");
      if (!handler(field, wt)) this.skip(wt, field);
    }
  }
}
