// GraphQL endpoint for the github-core-clone-01 forge.
// Small recursive-descent GraphQL parser + executor over the shared Store.
// POST /api/graphql only. Bearer auth required (store.token, or any non-empty
// Bearer token when store.token is empty).
import { Store, VIEWER_LOGIN, parseCommit } from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';

export interface GqlResponse { status: number; headers: Record<string, string>; body: Buffer; }

export async function handleGraphQL(
  store: Store,
  method: string,
  pathname: string,
  _search: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): Promise<GqlResponse | null> {
  if (method !== 'POST' || pathname !== '/api/graphql') return null;
  if (!checkAuth(store, headers)) {
    return jsonResp(401, { message: 'Bad credentials' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonResp(400, { errors: [{ message: 'Malformed JSON body' }] });
  }
  if (Array.isArray(parsed)) {
    return jsonResp(200, parsed.map((item) => executeOne(store, item)));
  }
  return jsonResp(200, executeOne(store, parsed));
}

function jsonResp(status: number, obj: unknown): GqlResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(obj), 'utf8') };
}

function checkAuth(store: Store, headers: Record<string, string | undefined>): boolean {
  const h = headers['authorization'] ?? headers['Authorization'];
  if (!h || !h.startsWith('Bearer ')) return false;
  const tok = h.slice('Bearer '.length).trim();
  if (!tok) return false;
  if (!store.token) return true;
  return tok === store.token;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface Token { kind: 'name' | 'string' | 'int' | 'float' | 'punct'; value: string; }

function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '{' || c === '}' || c === '(' || c === ')' || c === '[' || c === ']' ||
        c === ':' || c === '$' || c === '!' || c === '=' || c === '@' || c === '|' || c === '&') {
      toks.push({ kind: 'punct', value: c }); i += 1; continue;
    }
    if (c === '.') {
      if (src.slice(i, i + 3) === '...') { toks.push({ kind: 'punct', value: '...' }); i += 3; continue; }
      throw new Error('Unexpected character "."');
    }
    if (c === '"') {
      i += 1;
      let out = '';
      let closed = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '"') { closed = true; i += 1; break; }
        if (ch === '\\') {
          const e = src[i + 1];
          if (e === undefined) break;
          if (e === 'n') { out += '\n'; i += 2; }
          else if (e === 'r') { out += '\r'; i += 2; }
          else if (e === 't') { out += '\t'; i += 2; }
          else if (e === 'b') { out += '\b'; i += 2; }
          else if (e === 'f') { out += '\f'; i += 2; }
          else if (e === 'u') {
            const hex = src.slice(i + 2, i + 6);
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
          } else { out += e; i += 2; }
          continue;
        }
        out += ch;
        i += 1;
      }
      if (!closed) throw new Error('Unterminated string');
      toks.push({ kind: 'string', value: out });
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i;
      if (src[j] === '-') j += 1;
      let isFloat = false;
      while (j < src.length && src[j] >= '0' && src[j] <= '9') j += 1;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && src[j] >= '0' && src[j] <= '9') j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && src[j] >= '0' && src[j] <= '9') j += 1;
      }
      const text = src.slice(i, j);
      if (text === '-' || text === '') throw new Error(`Unexpected character "${c}"`);
      toks.push({ kind: isFloat ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character "${c}"`);
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldSelection {
  kind: 'field';
  name: string;
  alias?: string;
  args: { name: string; value: ValueNode }[];
  selections?: Selection[];
}
type Selection =
  | FieldSelection
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition?: string; selections: Selection[] };

interface VarDef { name: string; defaultValue?: ValueNode; }
interface Operation { kind: 'query' | 'mutation'; name?: string; varDefs: VarDef[]; selections: Selection[]; }
interface FragmentDef { name: string; typeCondition: string; selections: Selection[]; }
interface Document { operations: Operation[]; fragments: Map<string, FragmentDef>; }

class Parser {
  private pos = 0;
  private toks: Token[];
  constructor(toks: Token[]) { this.toks = toks; }

  peek(): Token | undefined { return this.toks[this.pos]; }

  next(): Token {
    const t = this.toks[this.pos];
    if (!t) throw new Error('Unexpected end of document');
    this.pos += 1;
    return t;
  }

  expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`Expected "${v}" but got "${t.value}"`);
  }

  expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`Expected name but got "${t.value}"`);
    return t.value;
  }

  expectNameValue(v: string): void {
    const got = this.expectName();
    if (got !== v) throw new Error(`Expected "${v}" but got "${got}"`);
  }

  skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArguments();
    }
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek()) {
      const t = this.peek() as Token;
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectNameValue('on');
        const tc = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition: tc, selections });
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  parseOperation(): Operation {
    const t = this.peek() as Token;
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'query', varDefs: [], selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      const kind = t.value as 'query' | 'mutation';
      this.next();
      let name: string | undefined;
      const n = this.peek();
      if (n && n.kind === 'name') name = this.next().value;
      const varDefs = this.peek()?.kind === 'punct' && this.peek()?.value === '(' ? this.parseVarDefs() : [];
      this.skipDirectives();
      const selections = this.parseSelectionSet();
      return { kind, name, varDefs, selections };
    }
    throw new Error(`Unexpected token "${t.value}"`);
  }

  parseVarDefs(): VarDef[] {
    this.expectPunct('(');
    const defs: VarDef[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      // Consume the type: names, [ ], ! — stop at =, ,, ), or $.
      for (;;) {
        const tk = this.next();
        if (tk.kind !== 'punct' && tk.kind !== 'name') throw new Error('Invalid type in variable definition');
        const nx = this.peek();
        if (!nx) break;
        if (nx.kind === 'punct' && (nx.value === '=' || nx.value === ',' || nx.value === ')' || nx.value === '$')) break;
      }
      let defaultValue: ValueNode | undefined;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, defaultValue });
      if (this.peek()?.kind === 'punct' && this.peek()?.value === ',') this.next();
    }
    this.expectPunct(')');
    return defs;
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const sels: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      if (!this.peek()) throw new Error('Unterminated selection set');
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }

  parseSelection(): Selection {
    const t = this.peek() as Token;
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const nx = this.peek();
      if (nx && nx.kind === 'name' && nx.value === 'on') {
        this.next();
        const tc = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition: tc, selections: this.parseSelectionSet() };
      }
      if (nx && nx.kind === 'punct' && nx.value === '{') {
        this.skipDirectives();
        return { kind: 'inline', selections: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.peek()?.kind === 'punct' && this.peek()?.value === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    let selections: Selection[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  parseArguments(): { name: string; value: ValueNode }[] {
    this.expectPunct('(');
    const args: { name: string; value: ValueNode }[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      if (!this.peek()) throw new Error('Unterminated argument list');
      const name = this.expectName();
      this.expectPunct(':');
      const value = this.parseValue();
      args.push({ name, value });
      if (this.peek()?.kind === 'punct' && this.peek()?.value === ',') this.next();
    }
    this.expectPunct(')');
    return args;
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        if (!this.peek()) throw new Error('Unterminated list');
        values.push(this.parseValue());
        if (this.peek()?.kind === 'punct' && this.peek()?.value === ',') this.next();
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        if (!this.peek()) throw new Error('Unterminated input object');
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
        if (this.peek()?.kind === 'punct' && this.peek()?.value === ',') this.next();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`Unexpected value token "${t.value}"`);
  }
}

// ---------------------------------------------------------------------------
// Schema tables
// ---------------------------------------------------------------------------

interface TypeDef { name: string; kind: string; fields?: string[]; enums?: string[]; }

const KNOWN_TYPES: TypeDef[] = [
  { name: 'Query', kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  { name: 'Mutation', kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  { name: 'Repository', kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'] },
  { name: 'Issue', kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body'] },
  { name: 'PullRequest', kind: 'OBJECT', fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'] },
  { name: 'User', kind: 'OBJECT', fields: ['login'] },
  { name: 'Ref', kind: 'OBJECT', fields: ['name'] },
  { name: 'IssueConnection', kind: 'OBJECT', fields: ['nodes', 'pageInfo'] },
  { name: 'PullRequestConnection', kind: 'OBJECT', fields: ['nodes', 'pageInfo'] },
  { name: 'PullRequestFileConnection', kind: 'OBJECT', fields: ['nodes'] },
  { name: 'File', kind: 'OBJECT', fields: ['path'] },
  { name: 'PageInfo', kind: 'OBJECT', fields: ['hasNextPage', 'endCursor'] },
  { name: 'Node', kind: 'INTERFACE', fields: ['id'] },
  { name: 'SearchType', kind: 'ENUM', enums: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION', 'COMMIT'] },
  { name: '__Type', kind: 'OBJECT', fields: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', 'ofType'] },
  { name: '__Field', kind: 'OBJECT', fields: ['name', 'description', 'args', 'type'] },
  { name: '__InputValue', kind: 'OBJECT', fields: ['name', 'description', 'type', 'defaultValue'] },
  { name: '__EnumValue', kind: 'OBJECT', fields: ['name', 'description'] },
  { name: '__Schema', kind: 'OBJECT', fields: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives'] },
  { name: '__Directive', kind: 'OBJECT', fields: ['name', 'description', 'locations', 'args'] },
  { name: 'CreateIssuePayload', kind: 'OBJECT', fields: ['issue'] },
  { name: 'CloseIssuePayload', kind: 'OBJECT', fields: ['issue'] },
  { name: 'CreatePullRequestPayload', kind: 'OBJECT', fields: ['pullRequest'] },
  { name: 'MergePullRequestPayload', kind: 'OBJECT', fields: ['pullRequest'] },
  { name: 'AddCommentPayload', kind: 'OBJECT', fields: ['commentEdge'] },
  { name: 'CommentEdge', kind: 'OBJECT', fields: ['node'] },
  { name: 'Comment', kind: 'OBJECT', fields: ['id', 'body'] },
];

const FIELDS: Record<string, string[]> = {};
for (const t of KNOWN_TYPES) FIELDS[t.name] = t.fields ?? [];

const FIELD_TYPES: Record<string, Record<string, { type: string; kind?: string; list?: boolean }>> = {
  Query: {
    viewer: { type: 'User' }, repository: { type: 'Repository' }, node: { type: 'Node' },
    __type: { type: '__Type' }, __schema: { type: '__Schema' },
  },
  Mutation: {
    createIssue: { type: 'CreateIssuePayload' }, closeIssue: { type: 'CloseIssuePayload' },
    createPullRequest: { type: 'CreatePullRequestPayload' }, mergePullRequest: { type: 'MergePullRequestPayload' },
    addComment: { type: 'AddCommentPayload' },
  },
  Repository: {
    id: { type: 'ID', kind: 'SCALAR' }, databaseId: { type: 'Int', kind: 'SCALAR' },
    name: { type: 'String', kind: 'SCALAR' }, nameWithOwner: { type: 'String', kind: 'SCALAR' },
    owner: { type: 'User' }, defaultBranchRef: { type: 'Ref' },
    viewerPermission: { type: 'String', kind: 'SCALAR' }, hasIssuesEnabled: { type: 'Boolean', kind: 'SCALAR' },
    issue: { type: 'Issue' }, issues: { type: 'IssueConnection' },
    pullRequests: { type: 'PullRequestConnection' }, pullRequest: { type: 'PullRequest' },
  },
  Issue: {
    id: { type: 'ID', kind: 'SCALAR' }, number: { type: 'Int', kind: 'SCALAR' },
    title: { type: 'String', kind: 'SCALAR' }, state: { type: 'String', kind: 'SCALAR' },
    body: { type: 'String', kind: 'SCALAR' },
  },
  PullRequest: {
    id: { type: 'ID', kind: 'SCALAR' }, number: { type: 'Int', kind: 'SCALAR' },
    headRefName: { type: 'String', kind: 'SCALAR' }, baseRefName: { type: 'String', kind: 'SCALAR' },
    mergeable: { type: 'String', kind: 'SCALAR' }, state: { type: 'String', kind: 'SCALAR' },
    merged: { type: 'Boolean', kind: 'SCALAR' }, files: { type: 'PullRequestFileConnection' },
  },
  User: { login: { type: 'String', kind: 'SCALAR' } },
  Ref: { name: { type: 'String', kind: 'SCALAR' } },
  IssueConnection: { nodes: { type: 'Issue', list: true }, pageInfo: { type: 'PageInfo' } },
  PullRequestConnection: { nodes: { type: 'PullRequest', list: true }, pageInfo: { type: 'PageInfo' } },
  PullRequestFileConnection: { nodes: { type: 'File', list: true } },
  File: { path: { type: 'String', kind: 'SCALAR' } },
  PageInfo: {
    hasNextPage: { type: 'Boolean', kind: 'SCALAR' }, endCursor: { type: 'String', kind: 'SCALAR' },
  },
  Node: { id: { type: 'ID', kind: 'SCALAR' } },
  __Type: {
    name: { type: 'String', kind: 'SCALAR' }, kind: { type: 'String', kind: 'SCALAR' },
    description: { type: 'String', kind: 'SCALAR' },
    fields: { type: '__Field', list: true }, enumValues: { type: '__EnumValue', list: true },
    inputFields: { type: '__InputValue', list: true }, interfaces: { type: '__Type', list: true },
    possibleTypes: { type: '__Type', list: true }, ofType: { type: '__Type' },
  },
  __Field: {
    name: { type: 'String', kind: 'SCALAR' }, description: { type: 'String', kind: 'SCALAR' },
    args: { type: '__InputValue', list: true }, type: { type: '__Type' },
  },
  __InputValue: {
    name: { type: 'String', kind: 'SCALAR' }, description: { type: 'String', kind: 'SCALAR' },
    type: { type: '__Type' }, defaultValue: { type: 'String', kind: 'SCALAR' },
  },
  __EnumValue: {
    name: { type: 'String', kind: 'SCALAR' }, description: { type: 'String', kind: 'SCALAR' },
  },
  __Schema: {
    queryType: { type: '__Type' }, mutationType: { type: '__Type' },
    subscriptionType: { type: '__Type' }, types: { type: '__Type', list: true },
    directives: { type: '__Directive', list: true },
  },
  __Directive: {
    name: { type: 'String', kind: 'SCALAR' }, description: { type: 'String', kind: 'SCALAR' },
    locations: { type: 'String', kind: 'SCALAR', list: true }, args: { type: '__InputValue', list: true },
  },
  CreateIssuePayload: { issue: { type: 'Issue' } },
  CloseIssuePayload: { issue: { type: 'Issue' } },
  CreatePullRequestPayload: { pullRequest: { type: 'PullRequest' } },
  MergePullRequestPayload: { pullRequest: { type: 'PullRequest' } },
  AddCommentPayload: { commentEdge: { type: 'CommentEdge' } },
  CommentEdge: { node: { type: 'Comment' } },
  Comment: {
    id: { type: 'ID', kind: 'SCALAR' }, body: { type: 'String', kind: 'SCALAR' },
  },
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ExecCtx {
  store: Store;
  vars: Record<string, unknown>;
  errors: { message: string }[];
  fragments: Map<string, FragmentDef>;
}

interface TypeInfo {
  name: string | null;
  kind: string;
  fieldNames?: string[];
  enumNames?: string[];
  ofType?: TypeInfo;
}

interface FieldValue { value: unknown; type: string | null; listItem?: string; }

interface IssueValue { repo: Repo; issue: Issue; }
interface PullValue { repo: Repo; pull: Pull; }
interface ConnValue { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string }; }

function resolveValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return vars[node.name];
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => resolveValue(v, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, vars);
      return out;
    }
  }
}

function argMap(sel: FieldSelection, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of sel.args) out[a.name] = resolveValue(a.value, ctx.vars);
  return out;
}

function argStr(m: Record<string, unknown>, key: string): string | undefined {
  const v = m[key];
  return typeof v === 'string' ? v : undefined;
}

function argInt(m: Record<string, unknown>, key: string): number | undefined {
  const v = m[key];
  return typeof v === 'number' ? v : undefined;
}

function typeInfoFor(name: string): TypeInfo {
  const def = KNOWN_TYPES.find((t) => t.name === name);
  if (!def) return { name, kind: 'OBJECT', fieldNames: [], enumNames: [] };
  return { name: def.name, kind: def.kind, fieldNames: def.fields ?? [], enumNames: def.enums ?? [] };
}

function fieldTypeInfo(parentType: string, fieldName: string): TypeInfo {
  const ft = FIELD_TYPES[parentType]?.[fieldName];
  if (!ft) return { name: 'String', kind: 'SCALAR', fieldNames: [], enumNames: [] };
  if (ft.list) return { name: null, kind: 'LIST', ofType: typeInfoFor(ft.type) };
  return typeInfoFor(ft.type);
}

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const r of store.repos.values()) if (r.id === id) return r;
  return undefined;
}

function findIssueByGlobalId(store: Store, gid: string): IssueValue | null {
  const p = store.parseGlobalId(gid);
  if (!p || p.kind !== 'Issue') return null;
  for (const repo of store.repos.values()) {
    const n = p.num - repo.id * 100000;
    if (n > 0 && n < 100000) {
      const issue = repo.issues.find((i) => i.number === n);
      if (issue) return { repo, issue };
    }
  }
  return null;
}

function findPullByGlobalId(store: Store, gid: string): PullValue | null {
  const p = store.parseGlobalId(gid);
  if (!p || p.kind !== 'PullRequest') return null;
  for (const repo of store.repos.values()) {
    const n = p.num - repo.id * 100000;
    if (n > 0 && n < 100000) {
      const pull = repo.pulls.find((x) => x.number === n);
      if (pull) return { repo, pull };
    }
  }
  return null;
}

function issueGlobalId(store: Store, repo: Repo, issue: Issue): string {
  return store.globalId('Issue', repo.id * 100000 + issue.number);
}

function pullGlobalId(store: Store, repo: Repo, pull: Pull): string {
  return store.globalId('PullRequest', repo.id * 100000 + pull.number);
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// --- git helpers (merge conflict / files / squash merge) ---

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

function prFilePaths(store: Store, repo: Repo, pull: Pull): string[] {
  const baseSha = store.resolveRef(repo, pull.baseRef);
  const headSha = store.resolveRef(repo, pull.headRef);
  if (!headSha) return [];
  const mb = baseSha ? store.mergeBase(repo, baseSha, headSha) : null;
  const mbFiles = flatFiles(store, repo, mb);
  const headFiles = flatFiles(store, repo, headSha);
  return diffPaths(mbFiles, headFiles);
}

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64url');
}

function decodeCursor(after: unknown): number | null {
  if (typeof after !== 'string' || !after) return null;
  try {
    const text = Buffer.from(after, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function issuesConnection(store: Store, repo: Repo, args: Record<string, unknown>): ConnValue {
  let list = [...repo.issues];
  const states = args['states'];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  let desc = false;
  const orderBy = args['orderBy'];
  if (orderBy && typeof orderBy === 'object') {
    const dir = (orderBy as Record<string, unknown>)['direction'];
    desc = String(dir ?? '').toUpperCase() === 'DESC';
  }
  list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  const cursorNum = decodeCursor(args['after']);
  if (cursorNum !== null) {
    list = list.filter((i) => (desc ? i.number < cursorNum : i.number > cursorNum));
  }
  const first = argInt(args, 'first');
  const total = list.length;
  const page = typeof first === 'number' ? list.slice(0, first) : list;
  const hasNextPage = page.length < total;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : '';
  return {
    nodes: page.map((issue) => ({ repo, issue }) as IssueValue),
    pageInfo: { hasNextPage, endCursor },
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): ConnValue {
  const first = argInt(args, 'first');
  const all = [...repo.pulls];
  const page = typeof first === 'number' ? all.slice(0, first) : all;
  return {
    nodes: page.map((pull) => ({ repo, pull }) as PullValue),
    pageInfo: { hasNextPage: page.length < all.length, endCursor: '' },
  };
}

// --- field resolution ---

function resolveField(parentType: string, parentValue: unknown, sel: FieldSelection, ctx: ExecCtx): FieldValue {
  const store = ctx.store;
  const args = argMap(sel, ctx);
  const nullVal: FieldValue = { value: null, type: null };

  if (parentType === 'Query') {
    if (sel.name === 'viewer') return { value: { login: VIEWER_LOGIN }, type: 'User' };
    if (sel.name === 'repository') {
      const repo = store.getRepo(argStr(args, 'owner') ?? '', argStr(args, 'name') ?? '');
      return repo ? { value: repo, type: 'Repository' } : nullVal;
    }
    if (sel.name === 'node') {
      const id = argStr(args, 'id') ?? '';
      const p = store.parseGlobalId(id);
      if (p && p.kind === 'Repository') {
        const repo = findRepoById(store, p.num);
        if (repo) return { value: { repo }, type: 'Node' };
      }
      return nullVal;
    }
    if (sel.name === '__type') {
      return { value: typeInfoFor(argStr(args, 'name') ?? ''), type: '__Type' };
    }
    if (sel.name === '__schema') {
      const schema = {
        queryType: typeInfoFor('Query'),
        mutationType: typeInfoFor('Mutation'),
        subscriptionType: null,
        types: KNOWN_TYPES.map((t) => typeInfoFor(t.name)),
        directives: [] as unknown[],
      };
      return { value: schema, type: '__Schema' };
    }
  }

  if (parentType === 'Mutation') {
    if (sel.name === 'createIssue') return mutationCreateIssue(store, args, ctx);
    if (sel.name === 'closeIssue') return mutationCloseIssue(store, args, ctx);
    if (sel.name === 'createPullRequest') return mutationCreatePullRequest(store, args, ctx);
    if (sel.name === 'mergePullRequest') return mutationMergePullRequest(store, args, ctx);
    if (sel.name === 'addComment') return mutationAddComment(store, args, ctx);
  }

  if (parentType === 'User') {
    const u = parentValue as { login: string };
    if (sel.name === 'login') return { value: u.login, type: null };
  }

  if (parentType === 'Ref') {
    const r = parentValue as { name: string };
    if (sel.name === 'name') return { value: r.name, type: null };
  }

  if (parentType === 'Repository') {
    const repo = parentValue as Repo;
    switch (sel.name) {
      case 'id': return { value: store.globalId('Repository', repo.id), type: null };
      case 'databaseId': return { value: repo.id, type: null };
      case 'name': return { value: repo.name, type: null };
      case 'nameWithOwner': return { value: `${repo.owner}/${repo.name}`, type: null };
      case 'owner': return { value: { login: repo.owner }, type: 'User' };
      case 'defaultBranchRef': return { value: { name: repo.defaultBranch }, type: 'Ref' };
      case 'viewerPermission': return { value: 'ADMIN', type: null };
      case 'hasIssuesEnabled': return { value: true, type: null };
      case 'issue': {
        const n = argInt(args, 'number');
        const issue = typeof n === 'number' ? repo.issues.find((i) => i.number === n) : undefined;
        return issue ? { value: { repo, issue } as IssueValue, type: 'Issue' } : nullVal;
      }
      case 'issues': return { value: issuesConnection(store, repo, args), type: 'IssueConnection' };
      case 'pullRequests': return { value: pullsConnection(repo, args), type: 'PullRequestConnection' };
      case 'pullRequest': {
        const n = argInt(args, 'number');
        const pull = typeof n === 'number' ? repo.pulls.find((x) => x.number === n) : undefined;
        return pull ? { value: { repo, pull } as PullValue, type: 'PullRequest' } : nullVal;
      }
    }
  }

  if (parentType === 'Issue') {
    const iv = parentValue as IssueValue;
    switch (sel.name) {
      case 'id': return { value: issueGlobalId(store, iv.repo, iv.issue), type: null };
      case 'number': return { value: iv.issue.number, type: null };
      case 'title': return { value: iv.issue.title, type: null };
      case 'state': return { value: issueState(iv.issue), type: null };
      case 'body': return { value: iv.issue.body, type: null };
    }
  }

  if (parentType === 'PullRequest') {
    const pv = parentValue as PullValue;
    switch (sel.name) {
      case 'id': return { value: pullGlobalId(store, pv.repo, pv.pull), type: null };
      case 'number': return { value: pv.pull.number, type: null };
      case 'state': return { value: pullState(pv.pull), type: null };
      case 'merged': return { value: pv.pull.merged, type: null };
      case 'headRefName': return { value: pv.pull.headRef, type: null };
      case 'baseRefName': return { value: pv.pull.baseRef, type: null };
      case 'mergeable': return { value: mergeConflict(store, pv.repo, pv.pull) ? 'CONFLICTING' : 'MERGEABLE', type: null };
      case 'files': {
        const first = argInt(args, 'first');
        const paths = prFilePaths(store, pv.repo, pv.pull);
        const page = typeof first === 'number' ? paths.slice(0, first) : paths;
        const conn: ConnValue = {
          nodes: page.map((p) => ({ path: p })),
          pageInfo: { hasNextPage: page.length < paths.length, endCursor: '' },
        };
        return { value: conn, type: 'PullRequestFileConnection' };
      }
    }
  }

  if (parentType === 'IssueConnection' || parentType === 'PullRequestConnection' || parentType === 'PullRequestFileConnection') {
    const conn = parentValue as ConnValue;
    if (sel.name === 'nodes') {
      const item = parentType === 'IssueConnection' ? 'Issue' : parentType === 'PullRequestConnection' ? 'PullRequest' : 'File';
      return { value: conn.nodes, type: null, listItem: item };
    }
    if (sel.name === 'pageInfo') return { value: conn.pageInfo, type: 'PageInfo' };
  }

  if (parentType === 'File') {
    const f = parentValue as { path: string };
    if (sel.name === 'path') return { value: f.path, type: null };
  }

  if (parentType === 'PageInfo') {
    const p = parentValue as { hasNextPage: boolean; endCursor: string };
    if (sel.name === 'hasNextPage') return { value: p.hasNextPage, type: null };
    if (sel.name === 'endCursor') return { value: p.endCursor, type: null };
  }

  if (parentType === '__Type') {
    const t = parentValue as TypeInfo;
    switch (sel.name) {
      case 'name': return { value: t.name, type: null };
      case 'kind': return { value: t.kind, type: null };
      case 'description': return nullVal;
      case 'fields': {
        const names = t.name ? (t.fieldNames ?? []) : [];
        return { value: names.map((n) => ({ name: n, parentType: t.name as string })), type: null, listItem: '__Field' };
      }
      case 'enumValues': {
        const names = t.enumNames ?? [];
        return { value: names.map((n) => ({ name: n })), type: null, listItem: '__EnumValue' };
      }
      case 'inputFields': return { value: [], type: null, listItem: '__InputValue' };
      case 'interfaces': return { value: [], type: null, listItem: '__Type' };
      case 'possibleTypes': {
        if (t.name === 'Node') return { value: [typeInfoFor('Repository')], type: null, listItem: '__Type' };
        return { value: [], type: null, listItem: '__Type' };
      }
      case 'ofType': return t.ofType ? { value: t.ofType, type: '__Type' } : nullVal;
    }
  }

  if (parentType === '__Field') {
    const f = parentValue as { name: string; parentType: string };
    switch (sel.name) {
      case 'name': return { value: f.name, type: null };
      case 'description': return nullVal;
      case 'args': return { value: [], type: null, listItem: '__InputValue' };
      case 'type': return { value: fieldTypeInfo(f.parentType, f.name), type: '__Type' };
    }
  }

  if (parentType === '__InputValue') {
    const v = parentValue as { name: string; parentType?: string };
    switch (sel.name) {
      case 'name': return { value: v.name, type: null };
      case 'description': return nullVal;
      case 'type': return { value: typeInfoFor('String'), type: '__Type' };
      case 'defaultValue': return nullVal;
    }
  }

  if (parentType === '__EnumValue') {
    const v = parentValue as { name: string };
    if (sel.name === 'name') return { value: v.name, type: null };
    if (sel.name === 'description') return nullVal;
  }

  if (parentType === '__Schema') {
    const s = parentValue as {
      queryType: TypeInfo; mutationType: TypeInfo; subscriptionType: null;
      types: TypeInfo[]; directives: unknown[];
    };
    switch (sel.name) {
      case 'queryType': return { value: s.queryType, type: '__Type' };
      case 'mutationType': return { value: s.mutationType, type: '__Type' };
      case 'subscriptionType': return nullVal;
      case 'types': return { value: s.types, type: null, listItem: '__Type' };
      case 'directives': return { value: s.directives, type: null, listItem: '__Directive' };
    }
  }

  if (parentType === '__Directive') {
    const d = parentValue as { name: string };
    if (sel.name === 'name') return { value: d.name, type: null };
    if (sel.name === 'description') return nullVal;
    if (sel.name === 'locations') return { value: [], type: null, listItem: 'String' };
    if (sel.name === 'args') return { value: [], type: null, listItem: '__InputValue' };
  }

  if (parentType === 'CreateIssuePayload' || parentType === 'CloseIssuePayload') {
    const p = parentValue as { issue: IssueValue };
    if (sel.name === 'issue') return { value: p.issue, type: 'Issue' };
  }

  if (parentType === 'CreatePullRequestPayload' || parentType === 'MergePullRequestPayload') {
    const p = parentValue as { pullRequest: PullValue };
    if (sel.name === 'pullRequest') return { value: p.pullRequest, type: 'PullRequest' };
  }

  if (parentType === 'AddCommentPayload') {
    const p = parentValue as { commentEdge: { node: { id: string; body: string } } };
    if (sel.name === 'commentEdge') return { value: p.commentEdge, type: 'CommentEdge' };
  }

  if (parentType === 'CommentEdge') {
    const e = parentValue as { node: { id: string; body: string } };
    if (sel.name === 'node') return { value: e.node, type: 'Comment' };
  }

  if (parentType === 'Comment') {
    const c = parentValue as { id: string; body: string };
    if (sel.name === 'id') return { value: c.id, type: null };
    if (sel.name === 'body') return { value: c.body, type: null };
  }

  if (parentType === 'Node') {
    const n = parentValue as { repo: Repo };
    if (sel.name === 'id') return { value: store.globalId('Repository', n.repo.id), type: null };
  }

  return nullVal;
}

// --- mutations ---

function inputObj(args: Record<string, unknown>): Record<string, unknown> {
  const v = args['input'];
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function mutationCreateIssue(store: Store, args: Record<string, unknown>, ctx: ExecCtx): FieldValue {
  const input = inputObj(args);
  const repoId = typeof input['repositoryId'] === 'string' ? (input['repositoryId'] as string) : '';
  const p = store.parseGlobalId(repoId);
  const repo = p && p.kind === 'Repository' ? findRepoById(store, p.num) : undefined;
  if (!repo) {
    ctx.errors.push({ message: `Repository not found: ${repoId}` });
    return { value: null, type: null };
  }
  const title = typeof input['title'] === 'string' ? (input['title'] as string) : '';
  const body = typeof input['body'] === 'string' ? (input['body'] as string) : '';
  const issue: Issue = {
    number: repo.nextIssue, title, body, state: 'open', labels: [], comments: [], seq: store.nextSeq(),
  };
  repo.nextIssue += 1;
  repo.issues.push(issue);
  return { value: { issue: { repo, issue } as IssueValue }, type: 'CreateIssuePayload' };
}

function mutationCloseIssue(store: Store, args: Record<string, unknown>, ctx: ExecCtx): FieldValue {
  const input = inputObj(args);
  const issueId = typeof input['issueId'] === 'string' ? (input['issueId'] as string) : '';
  const found = findIssueByGlobalId(store, issueId);
  if (!found) {
    ctx.errors.push({ message: `Issue not found: ${issueId}` });
    return { value: null, type: null };
  }
  found.issue.state = 'closed';
  return { value: { issue: found }, type: 'CloseIssuePayload' };
}

function mutationCreatePullRequest(store: Store, args: Record<string, unknown>, ctx: ExecCtx): FieldValue {
  const input = inputObj(args);
  const repoId = typeof input['repositoryId'] === 'string' ? (input['repositoryId'] as string) : '';
  const p = store.parseGlobalId(repoId);
  const repo = p && p.kind === 'Repository' ? findRepoById(store, p.num) : undefined;
  if (!repo) {
    ctx.errors.push({ message: `Repository not found: ${repoId}` });
    return { value: null, type: null };
  }
  const headRefName = typeof input['headRefName'] === 'string' ? (input['headRefName'] as string) : '';
  const baseRefName = typeof input['baseRefName'] === 'string' ? (input['baseRefName'] as string) : repo.defaultBranch;
  const title = typeof input['title'] === 'string' ? (input['title'] as string) : '';
  const body = typeof input['body'] === 'string' ? (input['body'] as string) : '';
  const headSha = store.resolveRef(repo, headRefName);
  if (!headSha) {
    ctx.errors.push({ message: `Head ref not found: ${headRefName}` });
    return { value: null, type: null };
  }
  const baseSha = store.resolveRef(repo, baseRefName);
  if (!baseSha) {
    ctx.errors.push({ message: `Base ref not found: ${baseRefName}` });
    return { value: null, type: null };
  }
  const headTree = commitTreeOid(store, repo, headSha);
  const pull: Pull = {
    number: repo.nextPull, title, body, state: 'open',
    headRef: headRefName, baseRef: baseRefName, headSha, baseSha,
    merged: false, mergedAt: '', mergeCommitSha: '', seq: store.nextSeq(),
    headTreeFiles: headTree ? store.flattenTree(repo, headTree) : new Map(),
  };
  repo.nextPull += 1;
  repo.pulls.push(pull);
  return { value: { pullRequest: { repo, pull } as PullValue }, type: 'CreatePullRequestPayload' };
}

function mutationMergePullRequest(store: Store, args: Record<string, unknown>, ctx: ExecCtx): FieldValue {
  const input = inputObj(args);
  const prId = typeof input['pullRequestId'] === 'string' ? (input['pullRequestId'] as string) : '';
  const found = findPullByGlobalId(store, prId);
  if (!found) {
    ctx.errors.push({ message: `Pull request not found: ${prId}` });
    return { value: null, type: null };
  }
  const res = squashMerge(store, found.repo, found.pull);
  if (!res.ok) {
    ctx.errors.push({ message: `Cannot merge pull request: ${res.reason}` });
    return { value: null, type: null };
  }
  return { value: { pullRequest: found }, type: 'MergePullRequestPayload' };
}

function mutationAddComment(store: Store, args: Record<string, unknown>, ctx: ExecCtx): FieldValue {
  const input = inputObj(args);
  const subjectId = typeof input['subjectId'] === 'string' ? (input['subjectId'] as string) : '';
  const body = typeof input['body'] === 'string' ? (input['body'] as string) : '';
  const found = findIssueByGlobalId(store, subjectId);
  if (!found) {
    ctx.errors.push({ message: `Subject not found: ${subjectId}` });
    return { value: null, type: null };
  }
  const id = found.repo.nextCommentId;
  found.repo.nextCommentId += 1;
  found.issue.comments.push({ id, body });
  const node = { id: String(id), body };
  return { value: { commentEdge: { node } }, type: 'AddCommentPayload' };
}

// --- selection execution ---

function typeMatches(cur: string, cond: string, value: unknown): boolean {
  if (cur === cond) return true;
  if (cur === 'Node' && cond === 'Repository') {
    return value !== null && typeof value === 'object' && (value as { repo?: unknown }).repo !== undefined;
  }
  return false;
}

function effectiveValue(value: unknown, cur: string, cond?: string): unknown {
  if (cond && cur === 'Node' && cond === 'Repository') return (value as { repo: unknown }).repo;
  return value;
}

function execSelections(
  value: unknown,
  typeName: string,
  sels: Selection[],
  ctx: ExecCtx,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (!frag) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}".` });
        return null;
      }
      if (!typeMatches(typeName, frag.typeCondition, value)) continue;
      const sub = execSelections(effectiveValue(value, typeName, frag.typeCondition), frag.typeCondition, frag.selections, ctx);
      if (sub === null) return null;
      Object.assign(out, sub);
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition && !typeMatches(typeName, sel.typeCondition, value)) continue;
      const effType = sel.typeCondition ?? typeName;
      const sub = execSelections(effectiveValue(value, typeName, sel.typeCondition), effType, sel.selections, ctx);
      if (sub === null) return null;
      Object.assign(out, sub);
      continue;
    }
    const allowed = FIELDS[typeName] ?? [];
    if (!allowed.includes(sel.name)) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      return null;
    }
    const key = sel.alias ?? sel.name;
    const fv = resolveField(typeName, value, sel, ctx);
    if (sel.selections && sel.selections.length > 0) {
      if (fv.value === null || fv.value === undefined) {
        out[key] = null;
        continue;
      }
      if (fv.listItem) {
        const arr = fv.value as unknown[];
        const mapped: unknown[] = [];
        let failed = false;
        for (const item of arr) {
          const r = execSelections(item, fv.listItem, sel.selections, ctx);
          if (r === null) { failed = true; break; }
          mapped.push(r);
        }
        out[key] = failed ? null : mapped;
      } else if (fv.type) {
        out[key] = execSelections(fv.value, fv.type, sel.selections, ctx);
      } else {
        out[key] = fv.value;
      }
    } else {
      out[key] = fv.value;
    }
  }
  return out;
}

function executeOne(store: Store, item: unknown): Record<string, unknown> {
  if (!item || typeof item !== 'object' || typeof (item as Record<string, unknown>)['query'] !== 'string') {
    return { data: null, errors: [{ message: 'Missing or invalid query' }] };
  }
  const rec = item as Record<string, unknown>;
  const query = rec['query'] as string;
  const variables = (rec['variables'] && typeof rec['variables'] === 'object'
    ? (rec['variables'] as Record<string, unknown>)
    : {});
  const operationName = typeof rec['operationName'] === 'string' ? rec['operationName'] : undefined;

  let doc: Document;
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'Syntax error' }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation found in document' }] };
  }
  let op: Operation | undefined;
  if (operationName) {
    op = doc.operations.find((o) => o.name === operationName);
    if (!op) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else {
    op = doc.operations[0];
  }
  const vars: Record<string, unknown> = {};
  for (const vd of op.varDefs) {
    if (vd.defaultValue !== undefined) vars[vd.name] = resolveValue(vd.defaultValue, vars);
  }
  Object.assign(vars, variables);
  const ctx: ExecCtx = { store, vars, errors: [], fragments: doc.fragments };
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = execSelections(null, rootType, op.selections, ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}
