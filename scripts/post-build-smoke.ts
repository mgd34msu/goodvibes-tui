/**
 * Post-build smoke test for the daemon binary.
 *
 * Spawns the platform-appropriate daemon binary, auto-detected from
 * process.platform/process.arch (dist/goodvibes-daemon-<platform>-<arch>:
 * linux-x64, linux-arm64, darwin-x64, darwin-arm64), waits for it to be
 * ready, curls /api/health and /api/memory/vector, and asserts no
 * sqlite-vec errors. The sqlite-vec addon path is detected the same way.
 *
 * Exit 0 = pass, exit 1 = fail.
 *
 * Usage:
 *   bun run scripts/post-build-smoke.ts
 *   bun run scripts/post-build-smoke.ts --binary dist/goodvibes-daemon-<platform>-<arch>
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

function defaultDaemonBinary(): string {
  if (process.platform === 'linux' && process.arch === 'x64') return join(root, 'dist', 'goodvibes-daemon-linux-x64');
  if (process.platform === 'linux' && process.arch === 'arm64') return join(root, 'dist', 'goodvibes-daemon-linux-arm64');
  if (process.platform === 'darwin' && process.arch === 'x64') return join(root, 'dist', 'goodvibes-daemon-macos-x64');
  if (process.platform === 'darwin' && process.arch === 'arm64') return join(root, 'dist', 'goodvibes-daemon-macos-arm64');
  return join(root, 'dist', 'goodvibes-daemon-linux-x64');
}

const BINARY = binaryIdx !== -1 && args[binaryIdx + 1]
  ? args[binaryIdx + 1]
  : defaultDaemonBinary();

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
// Addon directory and filename are platform-specific.
function resolveAddonPath(): string {
  if (process.platform === 'linux' && process.arch === 'x64') return join(root, 'dist', 'lib', 'sqlite-vec-linux-x64', 'vec0.so');
  if (process.platform === 'linux' && process.arch === 'arm64') return join(root, 'dist', 'lib', 'sqlite-vec-linux-arm64', 'vec0.so');
  if (process.platform === 'darwin' && process.arch === 'x64') return join(root, 'dist', 'lib', 'sqlite-vec-darwin-x64', 'vec0.dylib');
  if (process.platform === 'darwin' && process.arch === 'arm64') return join(root, 'dist', 'lib', 'sqlite-vec-darwin-arm64', 'vec0.dylib');
  return join(root, 'dist', 'lib', 'sqlite-vec-linux-x64', 'vec0.so');
}
const addonPath = resolveAddonPath();
if (!existsSync(addonPath)) {
  fail(`Native addon missing: ${addonPath} — regression: the binary build (goodvibes-build-binaries) did not copy the sqlite-vec addon to dist/lib/`);
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
    // A compiled standalone daemon self-promotes at its first idle moment:
    // it installs a service unit and exits 0, handing over to the supervised
    // instance (SDK DaemonServer boot promotion). In this smoke that idle
    // moment arrives immediately after startup, so the daemon would die
    // between the readiness poll and the health check. service.enabled=false
    // is the SDK's designed opt-out — the smoke validates that the binary
    // boots and serves HTTP, not service adoption.
    service: { enabled: false },
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
