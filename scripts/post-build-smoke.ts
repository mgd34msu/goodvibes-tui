/**
 * Post-build smoke test for the daemon binary.
 *
 * Spawns dist/goodvibes-daemon-linux-x64, waits for it to be ready,
 * curls /api/health and /api/memory/vector, and asserts no sqlite-vec errors.
 *
 * Exit 0 = pass, exit 1 = fail.
 *
 * Usage:
 *   bun run scripts/post-build-smoke.ts
 *   bun run scripts/post-build-smoke.ts --binary dist/goodvibes-daemon-linux-x64
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const root = process.cwd();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const binaryIdx = args.indexOf('--binary');
const BINARY = binaryIdx !== -1 && args[binaryIdx + 1]
  ? args[binaryIdx + 1]
  : join(root, 'dist', 'goodvibes-daemon-linux-x64');

const SMOKE_PORT = 47921;
const SMOKE_TOKEN = 'smoke-test-token-local';
const STARTUP_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 300;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(msg: string): never {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
}

async function waitForDaemon(port: number, token: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1000),
      });
      // 200 = healthy+authed, 401 = server up but auth required — both mean daemon is running
      if (res.status === 200 || res.status === 401) return true;
    } catch {
      // not ready yet
    }
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

async function fetchJson(url: string, token: string): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.text();
    return { status: res.status, body };
  } catch (err) {
    return { status: -1, body: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`[smoke] Binary: ${BINARY}`);

if (!existsSync(BINARY)) {
  fail(`Binary not found: ${BINARY}`);
}

// Check native addon is present (required for sqlite-vec)
const addonPath = join(root, 'dist', 'lib', 'sqlite-vec-linux-x64', 'vec0.so');
if (!existsSync(addonPath)) {
  fail(`Native addon missing: ${addonPath} — F5 regression: scripts/build.ts did not copy sqlite-vec vec0.so to dist/lib/`);
}

// ---------------------------------------------------------------------------
// Tmp home dir for isolated smoke run
// ---------------------------------------------------------------------------
// ConfigManager reads port from homeDir/.goodvibes/tui/settings.json.
// GOODVIBES_CONTROL_PLANE_PORT is NOT honoured by the SDK — the port must be
// set in the settings file so the daemon binds on the expected smoke port.

const smokeTmpDir = join(tmpdir(), `goodvibes-smoke-${process.pid}`);
const settingsDir = join(smokeTmpDir, '.goodvibes', 'tui');
mkdirSync(settingsDir, { recursive: true });
writeFileSync(
  join(settingsDir, 'settings.json'),
  JSON.stringify({
    controlPlane: { port: SMOKE_PORT, enabled: true },
    danger: { daemon: true },
  }, null, 2),
  'utf-8',
);
console.log(`[smoke] Tmp home: ${smokeTmpDir}`);

console.log(`[smoke] Spawning daemon on port ${SMOKE_PORT}...`);

const daemonProc = spawn(BINARY, [], {
  env: {
    ...process.env,
    // Token auth: readDaemonCliTokens() reads GOODVIBES_DAEMON_TOKEN from env.
    GOODVIBES_DAEMON_TOKEN: SMOKE_TOKEN,
    GOODVIBES_HTTP_TOKEN: SMOKE_TOKEN,
    // Point the daemon at the smoke tmp dir so ConfigManager picks up our port.
    GOODVIBES_DAEMON_HOME: smokeTmpDir,
    // Working dir for the smoke run — keeps any session/project state out of the
    // real project root.
    GOODVIBES_WORKING_DIR: smokeTmpDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const stdoutChunks: Buffer[] = [];
const stderrChunks: Buffer[] = [];
daemonProc.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
daemonProc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

let daemonExited = false;
daemonProc.on('exit', (code) => {
  daemonExited = true;
  if (code !== 0 && code !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf-8');
    console.error(`[smoke] Daemon exited early with code ${code}`);
    if (stderr) console.error(`[smoke] stderr:\n${stderr}`);
  }
});

// ---------------------------------------------------------------------------
// Poll until ready
// ---------------------------------------------------------------------------

const ready = await waitForDaemon(SMOKE_PORT, SMOKE_TOKEN, STARTUP_TIMEOUT_MS);
if (!ready) {
  daemonProc.kill('SIGTERM');
  const stderr = Buffer.concat(stderrChunks).toString('utf-8');
  console.error(`[smoke] Daemon did not become ready within ${STARTUP_TIMEOUT_MS}ms`);
  if (stderr) console.error(`[smoke] stderr:\n${stderr}`);
  fail('Daemon startup timeout');
}

console.log('[smoke] Daemon is ready. Running checks...');

let pass = true;

// ---------------------------------------------------------------------------
// Check 1: GET /api/health
// ---------------------------------------------------------------------------

const health = await fetchJson(`http://127.0.0.1:${SMOKE_PORT}/api/health`, SMOKE_TOKEN);
console.log(`[smoke] GET /api/health → ${health.status}`);
if (health.status !== 200) {
  console.error(`[smoke] FAIL: /api/health returned ${health.status}: ${health.body}`);
  pass = false;
} else {
  console.log('[smoke] PASS: /api/health = 200');
}

// ---------------------------------------------------------------------------
// Check 2: GET /api/memory/vector — assert no sqlite-vec error
// ---------------------------------------------------------------------------

const vector = await fetchJson(`http://127.0.0.1:${SMOKE_PORT}/api/memory/vector`, SMOKE_TOKEN);
console.log(`[smoke] GET /api/memory/vector → ${vector.status}`);
const sqliteVecError = vector.body.toLowerCase().includes('sqlite-vec') &&
  (vector.body.toLowerCase().includes('error') || vector.body.toLowerCase().includes('fail'));
if (sqliteVecError) {
  console.error(`[smoke] FAIL: /api/memory/vector response contains sqlite-vec error:\n${vector.body}`);
  pass = false;
} else if (vector.status >= 500) {
  console.error(`[smoke] FAIL: /api/memory/vector returned ${vector.status}: ${vector.body}`);
  pass = false;
} else {
  console.log(`[smoke] PASS: /api/memory/vector = ${vector.status} (no sqlite-vec error)`);
}

// ---------------------------------------------------------------------------
// Check 3: Assert no sqlite-vec error in daemon stderr
// ---------------------------------------------------------------------------

const stderrSoFar = Buffer.concat(stderrChunks).toString('utf-8');
if (stderrSoFar.toLowerCase().includes('sqlite-vec') && stderrSoFar.toLowerCase().includes('error')) {
  console.error(`[smoke] FAIL: sqlite-vec error detected in daemon stderr:\n${stderrSoFar}`);
  pass = false;
} else {
  console.log('[smoke] PASS: no sqlite-vec errors in daemon stderr');
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

daemonProc.kill('SIGTERM');
await new Promise<void>((resolve) => {
  const t = setTimeout(() => {
    daemonProc.kill('SIGKILL');
    resolve();
  }, 3000);
  daemonProc.on('exit', () => {
    clearTimeout(t);
    resolve();
  });
});

// Clean up tmp home dir
try { rmSync(smokeTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }

if (pass) {
  console.log('[smoke] All checks passed.');
  process.exit(0);
} else {
  fail('One or more smoke checks failed.');
}
