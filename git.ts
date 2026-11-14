/**
 * git smart-HTTP module for the github-core-clone-01 forge.
 *
 * Implements the git smart-HTTP protocol (v0 + protocol v2 ls-refs/fetch)
 * for info/refs, git-upload-pack and git-receive-pack, plus plain-pack
 * writing and full pack reading (including OFS_DELTA / REF_DELTA).
 *
 * Deterministic: no wall clock, no randomness. Object bytes are stored
 * verbatim; commits/trees are never re-encoded on the way out.
 *
 * Implemented from the git protocol description in the task spec.
 * Node 22 TypeScript, stdlib only (node:crypto, node:zlib).
 */
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  Store,
  ZERO_OID,
  objectId,
  parseCommit,
  parseTag,
  parseTree,
  encodeTree,
  sortTreeEntries,
  isHex40,
} from './store.ts';
import type { ObjType, Repo } from './store.ts';

// parseTree / encodeTree / sortTreeEntries are part of the shared store
// surface this module imports from; they are kept as imports per the
// module contract even though pack I/O below works on raw object bytes.
void parseTree;
void encodeTree;
void sortTreeEntries;

export interface GitResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const AGENT = 'makefun-git-client/1.0';
const MAX_PACKET = 65520;
/** Max pack bytes per sideband packet: header (4) + band byte (1) + data. */
const SIDEBAND_CHUNK = MAX_PACKET - 5;

const UPLOAD_CAPS_V0 =
  `side-band-64k thin-pack ofs-delta multi_ack_detailed shallow no-progress agent=${AGENT}`;
const RECEIVE_CAPS_V0 =
  `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/* ------------------------------------------------------------------ */
/* pkt-line                                                            */
/* ------------------------------------------------------------------ */

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

type PktKind = 'data' | 'flush' | 'delim' | 'end';

interface PktLineEntry {
  kind: PktKind;
  /** Payload decoded as UTF-8 (empty for flush/delim/end). */
  text: string;
}

interface PktParse {
  lines: PktLineEntry[];
  /** Offset just past the terminating flush pkt-line. */
  offset: number;
  ok: boolean;
  error?: string;
}

/**
 * Parse pkt-lines starting at `start`. Stops at the first flush pkt-line
 * and reports the offset just past it, so callers can read the raw pack
 * bytes that follow (receive-pack). Returns ok=false when the buffer ends
 * or goes malformed before a flush.
 */
function parsePktLines(buf: Buffer, start = 0): PktParse {
  const lines: PktLineEntry[] = [];
  let i = start;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      return { lines, offset: i, ok: false, error: 'bad pkt-line header' };
    }
    const len = parseInt(hex, 16);
    if (len === 0) return { lines, offset: i + 4, ok: true };
    if (len === 1) {
      lines.push({ kind: 'delim', text: '' });
      i += 4;
      continue;
    }
    if (len === 2) {
      lines.push({ kind: 'end', text: '' });
      i += 4;
      continue;
    }
    if (len < 4 || len > MAX_PACKET || i + len > buf.length) {
      return { lines, offset: i, ok: false, error: 'bad pkt-line length' };
    }
    const payload = buf.subarray(i + 4, i + len);
    lines.push({ kind: 'data', text: payload.toString('utf8') });
    i += len;
  }
  return { lines, offset: i, ok: false, error: 'unexpected end of pkt-lines' };
}

/** Strip one trailing LF (and CR, defensively) from a pkt-line payload. */
function stripEol(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1).replace(/\r$/, '') : s;
}

/* ------------------------------------------------------------------ */
/* routing                                                             */
/* ------------------------------------------------------------------ */

const ROUTE_RE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function notFound(): GitResponse {
  return {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: Buffer.from('repository not found\n', 'utf8'),
  };
}

function badRequestText(detail: string): GitResponse {
  return {
    status: 400,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: Buffer.from(`${detail}\n`, 'utf8'),
  };
}

function lowerHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) out[k.toLowerCase()] = v;
  }
  return out;
}

export async function handleGit(
  store: Store,
  method: string,
  pathname: string,
  search: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): Promise<GitResponse | null> {
  const m = ROUTE_RE.exec(pathname);
  if (!m) return null;
  const owner = m[1];
  const repoName = m[2];
  const action = m[3];
  if (!NAME_RE.test(owner) || !NAME_RE.test(repoName) || repoName.endsWith('.git')) {
    return null;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound();
  const h = lowerHeaders(headers);
  const protoV2 = (h['git-protocol'] ?? '').trim() === 'version=2';

  if (action === 'info/refs') {
    if (method !== 'GET') return null;
    const service = search.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return notFound();
    return advertise(store, repo, service, protoV2);
  }
  if (action === 'git-upload-pack') {
    if (method !== 'POST') return null;
    return protoV2 ? uploadPackV2(store, repo, body) : uploadPackV0(store, repo, body);
  }
  if (action === 'git-receive-pack') {
    if (method !== 'POST') return null;
    return receivePack(store, repo, body);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* refs / advertisement                                                */
/* ------------------------------------------------------------------ */

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Peeled commit oid for an annotated tag ref, else null. */
function peeledOid(store: Store, repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const peeled = store.peel(repo, oid);
  return peeled === oid ? null : peeled;
}

function advertise(store: Store, repo: Repo, service: string, protoV2: boolean): GitResponse {
  const ct = `application/x-${service}-advertisement`;
  if (protoV2 && service === 'git-upload-pack') {
    const caps = [
      'version 2\n',
      'ls-refs=unborn\n',
      'fetch=shallow filter\n',
      'object-format=sha1\n',
      `agent=${AGENT}\n`,
    ];
    const parts = caps.map((c) => pktLine(c));
    parts.push(FLUSH);
    return { status: 200, headers: { 'Content-Type': ct }, body: Buffer.concat(parts) };
  }

  const isUpload = service === 'git-upload-pack';
  const capsBase = isUpload ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const target = headTarget(repo);
  const caps =
    isUpload && repo.refs.has(target) ? `${capsBase} symref=HEAD:${target}` : capsBase;

  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  // Real git advertises HEAD as its own first ref line (carrying the
  // capabilities, including symref); clients use it to resolve the remote
  // HEAD, e.g. clone --depth needs it to find remote_head at all.
  const headOid = repo.refs.get(target);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
      first = false;
    }
    for (const [name, oid] of refs) {
      parts.push(pktLine(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
      first = false;
      const peeled = peeledOid(store, repo, oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return { status: 200, headers: { 'Content-Type': ct }, body: Buffer.concat(parts) };
}

/* ------------------------------------------------------------------ */
/* object selection for fetch                                          */
/* ------------------------------------------------------------------ */

interface Selection {
  /** Oids to include in the pack (sorted). */
  objects: string[];
  /** Boundary commits for shallow-info / shallow lines (sorted). */
  shallow: string[];
}

/**
 * Objects the client already holds completely: everything reachable from its
 * haves, EXCEPT that a commit on the client's current shallow boundary is
 * held only shallowly — its tree/blobs are held, but its parents are not.
 * Without this, a deepen fetch (have == shallow tip) would wrongly exclude
 * the very parent generation the client asked to deepen into.
 */
function heldReachable(
  repo: Repo,
  haves: string[],
  shallows: string[],
): Set<string> {
  const boundary = new Set(shallows);
  const seen = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      if (!boundary.has(oid)) {
        for (const p of c.parents) stack.push(p);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') stack.push(e.oid);
      }
    }
  }
  return seen;
}

function selectObjects(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  deepen: number | null,
  shallows: string[] = [],
): Selection {
  const haveReach = heldReachable(repo, haves, shallows);
  const included = new Set<string>();
  const wantCommits: string[] = [];

  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      // Include the tag itself plus every tag in the chain down to the target.
      let cur = w;
      for (let guard = 0; guard < 8; guard += 1) {
        const o = repo.objects.get(cur);
        if (!o || o.type !== 'tag') break;
        included.add(cur);
        cur = parseTag(o.data).object;
      }
      const peeled = store.peel(repo, w);
      const target = repo.objects.get(peeled);
      if (target && target.type === 'commit') {
        wantCommits.push(peeled);
      } else if (target) {
        for (const o of store.reachable(repo, [peeled])) included.add(o);
      }
    } else if (obj.type === 'commit') {
      wantCommits.push(w);
    } else {
      for (const o of store.reachable(repo, [w])) included.add(o);
    }
  }

  const shallow: string[] = [];
  if (deepen === null || deepen === undefined) {
    for (const o of store.reachable(repo, wantCommits)) included.add(o);
  } else if (deepen <= 0) {
    // deepen 0: nothing is in range; an empty pack is the honest answer.
    return { objects: [], shallow: [] };
  } else {
    // BFS over commit parents, tracking depth from the wants.
    const depth = new Map<string, number>();
    const queue: string[] = [];
    for (const c of wantCommits) {
      if (!depth.has(c)) {
        depth.set(c, 0);
        queue.push(c);
      }
    }
    const includedCommits = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      const d = depth.get(oid) as number;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      included.add(oid);
      includedCommits.add(oid);
      const c = parseCommit(obj.data);
      for (const o of store.reachable(repo, [c.tree])) included.add(o);
      if (d >= deepen - 1) continue;
      for (const p of c.parents) {
        if (!depth.has(p)) {
          depth.set(p, d + 1);
          queue.push(p);
        }
      }
    }
    // Boundary: commits at the depth cutoff, or commits whose parent was
    // excluded (missing from the store, or beyond the cutoff).
    for (const oid of includedCommits) {
      const d = depth.get(oid) as number;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (d === deepen - 1 || parents.some((p) => !includedCommits.has(p))) {
        shallow.push(oid);
      }
    }
    shallow.sort();
  }

  const objects = [...included].filter((o) => !haveReach.has(o)).sort();
  // A shallow marker only makes sense for a commit actually in the pack
  // (e.g. want==have must not report the tip as shallow).
  const shallowInPack = shallow.filter((s) => objects.includes(s));
  return { objects, shallow: shallowInPack };
}

/** Find a ref name for a wanted oid (raw match first, then peeled match). */
function refForOid(store: Store, repo: Repo, oid: string): string | undefined {
  for (const [name, o] of sortedRefs(repo)) {
    if (o === oid) return name;
  }
  for (const [name, o] of sortedRefs(repo)) {
    if (store.peel(repo, o) === oid) return name;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* pack writing                                                        */
/* ------------------------------------------------------------------ */

const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function encodeEntryHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let b = (type << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  if (remaining > 0) b |= 0x80;
  bytes.push(b);
  while (remaining > 0) {
    let nb = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) nb |= 0x80;
    bytes.push(nb);
  }
  return Buffer.from(bytes);
}

/** Plain (non-delta) pack: PACK + version 2 + count + entries + SHA-1 trailer. */
function buildPack(repo: Repo, oids: string[]): Buffer {
  const sorted = [...oids].sort();
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  const parts: Buffer[] = [header];
  for (const oid of sorted) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    parts.push(encodeEntryHeader(TYPE_NUM[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Frame pack bytes as sideband band-1 pkt-lines (never zero packets). */
function sidebandChunks(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < pack.length; i += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(i, Math.min(i + SIDEBAND_CHUNK, pack.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (out.length === 0) {
    // A pack is at least 32 bytes, so this is unreachable in practice, but
    // the packfile section must never carry zero sideband packets.
    out.push(pktLine(Buffer.from([1])));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* protocol v2: ls-refs / fetch                                        */
/* ------------------------------------------------------------------ */

function lsRefsV2(store: Store, repo: Repo, args: string[]): Buffer {
  let peel = true;
  let symrefs = true;
  let unborn = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === 'peel') peel = true;
    else if (a === 'no-peel') peel = false;
    else if (a === 'symrefs') symrefs = true;
    else if (a === 'no-symrefs') symrefs = false;
    else if (a === 'unborn') unborn = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
    // ref-pattern and anything else: not filtered server-side here.
  }
  const matchPrefix = (ref: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));

  const lines: string[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (matchPrefix('HEAD')) {
    if (headOid !== undefined) {
      let line = `${headOid} HEAD`;
      if (symrefs) line += ` symref-target:${target}`;
      if (peel) {
        const p = peeledOid(store, repo, headOid);
        if (p !== null) line += ` peeled:${p}`;
      }
      lines.push(`${line}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:${target}\n`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matchPrefix(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const p = peeledOid(store, repo, oid);
      if (p !== null) line += ` peeled:${p}`;
    }
    lines.push(`${line}\n`);
  }
  const parts = lines.map((l) => pktLine(l));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallows: string[];
  deepen: number | null;
  done: boolean;
  wantRefs: string[];
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallows: [], deepen: null, done: false, wantRefs: [] };
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0];
      if (isHex40(oid)) args.wants.push(oid);
    } else if (line.startsWith('want-ref ')) {
      const ref = line.slice(9).trim();
      if (ref.length > 0) args.wantRefs.push(ref);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).split(' ')[0];
      if (isHex40(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isHex40(oid)) args.shallows.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.deepen = n;
    } else if (line === 'done') {
      args.done = true;
    }
    // filter / object-format / agent: accepted, no action needed.
  }
  return args;
}

/**
 * Protocol v2 fetch response.
 *
 * Wire shape (gitprotocol-v2): sections are `PKT-LINE(header) *content`
 * terminated by a delim packet, except the packfile section, whose sideband
 * data begins immediately after its header and runs to the final flush.
 * When the client sent `done`, the acknowledgments section MUST be omitted
 * (the client goes straight to the packfile). Without `done` the response
 * is a negotiation-only reply: acknowledgments, then flush.
 */
function fetchResponseV2(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];

  if (!args.done) {
    // Negotiation round only: acks, then flush (no packfile yet).
    parts.push(pktLine('acknowledgments\n'));
    const common = args.haves.filter((h) => args.wants.includes(h));
    if (common.length > 0) {
      for (const o of common) parts.push(pktLine(`ACK ${o}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }

  const sel = selectObjects(store, repo, args.wants, args.haves, args.deepen, args.shallows);

  // shallow-info section (header, lines, delim).
  parts.push(pktLine('shallow-info\n'));
  for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of args.shallows) {
    // Client-declared shallow commits now fully included. The commit itself
    // may be held already (it is a want/have), so involvement — not
    // membership in the pack — is the gate; its parents being delivered
    // is what makes it unshallow.
    if (!sel.objects.includes(s) && !args.wants.includes(s) && !args.haves.includes(s)) continue;
    const obj = repo.objects.get(s);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((p) => sel.objects.includes(p))) {
      parts.push(pktLine(`unshallow ${s}\n`));
    }
  }
  parts.push(DELIM);

  // wanted-refs section (header, lines, delim).
  parts.push(pktLine('wanted-refs\n'));
  const seenRefs = new Set<string>();
  for (const ref of args.wantRefs) {
    const oid = repo.refs.get(ref);
    if (oid !== undefined && !seenRefs.has(ref)) {
      seenRefs.add(ref);
      parts.push(pktLine(`${oid} ${ref}\n`));
    }
  }
  for (const w of args.wants) {
    const ref = refForOid(store, repo, w);
    if (ref !== undefined && !seenRefs.has(ref)) {
      seenRefs.add(ref);
      parts.push(pktLine(`${w} ${ref}\n`));
    }
  }
  parts.push(DELIM);

  // packfile section: header, then sideband data immediately, then flush.
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandChunks(buildPack(repo, sel.objects)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function uploadPackV2(store: Store, repo: Repo, body: Buffer): GitResponse {
  const ct = 'application/x-git-upload-pack-result';
  const parsed = parsePktLines(body);
  if (!parsed.ok) return badRequestText('malformed pkt-line stream');
  const dataLines = parsed.lines
    .filter((l) => l.kind === 'data')
    .map((l) => stripEol(l.text));
  const first = dataLines[0] ?? '';
  if (first === 'command=ls-refs') {
    return { status: 200, headers: { 'Content-Type': ct }, body: lsRefsV2(store, repo, dataLines.slice(1)) };
  }
  if (first === 'command=fetch') {
    const args = parseFetchArgs(dataLines.slice(1));
    return { status: 200, headers: { 'Content-Type': ct }, body: fetchResponseV2(store, repo, args) };
  }
  return badRequestText('unknown command');
}

/* ------------------------------------------------------------------ */
/* protocol v0: upload-pack                                            */
/* ------------------------------------------------------------------ */

function uploadPackV0(store: Store, repo: Repo, body: Buffer): GitResponse {
  // Parse every pkt-line in the body, across flush boundaries: the v0
  // request is wants (+ deepen/shallow), flush, then haves + "done", and a
  // client may put "done" after the first flush (or omit it for a
  // negotiation round).
  const dataLines: string[] = [];
  let offset = 0;
  let ok = true;
  while (offset < body.length) {
    const parsed = parsePktLines(body, offset);
    for (const l of parsed.lines) {
      if (l.kind === 'data') dataLines.push(stripEol(l.text));
    }
    if (!parsed.ok) {
      ok = false;
      break;
    }
    offset = parsed.offset;
  }
  if (!ok && dataLines.length === 0) return badRequestText('malformed pkt-line stream');
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let deepen: number | null = null;
  let done = false;
  for (const text of dataLines) {
    if (text.startsWith('want ')) {
      const oid = text.slice(5).split(' ')[0];
      if (isHex40(oid)) wants.push(oid);
    } else if (text.startsWith('have ')) {
      const oid = text.slice(5).split(' ')[0];
      if (isHex40(oid)) haves.push(oid);
    } else if (text.startsWith('shallow ')) {
      const oid = text.slice(8).trim();
      if (isHex40(oid)) shallows.push(oid);
    } else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n)) deepen = n;
    } else if (text === 'done') {
      done = true;
    }
    // Capabilities on the first want line: no action needed.
  }

  const sel = selectObjects(store, repo, wants, haves, deepen, shallows);
  const shallowLines: string[] = sel.shallow.map((s) => `shallow ${s}`);
  // Client-declared shallow commits that are now fully included.
  for (const s of shallows) {
    if (!sel.objects.includes(s) && !wants.includes(s) && !haves.includes(s)) continue;
    const obj = repo.objects.get(s);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((p) => sel.objects.includes(p))) {
      shallowLines.push(`unshallow ${s}`);
    }
  }

  if (!done) {
    // Negotiation round: the client has not said "done" yet.
    // With a deepen request the server answers with just the shallow
    // section (shallow lines, no trailing LF — matching real git — then
    // flush) and the client follows up with "done". Without one there is
    // nothing to answer yet; real git sends an empty response here.
    if (shallowLines.length === 0) {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
        body: Buffer.alloc(0),
      };
    }
    const parts = shallowLines.map((l) => pktLine(l));
    parts.push(FLUSH);
    return {
      status: 200,
      headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
      body: Buffer.concat(parts),
    };
  }

  const parts: Buffer[] = [];
  // Shallow section first (real git: shallow lines without trailing LF,
  // terminated by a flush), then ACK/NAK, then the pack.
  if (shallowLines.length > 0) {
    for (const l of shallowLines) parts.push(pktLine(l));
    parts.push(FLUSH);
  }
  const common = haves.filter((h) => wants.includes(h));
  if (common.length > 0) {
    for (const o of common) parts.push(pktLine(`ACK ${o}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(...sidebandChunks(buildPack(repo, sel.objects)));
  parts.push(FLUSH);
  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
    body: Buffer.concat(parts),
  };
}

/* ------------------------------------------------------------------ */
/* pack reading (receive-pack)                                         */
/* ------------------------------------------------------------------ */

/**
 * Inflate one zlib stream starting at `offset`. inflateSync ignores trailing
 * bytes, so the exact stream end is found by exponential search for the
 * first succeeding end, then binary search for the smallest succeeding end
 * (success is monotone: a truncated stream throws, a complete-or-longer
 * slice succeeds).
 */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; nextOffset: number } {
  const tryInflate = (end: number): Buffer | null => {
    try {
      return inflateSync(buf.subarray(offset, end));
    } catch {
      return null;
    }
  };
  let lo = offset;
  let step = 1;
  let hi = -1;
  for (;;) {
    const end = Math.min(offset + step, buf.length);
    if (tryInflate(end) !== null) {
      hi = end;
      break;
    }
    lo = end;
    if (end === buf.length) throw new Error('corrupt zlib stream');
    step *= 2;
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tryInflate(mid) !== null) hi = mid;
    else lo = mid;
  }
  const data = tryInflate(hi);
  if (data === null) throw new Error('corrupt zlib stream');
  return { data, nextOffset: hi };
}

/** Apply a git delta instruction stream to a base object. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    let b = 0;
    do {
      if (p >= delta.length) throw new Error('truncated delta');
      b = delta[p++];
      value += (b & 0x7f) * Math.pow(2, shift);
      shift += 7;
    } while (b & 0x80);
    return value;
  };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff += delta[p++];
      if (op & 0x02) cpOff += delta[p++] * 256;
      if (op & 0x04) cpOff += delta[p++] * 65536;
      if (op & 0x08) cpOff += delta[p++] * 16777216;
      if (op & 0x10) cpSize += delta[p++];
      if (op & 0x20) cpSize += delta[p++] * 256;
      if (op & 0x40) cpSize += delta[p++] * 65536;
      if (cpSize === 0) cpSize = 0x10000;
      if (cpOff + cpSize > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(cpOff, cpOff + cpSize));
    } else if (op !== 0) {
      const len = op & 0x7f;
      if (p + len > delta.length) throw new Error('truncated delta');
      out.push(delta.subarray(p, p + len));
      p += len;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== tgtSize) throw new Error('delta target size mismatch');
  return result;
}

interface ParsedPack {
  objects: Map<string, { type: ObjType; data: Buffer }>;
  error?: string;
}

function parsePack(repo: Repo, buf: Buffer): ParsedPack {
  const objects = new Map<string, { type: ObjType; data: Buffer }>();
  try {
    if (buf.length < 32) throw new Error('short packfile');
    if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
    const version = buf.readUInt32BE(4);
    if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
    const count = buf.readUInt32BE(8);
    const trailer = buf.subarray(buf.length - 20);
    const expect = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
    if (!trailer.equals(expect)) throw new Error('pack checksum mismatch');

    const limit = buf.length - 20;
    const TYPE_NAMES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
    interface RawEntry {
      offset: number;
      typeNum: number;
      size: number;
      baseOffset: number;
      baseOid: string;
      data: Buffer;
      resolved?: { type: ObjType; data: Buffer };
    }
    const entries: RawEntry[] = [];
    const byOffset = new Map<number, RawEntry>();
    let offset = 12;
    for (let i = 0; i < count; i += 1) {
      if (offset >= limit) throw new Error('truncated packfile');
      const entryOffset = offset;
      let b = buf[offset++];
      const typeNum = (b >> 4) & 0x7;
      let size = b & 0x0f;
      let shift = 4;
      while (b & 0x80) {
        if (offset >= limit) throw new Error('truncated packfile');
        b = buf[offset++];
        size += (b & 0x7f) * Math.pow(2, shift);
        shift += 7;
      }
      let baseOffset = -1;
      let baseOid = '';
      if (typeNum === 6) {
        // OFS_DELTA: negative-offset varint.
        if (offset >= limit) throw new Error('truncated packfile');
        let b2 = buf[offset++];
        let value = b2 & 0x7f;
        while (b2 & 0x80) {
          if (offset >= limit) throw new Error('truncated packfile');
          b2 = buf[offset++];
          value = (value + 1) * 128 + (b2 & 0x7f);
        }
        baseOffset = entryOffset - value;
      } else if (typeNum === 7) {
        // REF_DELTA: 20-byte base oid.
        if (offset + 20 > limit) throw new Error('truncated packfile');
        baseOid = buf.subarray(offset, offset + 20).toString('hex');
        offset += 20;
      } else if (typeNum < 1 || typeNum > 4) {
        throw new Error('unknown pack entry type');
      }
      const inf = inflateAt(buf, offset);
      if (inf.data.length !== size) throw new Error('object size mismatch');
      offset = inf.nextOffset;
      const entry: RawEntry = { offset: entryOffset, typeNum, size, baseOffset, baseOid, data: inf.data };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
    }

    const resolve = (
      entry: RawEntry,
      seen: Set<number>,
    ): { type: ObjType; data: Buffer } => {
      if (entry.resolved) return entry.resolved;
      if (seen.has(entry.offset)) throw new Error('delta cycle');
      seen.add(entry.offset);
      let result: { type: ObjType; data: Buffer };
      if (entry.typeNum >= 1 && entry.typeNum <= 4) {
        result = { type: TYPE_NAMES[entry.typeNum], data: entry.data };
      } else if (entry.typeNum === 6) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (!baseEntry) throw new Error('delta base not found');
        const base = resolve(baseEntry, seen);
        result = { type: base.type, data: applyDelta(base.data, entry.data) };
      } else {
        // REF_DELTA: base may already be in the repo, or elsewhere in the pack.
        const inRepo = repo.objects.get(entry.baseOid);
        let base: { type: ObjType; data: Buffer } | undefined = inRepo
          ? { type: inRepo.type, data: inRepo.data }
          : undefined;
        if (!base) {
          for (const e of entries) {
            if (e === entry) continue;
            const r = resolve(e, new Set(seen));
            if (objectId(r.type, r.data) === entry.baseOid) {
              base = r;
              break;
            }
          }
        }
        if (!base) throw new Error('delta base not found');
        result = { type: base.type, data: applyDelta(base.data, entry.data) };
      }
      entry.resolved = result;
      return result;
    };

    for (const e of entries) {
      const r = resolve(e, new Set<number>());
      const oid = objectId(r.type, r.data);
      if (!objects.has(oid)) objects.set(oid, r);
    }
    return { objects };
  } catch (err) {
    return { objects: new Map(), error: err instanceof Error ? err.message : 'bad packfile' };
  }
}

/* ------------------------------------------------------------------ */
/* receive-pack                                                        */
/* ------------------------------------------------------------------ */

interface RefCommand {
  old: string;
  new: string;
  ref: string;
}

interface RefResult {
  ref: string;
  ok: boolean;
  reason: string;
}

function reportResponse(
  sideband: boolean,
  unpackDetail: string | null,
  results: RefResult[],
): GitResponse {
  const lines: string[] = [];
  lines.push(unpackDetail ? `unpack ${unpackDetail}\n` : 'unpack ok\n');
  for (const r of results) {
    lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  const parts: Buffer[] = [];
  if (sideband) {
    // The report lines are first framed as plain pkt-lines (terminated by
    // an inner flush), and that whole byte stream is then carried in
    // sideband band-1 packets: the demultiplexer strips the band byte and
    // hands the inner pkt-line stream to the reader verbatim. Wrapping
    // each line in its own sideband packet would deliver unframed text.
    const inner = Buffer.concat([...lines.map((l) => pktLine(l)), FLUSH]);
    for (let i = 0; i < inner.length; i += SIDEBAND_CHUNK) {
      parts.push(
        pktLine(
          Buffer.concat([Buffer.from([1]), inner.subarray(i, Math.min(i + SIDEBAND_CHUNK, inner.length))]),
        ),
      );
    }
  } else {
    for (const l of lines) parts.push(pktLine(l));
  }
  parts.push(FLUSH);
  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-receive-pack-result' },
    body: Buffer.concat(parts),
  };
}

function applyCommand(store: Store, repo: Repo, c: RefCommand): RefResult {
  const { old, new: nw, ref } = c;
  if (!ref.startsWith('refs/') || ref.length > 200) {
    return { ref, ok: false, reason: 'invalid ref' };
  }
  const current = repo.refs.get(ref);
  if (nw === ZERO_OID) {
    // Delete.
    if (old === ZERO_OID) return { ref, ok: false, reason: 'invalid old value' };
    if (current === undefined || current !== old) {
      return { ref, ok: false, reason: 'non-fast-forward' };
    }
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }
  if (old === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ref, ok: false, reason: 'already exists' };
    if (!repo.objects.has(nw)) return { ref, ok: false, reason: 'object not found' };
    repo.refs.set(ref, nw);
    return { ref, ok: true, reason: '' };
  }
  // Update: old must equal the current tip and new must descend from old.
  if (current === undefined || current !== old) {
    return { ref, ok: false, reason: 'non-fast-forward' };
  }
  if (!repo.objects.has(nw)) return { ref, ok: false, reason: 'object not found' };
  const oldCommit = store.peel(repo, old);
  const newCommit = store.peel(repo, nw);
  if (!store.isAncestor(repo, oldCommit, newCommit)) {
    return { ref, ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, nw);
  return { ref, ok: true, reason: '' };
}

function receivePack(store: Store, repo: Repo, body: Buffer): GitResponse {
  const parsed = parsePktLines(body);
  if (!parsed.ok) {
    return reportResponse(false, 'bad request', []);
  }
  const commands: RefCommand[] = [];
  let sideband = false;
  const dataLines = parsed.lines.filter((l) => l.kind === 'data');
  for (let i = 0; i < dataLines.length; i += 1) {
    let text = stripEol(dataLines[i].text);
    let caps: string | null = null;
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      caps = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    if (i === 0 && caps !== null) {
      sideband = caps.split(' ').includes('side-band-64k');
    }
    const parts = text.split(' ');
    if (parts.length !== 3 || !isHex40(parts[0]) || !isHex40(parts[1])) {
      return reportResponse(false, 'bad request', []);
    }
    commands.push({ old: parts[0], new: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) {
    return reportResponse(false, 'bad request', []);
  }

  const needsPack = commands.some((c) => c.new !== ZERO_OID);
  const packBytes = body.subarray(parsed.offset);
  let packError: string | null = null;
  let newObjects: Map<string, { type: ObjType; data: Buffer }> | null = null;
  if (needsPack) {
    if (packBytes.length === 0) {
      packError = 'missing packfile';
    } else {
      const res = parsePack(repo, packBytes);
      if (res.error) packError = res.error;
      else newObjects = res.objects;
    }
  }

  if (packError !== null) {
    const results: RefResult[] = commands.map((c) => ({
      ref: c.ref,
      ok: false,
      reason: 'unpack failed',
    }));
    return reportResponse(sideband, packError, results);
  }

  // Store objects verbatim (objectId recomputed from the exact bytes).
  if (newObjects) {
    for (const o of newObjects.values()) store.putObject(repo, o.type, o.data);
  }

  const results: RefResult[] = [];
  for (const c of commands) results.push(applyCommand(store, repo, c));
  return reportResponse(sideband, null, results);
}
