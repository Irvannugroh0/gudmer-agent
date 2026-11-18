// main.ts — the process wrapper around the forge.
//
// The forge itself lives in app.ts; this file only handles the
// conversation with the trial environment that hosts the run:
//
//   1. find out where that environment lives (MAKEFUN_ENV_URL),
//   2. start the forge on a port the kernel picks for us,
//   3. tell the environment which port we ended up on,
//   4. sit quietly until it reports the run is finished,
//   5. shut the server down and leave with a success code.
//
// Nothing here knows anything about git, REST or GraphQL — that split
// is deliberate, so the lifecycle can be read (and checked) on its own.

import { createApp } from './app.ts';

// How long a single register / poll attempt may take before we give
// up on it and try again, and how the pause between attempts grows:
// it doubles from a quarter of a second and is capped at four.
const ATTEMPT_LIMIT_MS = 30_000;
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 4_000;
// Breathing room between two successful "not done yet" polls, so a
// long run does not turn into a busy spin against the environment.
const POLL_GAP_MS = 300;

// Without an environment address there is nobody to register with and
// nobody who could ever tell us the run is over, so there is no point
// in starting the server at all: say so and fail immediately.
const envAddress = (process.env.MAKEFUN_ENV_URL ?? '').trim();
if (envAddress === '') {
  console.error('main: MAKEFUN_ENV_URL is not set, so there is no trial environment to talk to; exiting.');
  process.exit(1);
}
// Normalise once: endpoints below are joined with a leading slash.
const envBase = envAddress.replace(/\/+$/, '');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function growPause(current: number): number {
  return Math.min(current * 2, LONGEST_PAUSE_MS);
}

// One HTTP call to the environment, abandoned once it has taken
// ATTEMPT_LIMIT_MS. Callers decide what a response means; a thrown
// error simply means "that attempt did not work".
async function callEnv(path: string, init: RequestInit = {}): Promise<Response> {
  const abandon = new AbortController();
  const timer = setTimeout(() => abandon.abort(), ATTEMPT_LIMIT_MS);
  try {
    return await fetch(`${envBase}${path}`, { ...init, signal: abandon.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Announce our listening port until the environment takes the news.
// Most failures here are transient (the environment may still be
// coming up), so they are retried with the growing pause. A 409 is
// not a failure and not a reason to leave: it only means another
// entry registered first, and this process still has to wait for the
// end of the run like everyone else.
async function announcePort(port: number): Promise<void> {
  let pauseMs = FIRST_PAUSE_MS;
  for (;;) {
    try {
      const reply = await callEnv('/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      // Drain the body so the connection can be reused or closed.
      await reply.text().catch(() => '');
      if (reply.ok || reply.status === 409) return;
      // Any other status counts as a failed attempt: fall through
      // to the pause and try again.
    } catch {
      // Network error or an abandoned, over-long attempt: retry.
    }
    await sleep(pauseMs);
    pauseMs = growPause(pauseMs);
  }
}

// Ask the environment, again and again, whether the run is finished.
// Only an explicit {"done": true} ends the wait — errors, odd replies
// and {"done": false} all mean "keep waiting", never "give up".
async function waitUntilFinished(): Promise<void> {
  let pauseMs = FIRST_PAUSE_MS;
  for (;;) {
    let finished = false;
    try {
      const reply = await callEnv('/done');
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        finished = payload.done === true;
      }
    } catch {
      // A failed or malformed poll tells us nothing; wait and retry.
    }
    if (finished) return;
    // A healthy "not done yet" gets the short fixed gap; anything
    // else backs off a little more each time it happens.
    await sleep(pauseMs === FIRST_PAUSE_MS ? POLL_GAP_MS : pauseMs);
    pauseMs = growPause(pauseMs);
  }
}

// --- the run itself -------------------------------------------------

const forge = createApp();

// Port 0 is the whole point: the kernel hands us a free port, which
// can never collide with the environment's own listener.
await new Promise<void>((resolve, reject) => {
  forge.once('error', reject);
  forge.listen(0, () => resolve());
});

const bound = forge.address();
if (bound === null || typeof bound === 'string') {
  console.error('main: the forge server did not report a TCP port; exiting.');
  process.exit(1);
}
console.log(`main: forge is listening on port ${bound.port}`);

await announcePort(bound.port);
await waitUntilFinished();

// The environment is done with us: stop accepting work, let idle
// keep-alive sockets go so close() can finish, and report success.
forge.close(() => process.exit(0));
forge.closeIdleConnections();
