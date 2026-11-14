# github-core-clone — a standalone GitHub-compatible git forge

One process, no dependencies beyond the Node 22 standard library, no git
binary, no outside service, no UI. It serves from its own in-memory store:

- **git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (`ls-refs`, `fetch`, shallow/deepen) and receive-pack v0, with a
  from-scratch packfile reader/writer (plain objects, OFS/REF delta decoding
  on read) and fast-forward enforcement.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments, pull requests, files and squash merges.
- **GraphQL v4** at `/api/graphql` — a small recursive-descent parser
  executing the documents `gh` and `github-mcp-server` send, including
  introspection, cursor pagination, and mutations.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, modern
  (`2026-07-28` via `server/discover`) and legacy (`initialize`) handshakes,
  with `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request` and `merge_pull_request` acting on the same store
  as REST.

## Run it

```sh
node main.ts
```

`main.ts` is the entry ↔ environment lifecycle: bind an ephemeral port,
`POST $MAKEFUN_ENV_URL/register {"port": N}`, poll `GET
$MAKEFUN_ENV_URL/done` until it says done, then exit 0. `app.ts` is the
server; the surfaces live in `git.ts`, `rest.ts`, `graphql.ts`, `mcp.ts`,
all sharing the store and object model in `store.ts`.

Deterministic by design: no wall clock and no unseeded randomness anywhere
in the request path, so two runs on the same instance leave identical state.

## Layout

- `main.ts` — lifecycle (bind, register, wait for done, exit)
- `app.ts` — HTTP server shell and routing
- `store.ts` — in-memory store, SHA-1 object model, reachability
- `git.ts` — smart HTTP, pkt-line, packfile read/write
- `rest.ts` — REST v3
- `graphql.ts` — GraphQL v4
- `mcp.ts` — MCP endpoint

Built for the make.fun competition `github-core-clone-01`. Local grade
against the kit's sealed suite (`sdk/run.ts --perf`): **120/120 checks,
score 959** (feature 600, agent 200, perf 159) on the first graded build.
