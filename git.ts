// Git primitives: SHA-1 objects, pkt-line codec, packfile read/write (incl. deltas).
// Node standard library only. No git binary.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: GitObjectType; data: Buffer; }

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Parse a commit object into tree/parents. */
export function parseCommit(data: Buffer): { tree: string; parents: string[] } {
  const text = data.toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of text.split('\n')) {
    if (line === '') break;
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

/** Parse a tag object into its target. */
export function parseTag(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  let object = '', type = '';
  for (const line of text.split('\n')) {
    if (line === '') break;
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
  }
  return { object, type };
}

export interface TreeEntry { mode: string; name: string; oid: string; }

/** Parse a tree object. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp);
    const mode = data.toString('ascii', off, sp);
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Build a tree object from entries, git canonical sort (dirs sort as name + '/'). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? a.name + '/' : a.name;
    const bn = b.mode === '40000' ? b.name + '/' : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommit(opts: { tree: string; parents: readonly string[]; message: string; author: string; committer: string; timestamp: number }): Buffer {
  let s = `tree ${opts.tree}\n`;
  for (const p of opts.parents) s += `parent ${p}\n`;
  s += `author ${opts.author} ${opts.timestamp} +0000\n`;
  s += `committer ${opts.committer} ${opts.timestamp} +0000\n`;
  s += `\n${opts.message}`;
  return Buffer.from(s, 'utf8');
}

export function buildTag(opts: { object: string; type: string; tag: string; message: string; tagger: string; timestamp: number }): Buffer {
  const s = `object ${opts.object}\ntype ${opts.type}\ntag ${opts.tag}\n` +
    `tagger ${opts.tagger} ${opts.timestamp} +0000\n\n${opts.message}`;
  return Buffer.from(s, 'utf8');
}

// -------------------------------------------------------------------------------- pkt-line

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const RESPONSE_END = Buffer.from('0002', 'ascii');

export function pktLines(items: readonly (Buffer | string | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(FLUSH);
    else if (it === 'delim') parts.push(DELIM);
    else if (it === 'response-end') parts.push(RESPONSE_END);
    else parts.push(pktLine(it));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines into data payloads + control markers. */
export function decodePktLines(buf: Buffer): Array<{ kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' }> {
  const out: Array<{ kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' }> = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    const len = parseInt(buf.toString('ascii', off, off + 4), 16);
    if (Number.isNaN(len) || len < 0) throw new Error('bad pkt-line length');
    if (len === 0) { out.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end' }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

// -------------------------------------------------------------------------------- packfile

function encodePackEntryHeader(typeCode: number, size: number): Buffer {
  // first byte: (size & 0x0f) | (type << 4) | continuation; then 7-bit groups, little-endian.
  const bytes: number[] = [];
  let b = (size & 0x0f) | (typeCode << 4);
  size >>>= 4;
  if (size) b |= 0x80;
  bytes.push(b);
  while (size) {
    b = size & 0x7f;
    size >>>= 7;
    if (size) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Write a version-2 pack of plain (non-delta) objects. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const v = Buffer.allocUnsafe(4); v.writeUInt32BE(2, 0); parts.push(v);
  const n = Buffer.allocUnsafe(4); n.writeUInt32BE(objects.length, 0); parts.push(n);
  for (const obj of objects) {
    parts.push(encodePackEntryHeader(TYPE_CODES[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let v = 0, shift = 0;
    for (;;) {
      const b = delta[off++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0, cpSize = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) cpOff |= delta[off++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) cpSize |= delta[off++] << (8 * i);
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op) {
      out.push(delta.subarray(off, off + op));
      off += op;
      total += op;
    } else throw new Error('delta op 0');
  }
  const result = Buffer.concat(out);
  if (result.length !== tgtSize || total !== tgtSize) throw new Error('delta target size mismatch');
  return result;
}

export interface ReadPackResult { objects: Map<string, GitObject>; deltaCount: number; }

/** Inflate one zlib stream starting at `off`; returns data + bytes consumed. */
function inflateOne(pack: Buffer, off: number): { data: Buffer; consumed: number } {
  const r = inflateSync(pack.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: r.buffer as Buffer, consumed: r.engine.bytesWritten };
}

/** Read a packfile; resolves OFS_DELTA and REF_DELTA (thin-pack bases via resolveBase). */
export function readPack(pack: Buffer, opts: { resolveBase?: (oid: string) => GitObject | undefined } = {}): ReadPackResult {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = sha1Hex(pack.subarray(0, pack.length - 20));
  if (expected !== actual) throw new Error('pack checksum mismatch');

  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = off;
    let b = pack[off++];
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = pack[off++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseObj: GitObject | undefined;
    if (typeCode === 6) { // OFS_DELTA
      deltaCount++;
      let b2 = pack[off++];
      let baseOffset = b2 & 0x7f;
      while (b2 & 0x80) {
        b2 = pack[off++];
        baseOffset = ((baseOffset + 1) << 7) | (b2 & 0x7f);
      }
      baseObj = byOffset.get(entryOffset - baseOffset);
      if (!baseObj) throw new Error('ofs-delta base not in pack');
    } else if (typeCode === 7) { // REF_DELTA
      deltaCount++;
      const baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      baseObj = objects.get(baseOid) ?? opts.resolveBase?.(baseOid);
      if (!baseObj) throw new Error('ref-delta base not found');
    } else if (!(typeCode in CODE_TYPES)) {
      throw new Error(`unknown pack object type ${typeCode}`);
    }
    const { data, consumed } = inflateOne(pack, off);
    off += consumed;
    let obj: GitObject;
    if (baseObj) {
      if (data.length === 0) throw new Error('empty delta');
      obj = { type: baseObj.type, data: applyDelta(baseObj.data, data) };
    } else {
      obj = { type: CODE_TYPES[typeCode], data };
    }
    if (obj.data.length !== size) throw new Error('pack object size mismatch');
    const oid = hashObject(obj.type, obj.data);
    objects.set(oid, obj);
    byOffset.set(entryOffset, obj);
  }
  return { objects, deltaCount };
}

/** All object ids reachable from `tips` (commits, their trees/blobs, tags). */
export function collectReachable(
  tips: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const { tree, parents } = parseCommit(obj.data);
      stack.push(tree, ...parents);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}
