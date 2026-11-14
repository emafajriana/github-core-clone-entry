// REST v3 module for the github-core-clone-01 forge.
// Implements the GitHub REST API surface from the module spec, backed by the
// shared in-memory Store in ./store.ts. Deterministic: no wall clock, no
// randomness — every timestamp comes from store.isoTime().
import { Store, ZERO_OID, isHex40, parseCommit, parseTree, VIEWER_LOGIN, VIEWER_EMAIL, VIEWER_ID } from './store.ts';
import type { Repo } from './store.ts';

export interface RestResponse { status: number; headers: Record<string, string>; body: Buffer; }

type JsonObj = Record<string, unknown>;

// ---------------------------------------------------------------- helpers

function json(status: number, obj: unknown, extraHeaders?: Record<string, string>): RestResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(extraHeaders ?? {}) },
    body: Buffer.from(JSON.stringify(obj), 'utf8'),
  };
}

function err(status: number, message: string): RestResponse {
  return json(status, { message });
}

function headerValue(headers: Record<string, string | undefined>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

function decodeSeg(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function parsePagination(search: URLSearchParams): { page: number; perPage: number } {
  let page = Number.parseInt(search.get('page') ?? '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  let perPage = Number.parseInt(search.get('per_page') ?? '30', 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  return { page, perPage };
}

function pageUrl(host: string, pathname: string, search: URLSearchParams, page: number, perPage: number): string {
  const q = new URLSearchParams(search);
  q.set('page', String(page));
  q.set('per_page', String(perPage));
  const qs = q.toString();
  return `http://${host}${pathname}${qs ? `?${qs}` : ''}`;
}

/** GitHub-style Link header; undefined when everything fits on one page. */
function linkHeader(host: string, pathname: string, search: URLSearchParams, page: number, perPage: number, total: number): string | undefined {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return undefined;
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${pageUrl(host, pathname, search, page + 1, perPage)}>; rel="next"`);
  if (page > 1) parts.push(`<${pageUrl(host, pathname, search, page - 1, perPage)}>; rel="prev"`);
  parts.push(`<${pageUrl(host, pathname, search, 1, perPage)}>; rel="first"`);
  parts.push(`<${pageUrl(host, pathname, search, totalPages, perPage)}>; rel="last"`);
  return parts.join(', ');
}

function paginate<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function isValidRepoName(name: unknown): name is string {
  return typeof name === 'string' && name.length >= 1 && name.length <= 100 &&
    /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}

// ---------------------------------------------------------------- serializers

function repoJson(store: Store, repo: Repo): JsonObj {
  const openIssues = repo.issues.filter((i) => i.state === 'open').length +
    repo.pulls.filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: store.globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: {
      login: repo.owner,
      id: repo.owner === store.viewerLogin ? store.viewerId : repo.id,
      type: 'User',
    },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: store.isoTime(repo.seq),
    updated_at: store.isoTime(repo.seq),
    pushed_at: store.isoTime(repo.seq),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

function issueJson(store: Store, repo: Repo, issue: Repo['issues'][number]): JsonObj {
  const id = repo.id * 100000 + issue.number;
  return {
    id,
    node_id: store.globalId('Issue', id),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: store.viewerLogin },
    created_at: store.isoTime(issue.seq),
    updated_at: store.isoTime(issue.seq),
    comments: issue.comments.length,
    html_url: '',
  };
}

function liveSha(store: Store, repo: Repo, ref: string, fallback: string): string {
  return store.resolveRef(repo, `refs/heads/${ref}`) ?? fallback;
}

function pullJson(store: Store, repo: Repo, pull: Repo['pulls'][number]): JsonObj {
  const id = repo.id * 100000 + pull.number;
  return {
    id,
    node_id: store.globalId('PullRequest', id),
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? (pull.mergedAt || store.isoTime(pull.seq)) : null,
    merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
    head: {
      ref: pull.headRef,
      sha: liveSha(store, repo, pull.headRef, pull.headSha),
      label: `${store.viewerLogin}:${pull.headRef}`,
      user: { login: store.viewerLogin },
    },
    base: {
      ref: pull.baseRef,
      sha: liveSha(store, repo, pull.baseRef, pull.baseSha),
      label: `${store.viewerLogin}:${pull.baseRef}`,
      user: { login: store.viewerLogin },
    },
    user: { login: store.viewerLogin },
    created_at: store.isoTime(pull.seq),
    updated_at: store.isoTime(pull.seq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------- repo lookup

/** A repo is only visible under its real owner; anything else is a 404. */
function lookupRepo(store: Store, owner: string, name: string): Repo | null {
  if (!name || name.length > 100) return null;
  return store.getRepo(owner, name) ?? null;
}

function parseAuthorLine(line: string): { name: string; email: string } {
  const m = /^(.+?) <([^>]*)> \d+ [+-]\d{4}$/.exec(line.trim());
  if (m) return { name: m[1], email: m[2] };
  return { name: VIEWER_LOGIN, email: VIEWER_EMAIL };
}

/** Resolve a user-supplied ref (branch, full ref, tag, or commit sha) to a commit oid. */
function resolveCommitRef(store: Store, repo: Repo, ref: string): string | undefined {
  let oid = store.resolveRef(repo, ref);
  if (oid !== undefined) return oid;
  oid = store.resolveRef(repo, `refs/tags/${ref}`);
  if (oid !== undefined) return oid;
  if (isHex40(ref)) {
    const obj = repo.objects.get(ref);
    if (obj && obj.type === 'commit') return ref;
    if (obj) return store.peel(repo, ref);
  }
  return undefined;
}

/** Walk nested trees to the oid of the entry at `path` (file or subtree). */
function treeEntryAt(repo: Repo, rootTreeOid: string, path: string): { mode: string; oid: string } | undefined {
  const parts = path.split('/').filter((p) => p.length > 0);
  let cur = rootTreeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (!entry) return undefined;
    if (i === parts.length - 1) return { mode: entry.mode, oid: entry.oid };
    if (entry.mode !== '40000') return undefined;
    cur = entry.oid;
  }
  return undefined;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) n += 1;
  if (data[data.length - 1] !== 0x0a) n += 1;
  return n;
}

function strictBase64Decode(s: string): Buffer | null {
  const cleaned = s.replace(/\s+/g, '');
  if (cleaned.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return null;
  const buf = Buffer.from(cleaned, 'base64');
  if (buf.toString('base64') !== cleaned) return null;
  return buf;
}

function labelNames(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object' && typeof (item as JsonObj).name === 'string') {
      out.push((item as JsonObj).name as string);
    } else {
      return null;
    }
  }
  return out;
}

// ---------------------------------------------------------------- entry point

export async function handleRest(
  store: Store,
  method: string,
  pathname: string,
  search: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): Promise<RestResponse | null> {
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) return null;

  // Auth: every /api/v3 route requires a Bearer token.
  const auth = headerValue(headers, 'authorization');
  if (store.token) {
    if (auth !== `Bearer ${store.token}`) return err(401, 'Bad credentials');
  } else if (!auth || !auth.startsWith('Bearer ') || auth.slice(7).trim().length === 0) {
    return err(401, 'Bad credentials');
  }

  // Malformed JSON body on a body-bearing method.
  let parsed: JsonObj = {};
  if ((method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') &&
      body && body.length > 0) {
    try {
      const value: unknown = JSON.parse(body.toString('utf8'));
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return err(400, 'Problems parsing JSON');
      }
      parsed = value as JsonObj;
    } catch {
      return err(400, 'Problems parsing JSON');
    }
  }

  const host = headerValue(headers, 'host') ?? 'localhost';
  const rest = pathname.slice('/api/v3'.length);
  const segments = rest.split('/').filter((s) => s.length > 0).map(decodeSeg);

  // ---- GET /api/v3/ -------------------------------------------------------
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // ---- GET /api/v3/meta ---------------------------------------------------
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, {
      verifiable_password_authentication: false,
      github_enterprise_version: '1.0.0',
      installed_version: '1.0.0',
      hooks: ['pre-receive', 'post-receive', 'post-receive-hooks'],
      git: ['1.0.0'],
      github_services_sha: ZERO_OID,
      pages: ['127.0.0.1'],
    });
  }

  // ---- GET /api/v3/rate_limit ---------------------------------------------
  if (segments.length === 1 && segments[0] === 'rate_limit') {
    if (method !== 'GET') return err(404, 'Not Found');
    const base = Number(process.env.MAKEFUN_TRIAL_NOW ?? '') || 1735689600000;
    const reset = Math.floor(base / 1000) + 3600;
    const rate = { limit: 5000, remaining: 4999, reset, used: 1 };
    return json(200, { resources: { core: rate, search: rate, graphql: rate, integration_manifest: rate }, rate });
  }

  // ---- /api/v3/user --------------------------------------------------------
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      return json(200, {
        login: store.viewerLogin,
        id: store.viewerId,
        type: 'User',
        name: store.viewerLogin,
        email: VIEWER_EMAIL,
      });
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        const { page, perPage } = parsePagination(search);
        const all = store.listReposFor(store.viewerLogin);
        const link = linkHeader(host, pathname, search, page, perPage, all.length);
        return json(200, paginate(all, page, perPage).map((r) => repoJson(store, r)),
          link ? { link } : undefined);
      }
      if (method === 'POST') {
        const name = parsed.name;
        if (!isValidRepoName(name)) return err(422, 'Repository name is required and must be valid');
        if (store.getRepo(store.viewerLogin, name)) {
          return err(422, 'Repository already exists');
        }
        const priv = parsed.private === true;
        const description = typeof parsed.description === 'string' ? parsed.description : '';
        const repo = store.createRepo(store.viewerLogin, name, priv, description);
        return json(201, repoJson(store, repo));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // ---- /api/v3/repos/{owner}/{repo}[...] -----------------------------------
  if (segments[0] === 'repos') {
    if (segments.length < 3) return err(404, 'Not Found');
    const owner = segments[1];
    const name = segments[2];
    const repo = lookupRepo(store, owner, name);
    const tail = segments.slice(3);

    // GET / PATCH / DELETE /api/v3/repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') {
        if (!repo) return err(404, 'Not Found');
        return json(200, repoJson(store, repo));
      }
      if (method === 'PATCH') {
        if (!repo) return err(404, 'Not Found');
        if (typeof parsed.description === 'string') repo.description = parsed.description;
        return json(200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        if (!repo) return err(404, 'Not Found');
        store.deleteRepo(owner, name);
        return { status: 204, headers: {}, body: Buffer.alloc(0) };
      }
      return err(404, 'Not Found');
    }

    // Everything below needs an existing repo.
    if (!repo) return err(404, 'Not Found');

    // ---- branches ---------------------------------------------------------
    if (tail[0] === 'branches') {
      if (tail.length === 1) {
        if (method !== 'GET') return err(404, 'Not Found');
        const names: string[] = [];
        for (const key of repo.refs.keys()) {
          if (key.startsWith('refs/heads/')) names.push(key.slice('refs/heads/'.length));
        }
        const def = repo.defaultBranch;
        names.sort((a, b) => {
          if (a === def) return -1;
          if (b === def) return 1;
          return a < b ? -1 : a > b ? 1 : 0;
        });
        return json(200, names.map((n) => ({
          name: n,
          commit: { sha: store.peel(repo, repo.refs.get(`refs/heads/${n}`) as string) },
          protected: false,
        })));
      }
      if (method === 'GET') {
        const branch = tail.slice(1).join('/');
        const oid = repo.refs.get(`refs/heads/${branch}`);
        if (oid === undefined) return err(404, 'Not Found');
        return json(200, { name: branch, commit: { sha: store.peel(repo, oid) }, protected: false });
      }
      return err(404, 'Not Found');
    }

    // ---- commits ----------------------------------------------------------
    if (tail[0] === 'commits' && tail.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      const refParam = search.get('sha');
      const from = refParam ? resolveCommitRef(store, repo, refParam) : store.headCommit(repo);
      if (from === undefined) return err(404, 'Not Found');
      const date = store.isoTime(repo.seq);
      const out = store.listCommits(repo, from).map((sha) => {
        const obj = repo.objects.get(sha);
        const info = obj ? parseCommit(obj.data) : null;
        const message = info ? info.message.replace(/\n+$/, '') : '';
        const author = info ? parseAuthorLine(info.author) : { name: VIEWER_LOGIN, email: VIEWER_EMAIL };
        const committer = info ? parseAuthorLine(info.committer) : { name: VIEWER_LOGIN, email: VIEWER_EMAIL };
        return {
          sha,
          commit: {
            message,
            author: { name: author.name, email: author.email, date },
            committer: { name: committer.name, email: committer.email, date },
          },
          parents: (info ? info.parents : []).map((p) => ({ sha: p })),
          author: { login: store.viewerLogin, id: store.viewerId, type: 'User' },
          committer: { login: store.viewerLogin, id: store.viewerId, type: 'User' },
        };
      });
      return json(200, out);
    }

    // ---- git/refs ---------------------------------------------------------
    if (tail[0] === 'git' && tail[1] === 'refs') {
      const refParts = tail.slice(2);
      if (method === 'POST' && refParts.length === 0) {
        const ref = parsed.ref;
        const sha = parsed.sha;
        if (typeof ref !== 'string' || !ref.startsWith('refs/')) {
          return err(422, 'ref must start with refs/');
        }
        if (typeof sha !== 'string' || !isHex40(sha)) {
          return err(422, 'sha must be a valid object id');
        }
        const obj = repo.objects.get(sha);
        if (!obj) return err(422, 'Object does not exist');
        const peeled = store.peel(repo, sha);
        const peeledObj = repo.objects.get(peeled);
        if (!peeledObj || peeledObj.type !== 'commit') {
          return err(422, 'sha does not point to a commit');
        }
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        return json(201, {
          ref,
          node_id: store.globalId('Ref', repo.id),
          object: { sha: peeled, type: 'commit' },
        });
      }
      if (method === 'GET' && refParts.length > 0) {
        const wanted = refParts.join('/');
        let full = wanted;
        let oid = repo.refs.get(full);
        if (oid === undefined && !wanted.startsWith('refs/')) {
          full = `refs/${wanted}`;
          oid = repo.refs.get(full);
        }
        if (oid === undefined && !wanted.startsWith('refs/')) {
          full = `refs/heads/${wanted}`;
          oid = repo.refs.get(full);
        }
        if (oid === undefined) return err(404, 'Not Found');
        return json(200, { ref: full, object: { sha: store.peel(repo, oid), type: 'commit' } });
      }
      return err(404, 'Not Found');
    }

    // ---- contents ---------------------------------------------------------
    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      if (path.split('/').some((p) => p === '..')) return err(400, 'Invalid path');

      if (method === 'GET') {
        const refParam = search.get('ref');
        const head = refParam ? resolveCommitRef(store, repo, refParam) : store.headCommit(repo);
        if (head === undefined) return err(404, 'Not Found');
        const headObj = repo.objects.get(head);
        if (!headObj || headObj.type !== 'commit') return err(404, 'Not Found');
        const rootTree = parseCommit(headObj.data).tree;
        const flat = store.flattenTree(repo, rootTree);
        if (path === '') {
          return json(200, dirListing(repo, rootTree, flat, ''));
        }
        const file = flat.get(path);
        if (file) {
          const blob = repo.objects.get(file.oid);
          const data = blob ? blob.data : Buffer.alloc(0);
          const base = path.split('/').pop() as string;
          return json(200, {
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name: base,
            path,
            content: data.toString('base64'),
            sha: file.oid,
          });
        }
        const prefix = `${path}/`;
        const under = [...flat.keys()].some((k) => k.startsWith(prefix));
        if (!under) return err(404, 'Not Found');
        return json(200, dirListing(repo, rootTree, flat, path));
      }

      if (method === 'PUT') {
        const message = typeof parsed.message === 'string' ? parsed.message : `Update ${path}`;
        if (typeof parsed.content !== 'string' || parsed.content.length === 0) {
          return err(422, 'content is required');
        }
        const decoded = strictBase64Decode(parsed.content);
        if (decoded === null) return err(400, 'Invalid base64 content');
        const requestedBranch = typeof parsed.branch === 'string' && parsed.branch.length > 0
          ? parsed.branch : repo.defaultBranch;
        const head = store.headCommit(repo);
        if (head !== undefined) {
          if (!repo.refs.has(`refs/heads/${requestedBranch}`)) return err(404, 'Not Found');
        }
        const branch = requestedBranch;
        const branchHead = head === undefined
          ? undefined
          : store.resolveRef(repo, `refs/heads/${branch}`);
        let flat = new Map<string, { mode: string; oid: string }>();
        if (branchHead !== undefined) {
          const headObj = repo.objects.get(branchHead);
          if (headObj && headObj.type === 'commit') {
            flat = store.flattenTree(repo, parseCommit(headObj.data).tree);
          }
        }
        const current = flat.get(path);
        const sha = parsed.sha;
        if (typeof sha === 'string') {
          if (!current || current.oid !== sha) {
            return err(409, 'sha does not match the current blob oid (stale sha)');
          }
        } else if (current) {
          return err(422, 'File already exists; provide the current sha to update it');
        }
        const blobOid = store.putObject(repo, 'blob', decoded);
        const next = new Map(flat);
        next.set(path, { mode: '100644', oid: blobOid });
        const treeOid = store.buildTree(repo, next);
        const parents = branchHead !== undefined ? [branchHead] : [];
        const commitOid = store.makeCommit(repo, treeOid, parents, message);
        repo.refs.set(`refs/heads/${branch}`, commitOid);
        if (head === undefined && branch !== repo.defaultBranch) repo.defaultBranch = branch;
        const base = path.split('/').pop() as string;
        return json(current ? 200 : 201, {
          content: {
            name: base,
            path,
            sha: blobOid,
            size: decoded.length,
            type: 'file',
            encoding: 'base64',
            content: decoded.toString('base64'),
          },
          commit: { sha: commitOid, message },
        });
      }

      if (method === 'DELETE') {
        const sha = parsed.sha;
        if (typeof sha !== 'string' || sha.length === 0) {
          return err(422, 'sha is required');
        }
        const message = typeof parsed.message === 'string' ? parsed.message : `Delete ${path}`;
        const requestedBranch = typeof parsed.branch === 'string' && parsed.branch.length > 0
          ? parsed.branch : repo.defaultBranch;
        const branchHead = store.resolveRef(repo, `refs/heads/${requestedBranch}`);
        if (branchHead === undefined) return err(404, 'Not Found');
        const headObj = repo.objects.get(branchHead);
        if (!headObj || headObj.type !== 'commit') return err(404, 'Not Found');
        const flat = store.flattenTree(repo, parseCommit(headObj.data).tree);
        const current = flat.get(path);
        if (!current) return err(404, 'Not Found');
        if (current.oid !== sha) {
          return err(409, 'sha does not match the current blob oid (stale sha)');
        }
        const next = new Map(flat);
        next.delete(path);
        const treeOid = store.buildTree(repo, next);
        const commitOid = store.makeCommit(repo, treeOid, [branchHead], message);
        repo.refs.set(`refs/heads/${requestedBranch}`, commitOid);
        return json(200, { content: null, commit: { sha: commitOid, message } });
      }
      return err(404, 'Not Found');
    }

    // ---- labels -----------------------------------------------------------
    if (tail[0] === 'labels' && tail.length === 1) {
      if (method === 'GET') {
        return json(200, [...repo.labels.values()].map((l, i) => ({
          id: repo.id * 100000 + i + 1,
          node_id: store.globalId('Label', repo.id * 100000 + i + 1),
          name: l.name,
          color: l.color,
          description: l.description,
        })));
      }
      if (method === 'POST') {
        const name = parsed.name;
        if (typeof name !== 'string' || name.length === 0) {
          return err(422, 'Label name is required');
        }
        const existing = repo.labels.get(name);
        if (existing) {
          return json(200, { name: existing.name, color: existing.color, description: existing.description });
        }
        const color = typeof parsed.color === 'string' && parsed.color.length > 0 ? parsed.color : 'ededed';
        const description = typeof parsed.description === 'string' ? parsed.description : '';
        repo.labels.set(name, { name, color, description });
        return json(201, { name, color, description });
      }
      return err(404, 'Not Found');
    }

    // ---- issues -----------------------------------------------------------
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = search.get('state') ?? 'open';
          const { page, perPage } = parsePagination(search);
          let list = [...repo.issues];
          if (state === 'open') list = list.filter((i) => i.state === 'open');
          else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
          else if (state !== 'all') list = list.filter((i) => i.state === 'open');
          if (search.get('direction') === 'desc') list = [...list].reverse();
          const link = linkHeader(host, pathname, search, page, perPage, list.length);
          return json(200, paginate(list, page, perPage).map((i) => issueJson(store, repo, i)),
            link ? { link } : undefined);
        }
        if (method === 'POST') {
          const title = parsed.title;
          if (typeof title !== 'string' || title.length === 0) {
            return err(422, 'title is required');
          }
          let labels: string[] = [];
          if (parsed.labels !== undefined) {
            const names = labelNames(parsed.labels);
            if (names === null) return err(422, 'labels must be an array of label names');
            for (const n of names) {
              if (!repo.labels.has(n)) return err(422, `Label ${n} does not exist`);
            }
            labels = names;
          }
          const issue: Repo['issues'][number] = {
            number: repo.nextIssue,
            title,
            body: typeof parsed.body === 'string' ? parsed.body : '',
            state: 'open',
            labels,
            comments: [],
            seq: store.nextSeq(),
          };
          repo.nextIssue += 1;
          repo.issues.push(issue);
          return json(201, issueJson(store, repo, issue));
        }
        return err(404, 'Not Found');
      }

      const num = Number.parseInt(tail[1], 10);
      if (!Number.isInteger(num)) return err(404, 'Not Found');
      const issue = repo.issues.find((i) => i.number === num);

      if (tail.length === 2) {
        if (method === 'GET') {
          if (!issue) return err(404, 'Not Found');
          return json(200, issueJson(store, repo, issue));
        }
        if (method === 'PATCH') {
          if (!issue) return err(404, 'Not Found');
          if (parsed.labels !== undefined) {
            const names = labelNames(parsed.labels);
            if (names === null) return err(422, 'labels must be an array of label names');
            for (const n of names) {
              if (!repo.labels.has(n)) return err(422, `Label ${n} does not exist`);
            }
            issue.labels = names;
          }
          if (parsed.state !== undefined) {
            if (parsed.state !== 'open' && parsed.state !== 'closed') {
              return err(422, 'state must be open or closed');
            }
            issue.state = parsed.state;
          }
          if (typeof parsed.title === 'string') issue.title = parsed.title;
          if (typeof parsed.body === 'string') issue.body = parsed.body;
          return json(200, issueJson(store, repo, issue));
        }
        return err(404, 'Not Found');
      }

      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') {
          return json(200, issue.comments.map((c) => ({
            id: c.id,
            node_id: store.globalId('IssueComment', c.id),
            body: c.body,
            user: { login: store.viewerLogin },
            created_at: store.isoTime(repo.seq),
          })));
        }
        if (method === 'POST') {
          if (typeof parsed.body !== 'string' || parsed.body.length === 0) {
            return err(422, 'body is required');
          }
          const id = repo.id * 1000000 + repo.nextCommentId;
          repo.nextCommentId += 1;
          const comment = { id, body: parsed.body };
          issue.comments.push(comment);
          return json(201, {
            id,
            node_id: store.globalId('IssueComment', id),
            body: parsed.body,
            user: { login: store.viewerLogin },
            created_at: store.isoTime(repo.seq),
          });
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // ---- pulls ------------------------------------------------------------
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = search.get('state') ?? 'open';
          const { page, perPage } = parsePagination(search);
          let list = [...repo.pulls];
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          else if (state !== 'all') list = list.filter((p) => p.state === 'open');
          const link = linkHeader(host, pathname, search, page, perPage, list.length);
          return json(200, paginate(list, page, perPage).map((p) => pullJson(store, repo, p)),
            link ? { link } : undefined);
        }
        if (method === 'POST') {
          const title = parsed.title;
          if (typeof title !== 'string' || title.length === 0) {
            return err(422, 'title is required');
          }
          const headRaw = parsed.head;
          const baseRaw = parsed.base;
          if (typeof headRaw !== 'string' || headRaw.length === 0) {
            return err(422, 'head is required');
          }
          if (typeof baseRaw !== 'string' || baseRaw.length === 0) {
            return err(422, 'base is required');
          }
          const headRef = headRaw.includes(':') ? headRaw.split(':').pop() as string : headRaw;
          const baseRef = baseRaw.includes(':') ? baseRaw.split(':').pop() as string : baseRaw;
          const headSha = store.resolveRef(repo, `refs/heads/${headRef}`);
          if (headSha === undefined) return err(422, `Head branch ${headRef} does not exist`);
          const baseSha = store.resolveRef(repo, `refs/heads/${baseRef}`);
          if (baseSha === undefined) return err(422, `Base branch ${baseRef} does not exist`);
          const headObj = repo.objects.get(headSha);
          const headTree = headObj && headObj.type === 'commit'
            ? store.flattenTree(repo, parseCommit(headObj.data).tree)
            : new Map<string, { mode: string; oid: string }>();
          const pull: Repo['pulls'][number] = {
            number: repo.nextPull,
            title,
            body: typeof parsed.body === 'string' ? parsed.body : '',
            state: 'open',
            headRef,
            baseRef,
            headSha,
            baseSha,
            merged: false,
            mergedAt: '',
            mergeCommitSha: '',
            seq: store.nextSeq(),
            headTreeFiles: headTree,
          };
          repo.nextPull += 1;
          repo.pulls.push(pull);
          return json(201, pullJson(store, repo, pull));
        }
        return err(404, 'Not Found');
      }

      const num = Number.parseInt(tail[1], 10);
      if (!Number.isInteger(num)) return err(404, 'Not Found');
      const pull = repo.pulls.find((p) => p.number === num);

      if (tail.length === 2) {
        if (method !== 'GET') return err(404, 'Not Found');
        if (!pull) return err(404, 'Not Found');
        return json(200, pullJson(store, repo, pull));
      }

      if (tail.length === 3 && tail[2] === 'files') {
        if (method !== 'GET') return err(404, 'Not Found');
        if (!pull) return err(404, 'Not Found');
        const headSha = liveSha(store, repo, pull.headRef, pull.headSha);
        const baseSha = liveSha(store, repo, pull.baseRef, pull.baseSha);
        const headObj = repo.objects.get(headSha);
        if (!headObj || headObj.type !== 'commit') return err(404, 'Not Found');
        const headFlat = store.flattenTree(repo, parseCommit(headObj.data).tree);
        const mb = store.mergeBase(repo, headSha, baseSha);
        let baseFlat = new Map<string, { mode: string; oid: string }>();
        if (mb !== null) {
          const mbObj = repo.objects.get(mb);
          if (mbObj && mbObj.type === 'commit') {
            baseFlat = store.flattenTree(repo, parseCommit(mbObj.data).tree);
          }
        }
        const files: JsonObj[] = [];
        const allPaths = new Set([...headFlat.keys(), ...baseFlat.keys()]);
        for (const path of [...allPaths].sort()) {
          const inHead = headFlat.get(path);
          const inBase = baseFlat.get(path);
          if (inHead && !inBase) {
            const blob = repo.objects.get(inHead.oid);
            const additions = Math.max(1, countLines(blob ? blob.data : Buffer.alloc(0)));
            files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
          } else if (!inHead && inBase) {
            const blob = repo.objects.get(inBase.oid);
            const deletions = countLines(blob ? blob.data : Buffer.alloc(0));
            files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
          } else if (inHead && inBase && inHead.oid !== inBase.oid) {
            const newBlob = repo.objects.get(inHead.oid);
            const oldBlob = repo.objects.get(inBase.oid);
            const additions = countLines(newBlob ? newBlob.data : Buffer.alloc(0));
            const deletions = countLines(oldBlob ? oldBlob.data : Buffer.alloc(0));
            files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
          }
        }
        return json(200, files);
      }

      if (tail.length === 3 && tail[2] === 'merge') {
        if (method !== 'PUT') return err(404, 'Not Found');
        if (!pull) return err(404, 'Not Found');
        if (pull.state === 'closed') {
          return err(405, pull.merged ? 'Pull request is already merged' : 'Pull request is closed');
        }
        const headSha = liveSha(store, repo, pull.headRef, pull.headSha);
        const baseSha = liveSha(store, repo, pull.baseRef, pull.baseSha);
        const mb = store.mergeBase(repo, headSha, baseSha);
        let baseFlat = new Map<string, { mode: string; oid: string }>();
        let headFlat = new Map<string, { mode: string; oid: string }>();
        let mbFlat = new Map<string, { mode: string; oid: string }>();
        const headObj = repo.objects.get(headSha);
        if (headObj && headObj.type === 'commit') headFlat = store.flattenTree(repo, parseCommit(headObj.data).tree);
        const baseObj = repo.objects.get(baseSha);
        if (baseObj && baseObj.type === 'commit') baseFlat = store.flattenTree(repo, parseCommit(baseObj.data).tree);
        if (mb !== null) {
          const mbObj = repo.objects.get(mb);
          if (mbObj && mbObj.type === 'commit') mbFlat = store.flattenTree(repo, parseCommit(mbObj.data).tree);
        }
        const changed = new Set<string>();
        for (const p of [...baseFlat.keys(), ...mbFlat.keys()]) {
          if (baseFlat.get(p)?.oid !== mbFlat.get(p)?.oid) changed.add(p);
        }
        const headChanged = new Set<string>();
        for (const p of [...headFlat.keys(), ...mbFlat.keys()]) {
          if (headFlat.get(p)?.oid !== mbFlat.get(p)?.oid) headChanged.add(p);
        }
        let conflict = false;
        for (const p of changed) {
          if (headChanged.has(p) && baseFlat.get(p)?.oid !== headFlat.get(p)?.oid) {
            conflict = true;
            break;
          }
        }
        if (conflict) {
          return err(405, 'Merge conflict: head and base both changed the same files');
        }
        const headTree = headObj && headObj.type === 'commit' ? parseCommit(headObj.data).tree : ZERO_OID;
        const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
        const squash = store.makeCommit(repo, headTree, [baseSha], message);
        repo.refs.set(`refs/heads/${pull.baseRef}`, squash);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = store.isoTime(store.nextSeq());
        pull.mergeCommitSha = squash;
        pull.baseSha = squash;
        pull.headTreeFiles = headFlat;
        return json(200, { merged: true, sha: squash, message: 'Pull request successfully merged' });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

/** Immediate children of `dir` ('' = root) from a flattened tree. */
function dirListing(
  repo: Repo,
  rootTreeOid: string,
  flat: Map<string, { mode: string; oid: string }>,
  dir: string,
): JsonObj[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const children = new Map<string, { type: 'file' | 'dir'; oid: string; size: number }>();
  for (const [path, f] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest.length === 0) continue;
    const first = rest.split('/')[0];
    if (rest.includes('/')) {
      if (!children.has(first)) {
        const sub = treeEntryAt(repo, rootTreeOid, prefix + first);
        children.set(first, { type: 'dir', oid: sub ? sub.oid : ZERO_OID, size: 0 });
      }
    } else if (!children.has(first)) {
      const blob = repo.objects.get(f.oid);
      children.set(first, { type: 'file', oid: f.oid, size: blob ? blob.data.length : 0 });
    }
  }
  return [...children.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, c]) => ({
      type: c.type,
      name,
      path: prefix + name,
      sha: c.oid,
      ...(c.type === 'file' ? { size: c.size } : {}),
    }));
}
