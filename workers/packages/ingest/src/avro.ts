// Just enough Avro object-container-file support to rewrite Iceberg manifests
// (refs #167). Basin Catalog writes manifests and manifest lists uncompressed
// (`avro.codec` = "null"); other engines (PyIceberg) use "deflate". Both read;
// writes are always "null". Any other codec throws rather than being misread.
//
// Values are decoded generically against the file's own writer schema and
// written back with the same schema, so fields this code never looks at
// (column stats, split offsets) survive a rewrite byte for byte in meaning.
// `long` is always a bigint: Iceberg snapshot ids use all 63 bits.

export type AvroSchema =
  | string
  | AvroSchema[]
  | { type: string; name?: string; namespace?: string; fields?: { name: string; type: AvroSchema }[]; items?: AvroSchema; values?: AvroSchema; symbols?: string[]; size?: number; [k: string]: unknown };

export interface AvroFile {
  schema: AvroSchema;
  /** Header metadata other than `avro.schema` and `avro.codec`. */
  metadata: Record<string, string>;
  records: Record<string, unknown>[];
}

const MAGIC = [0x4f, 0x62, 0x6a, 0x01]; // "Obj" 1
const text = new TextEncoder();
const untext = new TextDecoder();

export class AvroError extends Error {
  override name = "AvroError";
}

class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  long(): bigint {
    let n = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.buf.length) throw new AvroError("truncated varint");
      const b = this.buf[this.pos++];
      n |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7n;
    }
    return (n >> 1n) ^ -(n & 1n);
  }

  int(): number {
    return Number(this.long());
  }

  bytes(n = this.int()): Uint8Array {
    if (n < 0 || this.pos + n > this.buf.length) throw new AvroError("truncated bytes");
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  get done(): boolean {
    return this.pos >= this.buf.length;
  }
}

class Writer {
  private chunks: Uint8Array[] = [];
  private size = 0;

  push(b: Uint8Array): void {
    this.chunks.push(b);
    this.size += b.length;
  }

  long(v: bigint | number): void {
    let n = BigInt(v);
    n = (n << 1n) ^ (n >> 63n);
    n = BigInt.asUintN(64, n);
    const out: number[] = [];
    while (n >= 0x80n) {
      out.push(Number(n & 0x7fn) | 0x80);
      n >>= 7n;
    }
    out.push(Number(n));
    this.push(Uint8Array.from(out));
  }

  bytes(b: Uint8Array): void {
    this.long(b.length);
    this.push(b);
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

type Named = Map<string, AvroSchema>;

function typeName(s: AvroSchema): string {
  if (typeof s === "string") return s;
  if (Array.isArray(s)) return "union";
  return s.type;
}

function register(s: AvroSchema, named: Named): void {
  if (typeof s === "string" || Array.isArray(s)) {
    if (Array.isArray(s)) for (const b of s) register(b, named);
    return;
  }
  if (s.name && ["record", "enum", "fixed"].includes(s.type)) named.set(s.name, s);
  for (const f of s.fields ?? []) register(f.type, named);
  if (s.items) register(s.items, named);
  if (s.values) register(s.values, named);
  if (typeof s.type === "object") register(s.type as AvroSchema, named);
}

function resolve(s: AvroSchema, named: Named): AvroSchema {
  if (typeof s === "string") return named.get(s) ?? s;
  if (!Array.isArray(s) && typeof s.type === "object") return resolve(s.type as AvroSchema, named);
  return s;
}

function decode(s: AvroSchema, r: Reader, named: Named): unknown {
  s = resolve(s, named);
  if (Array.isArray(s)) return decode(s[r.int()], r, named);
  const t = typeName(s);
  switch (t) {
    case "null":
      return null;
    case "boolean":
      return r.bytes(1)[0] !== 0;
    case "int":
      return r.int();
    case "long":
      return r.long();
    case "float":
      return new DataView(r.bytes(4).buffer).getFloat32(0, true);
    case "double":
      return new DataView(r.bytes(8).buffer).getFloat64(0, true);
    case "bytes":
      return r.bytes();
    case "string":
      return untext.decode(r.bytes());
  }
  if (typeof s === "string") throw new AvroError(`unknown type ${s}`);
  switch (t) {
    case "record": {
      const out: Record<string, unknown> = {};
      for (const f of s.fields ?? []) out[f.name] = decode(f.type, r, named);
      return out;
    }
    case "enum":
      return s.symbols![r.int()];
    case "fixed":
      return r.bytes(s.size!);
    case "array":
    case "map": {
      const out: unknown[] = [];
      const map: Record<string, unknown> = {};
      for (;;) {
        let n = r.int();
        if (n === 0) break;
        if (n < 0) {
          n = -n;
          r.long(); // block byte size
        }
        for (let i = 0; i < n; i++) {
          if (t === "array") out.push(decode(s.items!, r, named));
          else map[untext.decode(r.bytes())] = decode(s.values!, r, named);
        }
      }
      return t === "array" ? out : map;
    }
  }
  throw new AvroError(`unsupported type ${t}`);
}

/** Which union branch `v` belongs to. Iceberg's unions are `["null", X]`. */
function branch(u: AvroSchema[], v: unknown, named: Named): number {
  if (v === null || v === undefined) {
    const i = u.findIndex((b) => typeName(resolve(b, named)) === "null");
    if (i === -1) throw new AvroError("null for a union without null");
    return i;
  }
  const nonNull = u.filter((b) => typeName(resolve(b, named)) !== "null");
  if (nonNull.length !== 1) throw new AvroError("only [null, X] unions are supported");
  return u.indexOf(nonNull[0]);
}

function encode(s: AvroSchema, v: unknown, w: Writer, named: Named): void {
  s = resolve(s, named);
  if (Array.isArray(s)) {
    const i = branch(s, v, named);
    w.long(i);
    encode(s[i], v, w, named);
    return;
  }
  const t = typeName(s);
  switch (t) {
    case "null":
      return;
    case "boolean":
      w.push(Uint8Array.of(v ? 1 : 0));
      return;
    case "int":
    case "long":
      w.long(v as number | bigint);
      return;
    case "float":
    case "double": {
      const b = new Uint8Array(t === "float" ? 4 : 8);
      const dv = new DataView(b.buffer);
      if (t === "float") dv.setFloat32(0, v as number, true);
      else dv.setFloat64(0, v as number, true);
      w.push(b);
      return;
    }
    case "bytes":
      w.bytes(v as Uint8Array);
      return;
    case "string":
      w.bytes(text.encode(v as string));
      return;
  }
  if (typeof s === "string") throw new AvroError(`unknown type ${s}`);
  switch (t) {
    case "record": {
      const rec = v as Record<string, unknown>;
      for (const f of s.fields ?? []) encode(f.type, rec[f.name] ?? null, w, named);
      return;
    }
    case "enum":
      w.long(s.symbols!.indexOf(v as string));
      return;
    case "fixed":
      w.push(v as Uint8Array);
      return;
    case "array": {
      const a = v as unknown[];
      if (a.length) {
        w.long(a.length);
        for (const x of a) encode(s.items!, x, w, named);
      }
      w.long(0);
      return;
    }
    case "map": {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length) {
        w.long(entries.length);
        for (const [k, x] of entries) {
          w.bytes(text.encode(k));
          encode(s.values!, x, w, named);
        }
      }
      w.long(0);
      return;
    }
  }
  throw new AvroError(`unsupported type ${t}`);
}

const HEADER_SCHEMA: AvroSchema = { type: "map", values: "bytes" };

/**
 * Avro's "deflate" is raw RFC 1951. PyIceberg writes `zlib.compress(data)[2:-1]`,
 * which leaves three checksum bytes after the stream. zlib ignores them;
 * DecompressionStream rejects them, so a "trailing bytes" failure retries with
 * up to four bytes trimmed. A trim into the real stream fails as truncated, so
 * only the true length inflates.
 */
export async function inflateRaw(b: Uint8Array): Promise<Uint8Array> {
  for (let trim = 0; ; trim++) {
    try {
      return await inflateOnce(trim ? b.subarray(0, b.length - trim) : b);
    } catch (e) {
      if (trim >= 4 || !/junk|trailing/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  }
}

async function inflateOnce(b: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const w = ds.writable.getWriter();
  // Their failures surface on the readable side; don't leave them unhandled.
  w.write(b).catch(() => {});
  w.close().catch(() => {});
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

export async function readAvro(buf: Uint8Array): Promise<AvroFile> {
  if (MAGIC.some((b, i) => buf[i] !== b)) throw new AvroError("not an Avro object container file");
  const r = new Reader(buf);
  r.pos = 4;
  const header = decode(HEADER_SCHEMA, r, new Map()) as Record<string, Uint8Array>;
  const codec = header["avro.codec"] ? untext.decode(header["avro.codec"]) : "null";
  if (codec !== "null" && codec !== "deflate") throw new AvroError(`unsupported codec ${codec}`);
  const schema = JSON.parse(untext.decode(header["avro.schema"])) as AvroSchema;
  const named: Named = new Map();
  register(schema, named);
  const sync = r.bytes(16);
  const records: Record<string, unknown>[] = [];
  while (!r.done) {
    const count = r.int();
    const size = r.int();
    const raw = r.bytes(size);
    const block = new Reader(codec === "deflate" ? await inflateRaw(raw) : raw);
    for (let i = 0; i < count; i++) records.push(decode(schema, block, named) as Record<string, unknown>);
    if (r.bytes(16).some((b, i) => b !== sync[i])) throw new AvroError("sync marker mismatch");
  }
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(header)) {
    if (k !== "avro.schema" && k !== "avro.codec") metadata[k] = untext.decode(v);
  }
  return { schema, metadata, records };
}

export function writeAvro(file: AvroFile): Uint8Array {
  const named: Named = new Map();
  register(file.schema, named);
  const w = new Writer();
  w.push(Uint8Array.from(MAGIC));
  const header: Record<string, Uint8Array> = {
    "avro.schema": text.encode(JSON.stringify(file.schema)),
    "avro.codec": text.encode("null"),
  };
  for (const [k, v] of Object.entries(file.metadata)) header[k] = text.encode(v);
  encode(HEADER_SCHEMA, header, w, new Map());
  const sync = crypto.getRandomValues(new Uint8Array(16));
  w.push(sync);
  if (file.records.length) {
    const block = new Writer();
    for (const rec of file.records) encode(file.schema, rec, block, named);
    const bytes = block.finish();
    w.long(file.records.length);
    w.long(bytes.length);
    w.push(bytes);
    w.push(sync);
  }
  return w.finish();
}
