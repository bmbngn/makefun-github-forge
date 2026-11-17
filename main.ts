// Entrypoint for the github-forge entry.
//
// The forge itself is built in app.ts (git smart HTTP, REST v3, GraphQL v4
// and MCP). This file only drives the lifecycle the trial harness expects
// from an entry:
//
//   1. Read MAKEFUN_ENV_URL, the origin of the trial environment. With no
//      environment to talk to there is nothing to do, so fail fast.
//   2. Start the forge on an ephemeral port. listen(0) lets the kernel pick
//      a free one; port 8080 belongs to the environment, never bind it.
//   3. Announce that port to the environment with POST /register. The first
//      registration wins: a 409 only means another entry got there first,
//      and this process waits its turn like any other.
//   4. Poll GET /done until the environment says the trial is over.
//   5. Stop the server and exit 0.
//
// The environment may still be starting when this process first reaches
// it, so every request to it carries a timeout and is retried with
// exponential backoff. Only a contract error — a 400 or 405 answer to
// /register — is fatal; anything else is worth trying again, and the
// process never exits before the environment says done.

import { createApp } from './app.ts';
import type { Server } from 'node:http';

/** How long one request to the environment may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Pause before the first retry; each retry doubles it, up to MAX_RETRY_MS. */
const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 2_000;

/** The environment's origin, with any trailing slashes stripped. */
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Pause before retry number `attempt` (0-based): 250ms, 500ms, 1s, then 2s. */
function retryPauseMs(attempt: number): number {
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(attempt, 8));
}

/** A response that means the request itself was wrong — retrying cannot help. */
class ContractError extends Error {}

/** Parse a response body as JSON, or null when it is not valid JSON. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * Run `attempt` until it reports success. It returns true when its work is
 * done and false when it should be tried again; a ContractError aborts the
 * whole run, and any other throw is treated as "try again".
 */
async function retryUntilDone(attempt: () => Promise<boolean>): Promise<void> {
  for (let n = 0; ; n += 1) {
    let done = false;
    try {
      done = await attempt();
    } catch (err) {
      if (err instanceof ContractError) throw err;
    }
    if (done) return;
    await sleep(retryPauseMs(n));
  }
}

/**
 * One registration attempt. True when the environment accepts the port
 * (200) or answers 409 (another entry registered first). A 400 or 405 is
 * a contract error and throws; any other status just means "try again".
 */
async function tryRegister(port: number): Promise<boolean> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 200 || res.status === 409) return true;
  if (res.status === 400 || res.status === 405) {
    throw new ContractError(`register rejected with HTTP ${res.status}: ${await res.text()}`);
  }
  return false;
}

/** One poll of GET /done: true only when the environment answers {"done": true}. */
async function tryDone(): Promise<boolean> {
  const res = await fetch(`${ENV_URL}/done`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return false;
  const body = await readJson(res);
  return (
    body !== null &&
    typeof body === 'object' &&
    (body as { done?: unknown }).done === true
  );
}

/** Start the forge on an ephemeral port and report the port the kernel picked. */
async function startForge(): Promise<{ server: Server; port: number }> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('the forge did not bind an ephemeral TCP port');
  }
  return { server, port: address.port };
}

/** Stop the forge, waiting until its sockets are closed. */
function stopForge(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** The whole life of the process: bind, register, wait for done, shut down. */
async function main(): Promise<void> {
  if (ENV_URL === '') {
    throw new Error('MAKEFUN_ENV_URL is not set: there is no env to register with');
  }

  const { server, port } = await startForge();
  // If the harness stops this process, close the server instead of leaving
  // it listening; the trial is over either way at that point.
  const shutdown = (): void => {
    void stopForge(server).then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  process.stdout.write(`[entry] listening on port ${port}\n`);

  await retryUntilDone(() => tryRegister(port));
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await retryUntilDone(tryDone);

  await stopForge(server);
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
