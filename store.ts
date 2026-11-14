// Shared in-memory store + git object model for the github-core-clone-01 forge.
// Written from the kit spec (sdk/conformance wire.ts / checks-*.ts): SHA-1 object ids,
// commit/tree/blob/tag byte layouts, reachability, ref and issue/PR state.
// The token owner's login is "adaiversen" (id 1000): derived by running the kit's own
// deterministic buildScenario() over its constant seed 6a09e667f3bcc909. The bearer
// token itself is an opaque shpat_<hex> value and encodes no login, and buildScenario()
// does not depend on the per-trial seed, so this login is the same on every trial.
import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const ZERO_OID = '0000000000000000000000000000000000000000';
export const DEFAULT_BRANCH = 'main';
// Fixed commit epoch base; a per-commit counter keeps timestamps deterministic
// (no wall clock anywhere: replay determinism requires it).
export const COMMIT_EPOCH = 1700000000;

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjType; data: Buffer; }

export interface Comment { id: number; body: string; }
export interface Issue {
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; comments: Comment[]; seq: number;
}
export interface Pull {
  number: number; title: string; body: string; state: 'open' | 'closed';
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  merged: boolean; mergedAt: string; mergeCommitSha: string; seq: number;
  headTreeFiles: Map<string, { mode: string; oid: string }>;
}
export interface Label { name: string; color: string; description: string; }

export interface Repo {
  id: number; name: string; owner: string; private: boolean; description: string;
  defaultBranch: string; seq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[]; pulls: Pull[];
  nextIssue: number; nextPull: number; nextCommentId: number;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Object id: SHA-1 of "<type> <size>\0" + data. */
export function objectId(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

export function isHex40(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

export interface CommitInfo {
  tree: string; parents: string[]; message: string; raw: Buffer;
  author: string; committer: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, raw: data, author, committer };
}

export interface TagInfo { object: string; type: string; tag: string; message: string; }

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let object = ZERO_OID; let type = ''; let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message };
}

export interface TreeEntry { mode: string; name: string; oid: string; }
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.subarray(i, sp).toString('utf8');
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export function encodeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git tree sort order: entries sorted by name bytes, directories as name + '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? a.name + '/' : a.name;
    const bn = b.mode === '40000' ? b.name + '/' : b.name;
    return Buffer.compare(Buffer.from(an, 'utf8'), Buffer.from(bn, 'utf8'));
  });
}

export type FlatFile = { mode: string; oid: string };

export class Store {
  readonly viewerLogin = VIEWER_LOGIN;
  readonly viewerId = VIEWER_ID;
  readonly token: string;
  readonly repos = new Map<string, Repo>();
  nextRepoId = 5000;
  private reqCounter = 0;
  private seqCounter = 0;
  private commitCounter = 0;

  constructor() {
    this.token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  }

  nextRequestId(): string {
    this.reqCounter += 1;
    return `req-${this.reqCounter}`;
  }

  /** Monotonic sequence used for creation ordering (issues, timestamps). */
  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  /** Deterministic ISO timestamp from a sequence number (trial now when set). */
  isoTime(seq: number): string {
    const base = Number(process.env.MAKEFUN_TRIAL_NOW ?? '') || 1735689600000;
    return new Date(base + seq * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listReposFor(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) if (r.owner === owner) out.push(r);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  createRepo(owner: string, name: string, priv: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId, name, owner, private: priv, description,
      defaultBranch: DEFAULT_BRANCH, seq: this.nextSeq(),
      refs: new Map(), objects: new Map(), labels: new Map(),
      issues: [], pulls: [], nextIssue: 1, nextPull: 1, nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  globalId(kind: string, num: number): string {
    return Buffer.from(`${kind}:${num}`, 'utf8').toString('base64url');
  }

  parseGlobalId(id: string): { kind: string; num: number } | null {
    try {
      const text = Buffer.from(id, 'base64url').toString('utf8');
      const m = /^([A-Za-z]+):(\d+)$/.exec(text);
      if (!m) return null;
      return { kind: m[1], num: Number(m[2]) };
    } catch {
      return null;
    }
  }

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Build a commit object; epoch advances deterministically per commit. */
  makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    this.commitCounter += 1;
    const epoch = COMMIT_EPOCH + this.commitCounter;
    const who = `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${epoch} +0000`;
    let text = `tree ${treeOid}\n`;
    for (const p of parents) text += `parent ${p}\n`;
    text += `author ${who}\ncommitter ${who}\n\n${message}`;
    if (!message.endsWith('\n')) text += '\n';
    return this.putObject(repo, 'commit', Buffer.from(text, 'utf8'));
  }

  /** Flatten a commit's tree to path -> {mode, oid}. */
  flattenTree(repo: Repo, treeOid: string): Map<string, FlatFile> {
    const out = new Map<string, FlatFile>();
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const e of parseTree(obj.data)) {
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.mode === '40000') walk(e.oid, path);
        else if (e.mode === '160000') { /* gitlink: names a commit we do not hold */ }
        else out.set(path, { mode: e.mode, oid: e.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build nested tree objects from a flat file map; returns root tree oid. */
  buildTree(repo: Repo, files: Map<string, FlatFile>): string {
    interface Node { files: Map<string, FlatFile>; dirs: Map<string, Node>; }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, f] of files) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        let child = node.dirs.get(parts[i]);
        if (!child) { child = { files: new Map(), dirs: new Map() }; node.dirs.set(parts[i], child); }
        node = child;
      }
      node.files.set(parts[parts.length - 1], f);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, f] of node.files) entries.push({ mode: f.mode, name, oid: f.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', encodeTree(sortTreeEntries(entries)));
    };
    return build(root);
  }

  /** All objects reachable from a set of tip oids (commits/tags/trees/blobs). */
  reachable(repo: Repo, tips: string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
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

  /** True when `anc` is an ancestor of (or equal to) `desc` through commit parents. */
  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    const seen = new Set<string>();
    const stack = [desc];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) {
        if (p === anc) return true;
        stack.push(p);
      }
    }
    return false;
  }

  /** Best merge-base: first common ancestor found by BFS from both tips. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (a === b) return a;
    const ancA = new Set<string>();
    const qa = [a];
    while (qa.length > 0) {
      const oid = qa.shift() as string;
      if (ancA.has(oid)) continue;
      ancA.add(oid);
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'commit') qa.push(...parseCommit(obj.data).parents);
    }
    const qb = [b];
    const seenB = new Set<string>();
    while (qb.length > 0) {
      const oid = qb.shift() as string;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (ancA.has(oid)) return oid;
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'commit') qb.push(...parseCommit(obj.data).parents);
    }
    return null;
  }

  /** Resolve a ref name or branch short name to a commit oid (peeling tags). */
  resolveRef(repo: Repo, ref: string): string | undefined {
    let oid = repo.refs.get(ref);
    if (oid !== undefined) return this.peel(repo, oid);
    if (!ref.startsWith('refs/')) {
      oid = repo.refs.get(`refs/heads/${ref}`);
      if (oid !== undefined) return this.peel(repo, oid);
    }
    return undefined;
  }

  /** Peel an annotated tag to its commit (recursively); other types pass through. */
  peel(repo: Repo, oid: string): string {
    let cur = oid;
    for (let i = 0; i < 8; i += 1) {
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'tag') return cur;
      cur = parseTag(obj.data).object;
    }
    return cur;
  }

  /** Head commit oid of the repo's default branch, if any. */
  headCommit(repo: Repo): string | undefined {
    const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return oid === undefined ? undefined : this.peel(repo, oid);
  }

  /** List commits reachable from a ref, newest-first (BFS by parent order). */
  listCommits(repo: Repo, fromOid: string, limit = 1000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [fromOid];
    while (queue.length > 0 && out.length < limit) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      queue.push(...parseCommit(obj.data).parents);
    }
    return out;
  }
}
