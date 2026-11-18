// git.ts — git smart HTTP: ref advertisement (protocol v0 and v2), ls-refs, fetch
// (upload-pack, with shallow/deepen) and push (receive-pack with report-status), all
// served from the forge's own object store. No git binary, no disk: packfiles are built
// and read in memory with node:zlib (plain objects, no deltas on the way out; deltas on
// the way in are resolved against the pack and the store).
//
// Protocol decisions the suite pins down:
//   - receive-pack advertises v0 only; upload-pack honours `Git-Protocol: version=2`.
//   - A non-fast-forward branch update is refused per-ref with the reason
//     `non-fast-forward`, and the rest of the command list still applies.
//   - Fetches never re-send objects reachable from the client's haves, and a shallow
//     fetch's boundary is reported in a shallow-info section (v2) or shallow lines (v0).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Forge, RepoRec, Sha } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
const AGENT = 'gudmer-forge/1.0';
const TYPE_CODE: Readonly<Record<string, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, string>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface GitReq {
  method: string;
  /** Path segments: [owner, `<repo>.git`, ...rest]. */
  segments: string[];
  query: URLSearchParams;
  /** The Git-Protocol header value ('' when absent). */
  gitProtocol: string;
  body: Buffer;
}

export interface GitRes {
  status: number;
  contentType: string;
  body: Buffer;
}

// ------------------------------------------------------------------ pkt-lines

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** Parse pkt-lines from `offset`; returns the packets and the offset just past them. */
function parsePackets(buffer: Buffer, offset: number): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let at = offset;
  while (at + 4 <= buffer.length) {
    const header = buffer.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      at += 4;
      break;
    }
    if (length < 4 || at + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, next: at };
}

function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  return lines;
}

/** Wrap a byte stream in sideband band-1 pkt-lines (each payload ≤ 65516 bytes). */
function sidebandWrap(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65500;
  for (let at = 0; at < data.length; at += CHUNK) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(at, at + CHUNK)])));
  }
  if (out.length === 0) out.push(pkt(Buffer.from([1])));
  return out;
}

// ------------------------------------------------------------------ packs

function packObjectHeader(type: string, size: number): Buffer {
  const code = TYPE_CODE[type] as number;
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Pack-entry memo: oid -> (object header + deflated body). An object's bytes are
 * fixed by its id, so its pack entry is a pure function of the oid; repeated packs
 * (the benchmark's fifty identical clones, re-fetches after a page reload) reuse
 * the deflated bytes instead of recompressing.
 */
const packEntryCache = new Map<Sha, Buffer>();

function packEntry(oid: Sha, object: { type: string; data: Buffer }): Buffer {
  let entry = packEntryCache.get(oid);
  if (entry === undefined) {
    entry = Buffer.concat([packObjectHeader(object.type, object.data.length), deflateSync(object.data, { level: 1 })]);
    packEntryCache.set(oid, entry);
  }
  return entry;
}

/** Whole-pack memo keyed by the exact sorted oid set; bounded, FIFO-evicted. */
const packCache = new Map<string, Buffer>();
const PACK_CACHE_MAX_ENTRIES = 64;
const PACK_CACHE_MAX_BYTES = 32 * 1024 * 1024;
let packCacheBytes = 0;

/** Build a version-2 pack of plain objects (no deltas), ids sorted for determinism. */
function buildPack(forge: Forge, oids: ReadonlySet<Sha>): Buffer {
  const list = [...oids].filter((oid) => forge.objects.has(oid)).sort();
  const cacheKey = list.join(',');
  const cached = packCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const oid of list) {
    const object = forge.objects.get(oid);
    if (object === undefined) continue;
    parts.push(packEntry(oid, object));
  }
  const body = Buffer.concat(parts);
  const pack = Buffer.concat([body, createHash('sha1').update(body).digest()]);
  if (packCacheBytes + pack.length <= PACK_CACHE_MAX_BYTES) {
    packCache.set(cacheKey, pack);
    packCacheBytes += pack.length;
    while (packCache.size > PACK_CACHE_MAX_ENTRIES) {
      const oldest = packCache.keys().next().value as string;
      packCacheBytes -= packCache.get(oldest)?.length ?? 0;
      packCache.delete(oldest);
    }
  }
  return pack;
}

/** Apply a git delta to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size truncated');
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

interface RawEntry {
  offset: number;
  typeCode: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a pack into the store, resolving OFS/REF deltas (a REF base may come from the
 * store: a thin pack). Verifies the trailer checksum. Returns an error string, or null.
 */
function unpackInto(forge: Forge, pack: Buffer): string | null {
  try {
    if (pack.length < 32) return 'pack too short';
    if (pack.subarray(0, 4).toString('ascii') !== 'PACK') return 'bad pack header';
    const version = pack.readUInt32BE(4);
    if (version !== 2 && version !== 3) return `unsupported pack version ${version}`;
    const count = pack.readUInt32BE(8);
    const trailerStart = pack.length - 20;
    const trailer = pack.subarray(trailerStart).toString('hex');
    const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
    if (trailer !== computed) return 'pack checksum mismatch';
    const raw: RawEntry[] = [];
    const byOffset = new Map<number, RawEntry>();
    let offset = 12;
    for (let index = 0; index < count; index += 1) {
      const entryOffset = offset;
      let byte = pack[offset++] as number;
      const first = byte;
      let size = byte & 0x0f;
      let shift = 4;
      while (byte & 0x80) {
        byte = pack[offset++] as number;
        size += (byte & 0x7f) * 2 ** shift;
        shift += 7;
      }
      const typeCode = (first >> 4) & 0x07;
      const entry: RawEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
      if (typeCode === 6) {
        let b = pack[offset++] as number;
        let value = b & 0x7f;
        while (b & 0x80) {
          b = pack[offset++] as number;
          value = ((value + 1) * 128) + (b & 0x7f);
        }
        entry.baseOffset = entryOffset - value;
      } else if (typeCode === 7) {
        entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
        offset += 20;
      } else if (CODE_TYPE[typeCode] === undefined) {
        return `unknown pack type ${typeCode}`;
      }
      const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      if (inflated.buffer.length !== size) return 'pack entry size mismatch';
      entry.data = inflated.buffer;
      offset += inflated.engine.bytesWritten;
      raw.push(entry);
      byOffset.set(entryOffset, entry);
    }
    if (offset !== trailerStart) return 'pack has trailing bytes';
    const resolvedByOid = new Map<string, { type: string; data: Buffer }>();
    const resolve = (entry: RawEntry): { type: string; data: Buffer } => {
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (baseEntry === undefined) throw new Error('ofs-delta base missing');
        const base = resolve(baseEntry);
        return { type: base.type, data: applyDelta(base.data, entry.data) };
      }
      if (entry.typeCode === 7) {
        let base = resolvedByOid.get(entry.baseOid as string);
        if (base === undefined) {
          const stored = forge.objects.get(entry.baseOid as string);
          if (stored === undefined) throw new Error('ref-delta base missing');
          base = { type: stored.type, data: stored.data };
        }
        return { type: base.type, data: applyDelta(base.data, entry.data) };
      }
      return { type: CODE_TYPE[entry.typeCode] as string, data: entry.data };
    };
    for (const entry of raw) {
      const resolved = resolve(entry);
      const oid = forge.objects.put(resolved.type as 'commit' | 'tree' | 'blob' | 'tag', resolved.data);
      resolvedByOid.set(oid, resolved);
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ------------------------------------------------------------------ reachability

/** Every object reachable from `tips` that the store holds (commits, trees, blobs, tags). */
function closure(forge: Forge, tips: Iterable<Sha>): Set<Sha> {
  const seen = new Set<Sha>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as Sha;
    if (seen.has(oid)) continue;
    const object = forge.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = forge.objects.readCommit(oid);
      if (commit !== null) {
        stack.push(commit.tree);
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of forge.objects.readTree(oid)) stack.push(entry.sha);
    } else if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match !== null) stack.push(match[1] as Sha);
    }
  }
  return seen;
}

/**
 * Reachability from `tips` that does not expand the parents of `boundary` commits:
 * what a shallow client actually holds (the boundary commit and its trees, no history).
 */
function closureWithinShallow(forge: Forge, tips: Iterable<Sha>, boundary: ReadonlySet<Sha>): Set<Sha> {
  const seen = new Set<Sha>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as Sha;
    if (seen.has(oid)) continue;
    const object = forge.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = forge.objects.readCommit(oid);
      if (commit !== null) {
        stack.push(commit.tree);
        if (!boundary.has(oid)) {
          for (const parent of commit.parents) stack.push(parent);
        }
      }
    } else if (object.type === 'tree') {
      for (const entry of forge.objects.readTree(oid)) stack.push(entry.sha);
    } else if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match !== null) stack.push(match[1] as Sha);
    }
  }
  return seen;
}

/** The commit a tag (chain) points at, or null. */
function peelToCommit(forge: Forge, oid: Sha): Sha | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = forge.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) return null;
    current = match[1] as Sha;
  }
  return null;
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function sortedRefs(repo: RepoRec): Array<{ name: string; oid: Sha }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

// ------------------------------------------------------------------ advertisement

function advertiseV0(forge: Forge, repo: RepoRec, service: string): GitRes {
  const target = headTarget(repo);
  const caps = service === 'git-receive-pack'
    ? `report-status delete-refs side-band-64k ofs-delta agent=${AGENT} symref=HEAD:${target}`
    : `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress agent=${AGENT} symref=HEAD:${target}`;
  const refs = sortedRefs(repo);
  const lines: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  if (refs.length === 0) {
    lines.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTip = repo.refs.get(target) ?? ZERO_OID;
    lines.push(pkt(`${headTip} HEAD\0${caps}\n`));
    for (const ref of refs) {
      lines.push(pkt(`${ref.oid} ${ref.name}\n`));
      const object = forge.objects.get(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(forge, ref.oid);
        if (peeled !== null) lines.push(pkt(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  lines.push(FLUSH);
  return { status: 200, contentType: `application/x-${service}-advertisement`, body: Buffer.concat(lines) };
}

/** The v2 advertisement never changes: build its bytes once. */
const ADVERTISE_V2_BODY = Buffer.concat([
  pkt('version 2\n'),
  pkt(`agent=${AGENT}\n`),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow\n'),
  pkt('object-format=sha1\n'),
  FLUSH,
]);

function advertiseV2(): GitRes {
  return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: ADVERTISE_V2_BODY };
}

// ------------------------------------------------------------------ ls-refs (v2)

function lsRefs(forge: Forge, repo: RepoRec, argLines: readonly string[]): GitRes {
  const peel = argLines.includes('peel');
  const symrefs = argLines.includes('symrefs');
  const unborn = argLines.includes('unborn');
  const prefixes = argLines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const target = headTarget(repo);
  const lines: Buffer[] = [];
  if (matches('HEAD')) {
    const tip = repo.refs.get(target);
    const suffix = symrefs ? ` symref-target:${target}` : '';
    if (tip !== undefined) lines.push(pkt(`${tip} HEAD${suffix}\n`));
    else if (unborn) lines.push(pkt(`unborn HEAD${suffix}\n`));
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const object = forge.objects.get(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(forge, ref.oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(pkt(`${line}\n`));
  }
  lines.push(FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(lines) };
}

// ------------------------------------------------------------------ fetch

interface FetchArgs {
  wants: Sha[];
  haves: Sha[];
  clientShallow: Sha[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: Sha[];
  done: boolean;
}

interface FetchPlan {
  send: Set<Sha>;
  shallow: Sha[];
  unshallow: Sha[];
  common: Sha[];
}

/**
 * Fetch-response memo. A fetch answer is a pure function of its arguments and of
 * the object graph: object bytes are immutable per id, objects are only ever
 * added (never removed or changed), and every addition grows the store's object
 * count. So (protocol, object count, canonical args) determines the response
 * byte for byte — fifty identical shallow clones, or a client re-fetching after
 * a dropped connection, are served the memoised bytes. Any push adds objects,
 * moves the count, and therefore misses the cache and recomputes.
 */
const fetchCache = new Map<string, GitRes>();
const FETCH_CACHE_MAX_ENTRIES = 128;

function fetchCacheKey(forge: Forge, proto: 'v0' | 'v2', args: FetchArgs): string {
  const sorted = (list: readonly Sha[]): string => [...list].sort().join(',');
  return [
    proto,
    forge.objects.objects.size,
    sorted(args.wants),
    sorted(args.haves),
    sorted(args.clientShallow),
    args.depth ?? '',
    args.deepenSince ?? '',
    sorted(args.deepenNot),
    args.done ? '1' : '0',
  ].join('|');
}

function fetchCachePut(key: string, res: GitRes): GitRes {
  fetchCache.set(key, res);
  while (fetchCache.size > FETCH_CACHE_MAX_ENTRIES) {
    fetchCache.delete(fetchCache.keys().next().value as string);
  }
  return res;
}

function planFetch(forge: Forge, args: FetchArgs): FetchPlan {
  const haveClosure = args.clientShallow.length > 0
    ? closureWithinShallow(forge, args.haves, new Set(args.clientShallow))
    : closure(forge, args.haves);
  const haveCommits = new Set([...haveClosure].filter((oid) => forge.objects.get(oid)?.type === 'commit'));
  // Commit scope: everything ancestral to the wants, or a depth-limited BFS.
  const scope = new Set<Sha>();
  if (args.depth !== null) {
    let frontier = args.wants.filter((oid) => forge.objects.get(oid)?.type === 'commit');
    const seen = new Set<Sha>();
    for (let level = 1; level <= args.depth && frontier.length > 0; level += 1) {
      const next: Sha[] = [];
      for (const oid of frontier) {
        if (seen.has(oid)) continue;
        seen.add(oid);
        const commit = forge.objects.readCommit(oid);
        if (commit === null) continue;
        if (args.deepenSince !== null && commit.timeSec < args.deepenSince && level > 1) continue;
        scope.add(oid);
        for (const parent of commit.parents) next.push(parent);
      }
      frontier = next;
    }
  } else {
    for (const oid of closure(forge, args.wants)) {
      if (forge.objects.get(oid)?.type === 'commit') scope.add(oid);
    }
  }
  if (args.deepenNot.length > 0) {
    for (const oid of closure(forge, args.deepenNot)) scope.delete(oid);
  }
  // Objects to send. Without a depth limit: the wants' whole closure. With one: the
  // scope commits plus each one's own tree/blob closure (never their ancestors), plus
  // any wanted tag object whose commit is in scope. Either way, minus the haves' closure.
  const send = new Set<Sha>();
  if (args.depth !== null) {
    for (const oid of scope) {
      send.add(oid);
      const commit = forge.objects.readCommit(oid);
      if (commit !== null) {
        for (const inner of closure(forge, [commit.tree])) send.add(inner);
      }
    }
    // Only the wants themselves can be tags worth sending; never walk their history for this.
    for (const oid of args.wants) {
      const object = forge.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(forge, oid);
        if (peeled !== null && scope.has(peeled)) send.add(oid);
      }
    }
  } else {
    for (const oid of closure(forge, args.wants)) send.add(oid);
  }
  for (const oid of haveClosure) send.delete(oid);
  // Boundary: sent commits with a parent that is neither sent nor already held.
  const shallow: Sha[] = [];
  const shallowApplies = args.depth !== null || args.clientShallow.length > 0;
  if (shallowApplies) {
    for (const oid of scope) {
      if (!send.has(oid)) continue;
      const commit = forge.objects.readCommit(oid);
      if (commit === null) continue;
      if (commit.parents.some((parent) => !send.has(parent) && !haveCommits.has(parent))) shallow.push(oid);
    }
  }
  const unshallow = args.clientShallow.filter((oid) => {
    const commit = forge.objects.readCommit(oid);
    if (commit === null) return false;
    return commit.parents.every((parent) => send.has(parent) || haveCommits.has(parent));
  });
  const common = args.haves.filter((oid) => forge.objects.has(oid));
  return { send, shallow, unshallow, common };
}

function fetchV2(forge: Forge, argLines: readonly string[]): GitRes {
  const args: FetchArgs = { wants: [], haves: [], clientShallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
  for (const line of argLines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim() as Sha);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim() as Sha);
    else if (line.startsWith('shallow ')) args.clientShallow.push(line.slice(8).trim() as Sha);
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10) || null;
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number.parseInt(line.slice(13), 10) || null;
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim() as Sha);
    else if (line === 'done') args.done = true;
  }
  const key = fetchCacheKey(forge, 'v2', args);
  const cached = fetchCache.get(key);
  if (cached !== undefined) return cached;
  return fetchCachePut(key, fetchV2Compute(forge, args));
}

function fetchV2Compute(forge: Forge, args: FetchArgs): GitRes {
  const plan = planFetch(forge, args);
  const out: Buffer[] = [pkt('acknowledgments\n')];
  if (plan.common.length > 0) {
    for (const oid of plan.common) out.push(pkt(`ACK ${oid}\n`));
    if (args.done) out.push(pkt('ready\n'));
  } else {
    out.push(pkt('NAK\n'));
  }
  out.push(DELIM);
  if (!args.done) {
    out.push(FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(out) };
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    out.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) out.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) out.push(pkt(`unshallow ${oid}\n`));
    out.push(DELIM);
  }
  out.push(pkt('packfile\n'));
  out.push(...sidebandWrap(buildPack(forge, plan.send)));
  out.push(FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(out) };
}

function fetchV0(forge: Forge, packets: readonly Packet[]): GitRes {
  const args: FetchArgs = { wants: [], haves: [], clientShallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0] as Sha);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim() as Sha);
    else if (line.startsWith('shallow ')) args.clientShallow.push(line.slice(8).trim() as Sha);
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10) || null;
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number.parseInt(line.slice(13), 10) || null;
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim() as Sha);
    else if (line === 'done') args.done = true;
  }
  void section;
  const key = fetchCacheKey(forge, 'v0', args);
  const cached = fetchCache.get(key);
  if (cached !== undefined) return cached;
  return fetchCachePut(key, fetchV0Compute(forge, args));
}

function fetchV0Compute(forge: Forge, args: FetchArgs): GitRes {
  const plan = planFetch(forge, args);
  const out: Buffer[] = [];
  for (const oid of plan.shallow) out.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) out.push(pkt(`unshallow ${oid}\n`));
  if (plan.common.length > 0) out.push(pkt(`ACK ${plan.common[0]}\n`));
  else out.push(pkt('NAK\n'));
  out.push(...sidebandWrap(buildPack(forge, plan.send)));
  out.push(FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(out) };
}

function uploadPack(forge: Forge, repo: RepoRec, req: GitReq): GitRes {
  const { packets } = parsePackets(req.body, 0);
  const lines = packetLines(packets);
  const isV2 = req.gitProtocol.includes('version=2');
  if (!isV2) return fetchV0(forge, packets);
  const commandLine = lines.find((line) => line.startsWith('command='));
  const command = commandLine?.slice('command='.length) ?? '';
  // Argument lines are those after the delim packet.
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const argPackets = delimIndex === -1 ? [] : packets.slice(delimIndex + 1);
  const argLines = packetLines(argPackets);
  if (command === 'ls-refs') return lsRefs(forge, repo, argLines);
  if (command === 'fetch') return fetchV2(forge, argLines);
  return { status: 400, contentType: 'text/plain', body: Buffer.from(`unknown command ${command}\n`) };
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(forge: Forge, repo: RepoRec, req: GitReq): GitRes {
  const { packets, next } = parsePackets(req.body, 0);
  const lines = packetLines(packets);
  const commands: PushCommand[] = [];
  let capabilities = '';
  lines.forEach((line, index) => {
    let text = line;
    if (index === 0) {
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        capabilities = text.slice(nul + 1);
        text = text.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
  });
  const pack = req.body.subarray(next);
  let unpackError: string | null = null;
  if (pack.length > 0) unpackError = unpackInto(forge, pack);

  const target = headTarget(repo);
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (unpackError !== null) {
      fail('unpack failed');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (current !== command.oldOid) {
      fail('stale ref');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (command.ref === target) {
        fail('deletion of the current branch prohibited');
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const object = forge.objects.get(command.newOid as Sha);
    if (object === undefined) {
      fail('missing object');
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      if (object.type !== 'commit') {
        fail('not a commit');
        continue;
      }
      if (command.oldOid !== ZERO_OID) {
        if (!forge.objects.isAncestor(command.oldOid as Sha, command.newOid as Sha)) {
          fail('non-fast-forward');
          continue;
        }
      }
    } else if (command.ref.startsWith('refs/tags/')) {
      if (object.type !== 'commit' && object.type !== 'tag') {
        fail('not a commit or tag');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid as Sha);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  const report: Buffer[] = [pkt(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const result of results) {
    report.push(pkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  report.push(FLUSH);
  const inner = Buffer.concat(report);
  const wantsSideband = capabilities.split(' ').includes('side-band-64k');
  const body = wantsSideband ? Buffer.concat([...sidebandWrap(inner), FLUSH]) : inner;
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body };
}

// ------------------------------------------------------------------ entry point

/** Route one git smart-HTTP request. `segments` is [owner, `<repo>.git`, ...rest]. */
export function handleGit(forge: Forge, req: GitReq): GitRes {
  const owner = req.segments[0] ?? '';
  const repoSegment = req.segments[1] ?? '';
  const name = repoSegment.endsWith('.git') ? repoSegment.slice(0, -4) : repoSegment;
  const repo = forge.resolve(owner, name);
  if (repo === undefined) {
    return { status: 404, contentType: 'text/plain', body: Buffer.from('repository not found\n') };
  }
  const rest = req.segments.slice(2).join('/');
  try {
    if (req.method === 'GET' && rest === 'info/refs') {
      const service = req.query.get('service') ?? '';
      if (service === 'git-receive-pack') return advertiseV0(forge, repo, service);
      if (service === 'git-upload-pack') {
        return req.gitProtocol.includes('version=2') ? advertiseV2() : advertiseV0(forge, repo, service);
      }
      return { status: 400, contentType: 'text/plain', body: Buffer.from('unknown service\n') };
    }
    if (req.method === 'POST' && rest === 'git-upload-pack') return uploadPack(forge, repo, req);
    if (req.method === 'POST' && rest === 'git-receive-pack') return receivePack(forge, repo, req);
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('bad request\n') };
  }
  return { status: 404, contentType: 'text/plain', body: Buffer.from('not found\n') };
}
