// Entry lifecycle for the forge: bind, register with the suite, wait for done.
// The suite (env) owns port 8080 and is named by MAKEFUN_ENV_URL. This process
// binds an ephemeral port of its own, tells the env that port, then polls the
// env until the trial is over and exits 0. It never exits early: while the
// suite runs, this process is the server under test.
import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set, so there is no suite to join\n');
  process.exit(1);
}

const REQUEST_BUDGET_MS = 30_000;
const FIRST_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function backoff(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.min(attempt, 8));
}

async function announcePort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let fatal = false;
    try {
      const answer = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) fatal = true;
    } catch {
      // The suite may still be starting; retry below.
    }
    if (fatal) throw new Error('the suite refused the port registration');
    await pause(backoff(attempt));
  }
}

async function awaitDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQUEST_BUDGET_MS) });
      if (answer.ok) {
        const payload = (await answer.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Not done yet (or the suite is briefly unreachable); keep polling.
    }
    await pause(backoff(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[forge] listening on port ${bound.port}\n`);
  await announcePort(bound.port);
  process.stdout.write('[forge] registered; waiting for the suite to finish\n');
  await awaitDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
