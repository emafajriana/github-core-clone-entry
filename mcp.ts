// MCP endpoint for the github-core-clone-01 forge.
// JSON-RPC 2.0 over Streamable HTTP (plain application/json answers).
// POST /mcp only. Bearer auth required (store.token, or any non-empty Bearer
// token when store.token is empty). Auth is checked before JSON parsing.
import { Store, VIEWER_LOGIN, parseCommit } from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';

export interface McpResponse { status: number; headers: Record<string, string>; body: Buffer; }

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

// The tool list is built once at module load and reused verbatim every call.
interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, { type: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' },
        body: { type: 'string' }, full_name: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' }, repo: { type: 'string' },
        state: { type: 'string' }, full_name: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' },
        head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' },
        full_name: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' }, repo: { type: 'string' },
        pull_number: { type: 'integer' }, full_name: { type: 'string' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export async function handleMcp(
  store: Store,
  method: string,
  pathname: string,
  _search: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): Promise<McpResponse | null> {
  if (method !== 'POST' || pathname !== '/mcp') return null;
  if (!checkAuth(store, headers)) {
    return {
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ message: 'Bad credentials' }), 'utf8'),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const req = parsed as { method?: unknown; id?: unknown; params?: unknown };
  if (typeof req.method !== 'string') {
    return rpcError(req.id === undefined ? null : req.id, -32600, 'Invalid Request', 400);
  }
  const id = req.id === undefined ? null : req.id;
  // Notifications (no id) get no JSON-RPC response: HTTP 202, empty body.
  if (req.method.startsWith('notifications/') || req.id === undefined) {
    return { status: 202, headers: {}, body: Buffer.alloc(0) };
  }
  switch (req.method) {
    case 'server/discover': {
      const pv = headers['mcp-protocol-version'] ?? headers['MCP-Protocol-Version'];
      if (pv && !SUPPORTED_VERSIONS.includes(pv)) {
        return rpcError(id, -32022, 'Unsupported protocol version', 200, { supported: [...SUPPORTED_VERSIONS] });
      }
      return rpcResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      });
    }
    case 'initialize': {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const offered = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '';
      const protocolVersion = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-11-25';
      return rpcResult(
        id,
        { protocolVersion, capabilities: { tools: {} }, serverInfo: { ...SERVER_INFO } },
        { 'mcp-session-id': 'session-1' },
      );
    }
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      return toolsCall(store, id, req.params);
    }
    default: {
      return rpcError(id, -32601, `Method not found: ${req.method}`);
    }
  }
}

function checkAuth(store: Store, headers: Record<string, string | undefined>): boolean {
  const h = headers['authorization'] ?? headers['Authorization'];
  if (!h || !h.startsWith('Bearer ')) return false;
  const tok = h.slice('Bearer '.length).trim();
  if (!tok) return false;
  if (!store.token) return true;
  return tok === store.token;
}

function rpcResult(id: unknown, result: unknown, extraHeaders?: Record<string, string>): McpResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json', ...(extraHeaders ?? {}) },
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8'),
  };
}

function rpcError(
  id: unknown,
  code: number,
  message: string,
  httpStatus = 200,
  data?: unknown,
): McpResponse {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error['data'] = data;
  return {
    status: httpStatus,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error }), 'utf8'),
  };
}

// ---------------------------------------------------------------------------
// Git helpers (squash merge, shared semantics with the GraphQL module)
// ---------------------------------------------------------------------------

function commitTreeOid(store: Store, repo: Repo, commitOid: string): string | null {
  const obj = store.getObject(repo, commitOid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

function flatFiles(store: Store, repo: Repo, commitOid: string | null): Map<string, { mode: string; oid: string }> {
  if (!commitOid) return new Map();
  const tree = commitTreeOid(store, repo, commitOid);
  if (!tree) return new Map();
  return store.flattenTree(repo, tree);
}

function diffPaths(
  a: Map<string, { mode: string; oid: string }>,
  b: Map<string, { mode: string; oid: string }>,
): string[] {
  const paths = new Set<string>([...a.keys(), ...b.keys()]);
  const out: string[] = [];
  for (const p of paths) {
    if ((a.get(p)?.oid ?? null) !== (b.get(p)?.oid ?? null)) out.push(p);
  }
  return out.sort();
}

function mergeConflict(store: Store, repo: Repo, pull: Pull): boolean {
  const baseSha = store.resolveRef(repo, pull.baseRef);
  const headSha = store.resolveRef(repo, pull.headRef);
  if (!baseSha || !headSha) return true;
  const mb = store.mergeBase(repo, baseSha, headSha);
  const mbFiles = flatFiles(store, repo, mb);
  const baseFiles = flatFiles(store, repo, baseSha);
  const headFiles = flatFiles(store, repo, headSha);
  const changedHead = new Set(diffPaths(mbFiles, headFiles));
  for (const p of diffPaths(mbFiles, baseFiles)) {
    if (changedHead.has(p) && (baseFiles.get(p)?.oid ?? null) !== (headFiles.get(p)?.oid ?? null)) return true;
  }
  return false;
}

function squashMerge(
  store: Store,
  repo: Repo,
  pull: Pull,
): { ok: true; sha: string; message: string } | { ok: false; reason: string } {
  if (pull.merged) {
    return { ok: true, sha: pull.mergeCommitSha, message: `Squash merge #${pull.number}: ${pull.title}` };
  }
  const baseSha = store.resolveRef(repo, pull.baseRef);
  const headSha = store.resolveRef(repo, pull.headRef);
  if (!baseSha || !headSha) return { ok: false, reason: 'base or head ref not found' };
  if (mergeConflict(store, repo, pull)) return { ok: false, reason: 'merge conflict' };
  const mb = store.mergeBase(repo, baseSha, headSha);
  const mbFiles = flatFiles(store, repo, mb);
  const baseFiles = flatFiles(store, repo, baseSha);
  const headFiles = flatFiles(store, repo, headSha);
  const merged = new Map(baseFiles);
  for (const p of diffPaths(mbFiles, headFiles)) {
    const h = headFiles.get(p);
    if (h) merged.set(p, h);
    else merged.delete(p);
  }
  const treeOid = store.buildTree(repo, merged);
  const message = `Squash merge #${pull.number}: ${pull.title}`;
  const sha = store.makeCommit(repo, treeOid, [baseSha], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = store.isoTime(store.nextSeq());
  pull.mergeCommitSha = sha;
  return { ok: true, sha, message };
}

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: unknown;
  isError: boolean;
}

function errResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function okResult(obj: unknown, structured?: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: structured !== undefined ? structured : obj,
    isError: false,
  };
}

function argStr(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

function argInt(args: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  }
  return undefined;
}

function resolveOwnerRepo(args: Record<string, unknown>): { owner?: string; repo?: string } {
  let owner = argStr(args, 'owner', 'owner_login', 'org', 'user', 'login');
  let repo = argStr(args, 'repo', 'repository', 'repository_name', 'repo_name');
  const full = argStr(args, 'full_name');
  if ((!owner || !repo) && full && full.includes('/')) {
    const [o, r] = full.split('/');
    if (!owner) owner = o;
    if (!repo) repo = r;
  }
  return { owner, repo };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function toolCreateRepo(store: Store, args: Record<string, unknown>): ToolResult {
  const name = argStr(args, 'name', 'repo', 'repository', 'repository_name');
  if (!name) return errResult('Missing required argument: name');
  const owner = VIEWER_LOGIN;
  if (store.getRepo(owner, name)) return errResult('Repository already exists');
  const description = typeof args['description'] === 'string' ? (args['description'] as string) : '';
  const priv = args['private'] === true;
  const repo = store.createRepo(owner, name, priv, description);
  return okResult(repoJson(repo));
}

function toolGetRepo(store: Store, args: Record<string, unknown>): ToolResult {
  const { owner, repo: repoName } = resolveOwnerRepo(args);
  if (!owner || !repoName) return errResult('Missing required argument: owner and repo');
  const repo = store.getRepo(owner, repoName);
  if (!repo) return errResult(`Repository not found: ${owner}/${repoName}`);
  return okResult(repoJson(repo));
}

function toolCreateIssue(store: Store, args: Record<string, unknown>): ToolResult {
  const { owner, repo: repoName } = resolveOwnerRepo(args);
  const title = argStr(args, 'title', 'issue_title', 'pr_title', 'subject');
  if (!owner || !repoName) return errResult('Missing required argument: owner and repo');
  if (!title) return errResult('Missing required argument: title');
  const repo = store.getRepo(owner, repoName);
  if (!repo) return errResult(`Repository not found: ${owner}/${repoName}`);
  const body = argStr(args, 'body', 'description', 'content', 'text') ?? '';
  const issue: Issue = {
    number: repo.nextIssue, title, body, state: 'open', labels: [], comments: [], seq: store.nextSeq(),
  };
  repo.nextIssue += 1;
  repo.issues.push(issue);
  const num = repo.id * 100000 + issue.number;
  return okResult({
    number: issue.number,
    id: num,
    node_id: store.globalId('Issue', num),
    title,
    body,
    state: 'open',
  });
}

function toolListIssues(store: Store, args: Record<string, unknown>): ToolResult {
  const { owner, repo: repoName } = resolveOwnerRepo(args);
  if (!owner || !repoName) return errResult('Missing required argument: owner and repo');
  const repo = store.getRepo(owner, repoName);
  if (!repo) return errResult(`Repository not found: ${owner}/${repoName}`);
  const state = (argStr(args, 'state') ?? 'all').toLowerCase();
  const list = repo.issues.filter((i) => state === 'all' || i.state === state);
  const items = list.map((i) => ({ number: i.number, title: i.title, state: i.state }));
  return okResult(items, { issues: items });
}

function toolCreatePullRequest(store: Store, args: Record<string, unknown>): ToolResult {
  const { owner, repo: repoName } = resolveOwnerRepo(args);
  const title = argStr(args, 'title', 'issue_title', 'pr_title', 'subject');
  const head = argStr(args, 'head', 'head_ref', 'head_branch', 'source_branch', 'from_branch', 'branch');
  const base = argStr(args, 'base', 'base_ref', 'base_branch', 'target_branch', 'into_branch');
  if (!owner || !repoName) return errResult('Missing required argument: owner and repo');
  if (!title) return errResult('Missing required argument: title');
  if (!head) return errResult('Missing required argument: head');
  if (!base) return errResult('Missing required argument: base');
  const repo = store.getRepo(owner, repoName);
  if (!repo) return errResult(`Repository not found: ${owner}/${repoName}`);
  const headSha = store.resolveRef(repo, head);
  if (!headSha) return errResult(`Head ref not found: ${head}`);
  const baseSha = store.resolveRef(repo, base);
  if (!baseSha) return errResult(`Base ref not found: ${base}`);
  const body = argStr(args, 'body', 'description', 'content', 'text') ?? '';
  const headTree = commitTreeOid(store, repo, headSha);
  const pull: Pull = {
    number: repo.nextPull, title, body, state: 'open',
    headRef: head, baseRef: base, headSha, baseSha,
    merged: false, mergedAt: '', mergeCommitSha: '', seq: store.nextSeq(),
    headTreeFiles: headTree ? store.flattenTree(repo, headTree) : new Map(),
  };
  repo.nextPull += 1;
  repo.pulls.push(pull);
  const num = repo.id * 100000 + pull.number;
  return okResult({
    number: pull.number,
    id: num,
    node_id: store.globalId('PullRequest', num),
    title,
    state: 'open',
    head: { ref: head, sha: headSha },
    base: { ref: base, sha: baseSha },
  });
}

function toolMergePullRequest(store: Store, args: Record<string, unknown>): ToolResult {
  const { owner, repo: repoName } = resolveOwnerRepo(args);
  const pullNumber = argInt(args, 'pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number');
  if (!owner || !repoName) return errResult('Missing required argument: owner and repo');
  if (pullNumber === undefined) return errResult('Missing required argument: pull_number');
  const repo = store.getRepo(owner, repoName);
  if (!repo) return errResult(`Repository not found: ${owner}/${repoName}`);
  const pull = repo.pulls.find((x) => x.number === pullNumber);
  if (!pull) return errResult(`Pull request not found: #${pullNumber}`);
  if (pull.merged) {
    return okResult({ merged: true, sha: pull.mergeCommitSha, message: `Pull request #${pullNumber} already merged` });
  }
  const res = squashMerge(store, repo, pull);
  if (!res.ok) return errResult(`Merge conflict: ${res.reason}`);
  return okResult({ merged: true, sha: res.sha, message: res.message });
}

const TOOL_IMPLS: { norm: string; fn: (store: Store, args: Record<string, unknown>) => ToolResult }[] = [
  { norm: 'createpullrequest', fn: toolCreatePullRequest },
  { norm: 'mergepullrequest', fn: toolMergePullRequest },
  { norm: 'createissue', fn: toolCreateIssue },
  { norm: 'listissues', fn: toolListIssues },
  { norm: 'createrepo', fn: toolCreateRepo },
  { norm: 'getrepo', fn: toolGetRepo },
];

function toolsCall(store: Store, id: unknown, params: unknown): McpResponse {
  const p = (params ?? {}) as Record<string, unknown>;
  const name = typeof p['name'] === 'string' ? (p['name'] as string) : '';
  const args = (p['arguments'] ?? {}) as Record<string, unknown>;
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const impl = TOOL_IMPLS.find((t) => norm === t.norm || norm.endsWith(t.norm));
  if (!impl) return rpcError(id, -32602, `Unknown tool: ${name}`);
  const res = impl.fn(store, args);
  const result: Record<string, unknown> = { content: res.content, isError: res.isError };
  if (res.structuredContent !== undefined) result['structuredContent'] = res.structuredContent;
  return rpcResult(id, result);
}
