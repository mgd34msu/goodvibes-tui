import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TUI_ROOT = resolve(__dirname, '..');
const TMP_ROOT = resolve(TUI_ROOT, '.tmp');
const LOCK_DIR = resolve(TMP_ROOT, 'workspace.lock');
const LOCK_INFO_PATH = resolve(LOCK_DIR, 'owner.json');
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const STALE_AFTER_MS = 15 * 60 * 1000;
const POLL_MS = 200;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface LockInfo {
  readonly pid: number;
  readonly label: string;
  readonly startedAt: number;
}

function readLockInfo(): LockInfo | null {
  try {
    return JSON.parse(readFileSync(LOCK_INFO_PATH, 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearStaleLock(): void {
  if (!existsSync(LOCK_DIR)) return;
  const info = readLockInfo();
  if (!info) {
    rmSync(LOCK_DIR, { recursive: true, force: true });
    return;
  }
  const staleByAge = Date.now() - info.startedAt > STALE_AFTER_MS;
  const staleByPid = !isProcessAlive(info.pid);
  if (staleByAge || staleByPid) {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

export function withWorkspaceLock<T>(label: string, fn: () => T, timeoutMs = DEFAULT_TIMEOUT_MS): T {
  mkdirSync(TMP_ROOT, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    clearStaleLock();
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(
        LOCK_INFO_PATH,
        `${JSON.stringify({ pid: process.pid, label, startedAt: Date.now() } satisfies LockInfo, null, 2)}\n`,
        'utf8',
      );
      break;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
        throw error;
      }
      if (Date.now() > deadline) {
        const info = readLockInfo();
        const owner = info
          ? `${info.label} (pid ${info.pid}, started ${new Date(info.startedAt).toISOString()})`
          : 'unknown owner';
        throw new Error(`Timed out acquiring workspace lock for ${label}; current owner: ${owner}`);
      }
      sleep(POLL_MS);
    }
  }

  try {
    return fn();
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}
