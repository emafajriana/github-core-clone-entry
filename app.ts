// HTTP server shell for the github-core-clone-01 forge.
// Routes to the four surface modules; adds X-GitHub-Request-Id to every reply.
// Written from the kit spec: /healthz boot probe, git smart HTTP at /{owner}/{repo}.git,
// REST v3 under /api/v3, GraphQL at /api/graphql, MCP at /mcp, JSON 404 elsewhere.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY = 100 * 1024 * 1024;

interface ModResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function sendMod(res: ServerResponse, r: ModResponse, requestId: string): void {
  const headers: Record<string, string> = {
    'x-github-request-id': requestId,
    ...r.headers,
  };
  if (!headers['content-length']) headers['content-length'] = String(r.body.length);
  res.writeHead(r.status, headers);
  res.end(r.body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...extra,
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = store.nextRequestId();
    const method = req.method ?? 'GET';
    let pathname: string;
    let search: URLSearchParams;
    try {
      const u = new URL(req.url ?? '/', 'http://entry');
      pathname = u.pathname;
      search = u.searchParams;
    } catch {
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return;
    }
    const headers = headersOf(req);

    if (method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true }, requestId);
      return;
    }

    const chunks: Buffer[] = [];
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      if (tooBig) return;
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      let total = 0;
      for (const b of chunks) total += b.length;
      if (total > MAX_BODY) tooBig = true;
    });
    req.on('end', () => {
      void (async () => {
        try {
          if (tooBig) {
            sendJson(res, 413, { message: 'Request body too large' }, requestId);
            return;
          }
          const body = Buffer.concat(chunks);
          const isGit = pathname.includes('.git/');
          let out: ModResponse | null = null;
          if (isGit) {
            out = await handleGit(store, method, pathname, search, headers, body);
          } else if (pathname === '/api/graphql') {
            out = await handleGraphQL(store, method, pathname, search, headers, body);
          } else if (pathname === '/mcp') {
            out = await handleMcp(store, method, pathname, search, headers, body);
          } else if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
            out = await handleRest(store, method, pathname, search, headers, body);
          }
          if (out === null) {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }
          sendMod(res, out, requestId);
        } catch (err) {
          // Never crash the server on a bad request: answer JSON 500 (or a git
          // report for git paths) and keep serving.
          try {
            if (pathname.includes('.git/')) {
              const report = Buffer.from('0031unpack internal error\n0000', 'utf8');
              res.writeHead(200, {
                'content-type': 'application/x-git-receive-pack-result',
                'content-length': report.length,
                'x-github-request-id': requestId,
              });
              res.end(report);
            } else {
              sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }, requestId);
            }
          } catch { /* socket already gone */ }
        }
      })();
    });
    req.on('error', () => {
      try { sendJson(res, 400, { message: 'Bad Request' }, requestId); } catch { /* ignore */ }
    });
  });
}
