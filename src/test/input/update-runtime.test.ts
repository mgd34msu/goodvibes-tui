import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll } from 'bun:test';
import {
  applyUpdate,
  checkForUpdate,
  createUpdateSwapProgress,
  detectDaemonServiceManaged,
  rollbackUpdate,
  PREVIOUS_FILE_SUFFIX,
  UPDATE_ABORTED_MESSAGE,
  type ApplyUpdateOptions,
  type RunCommand,
} from '../../input/commands/update-runtime.ts';
import type { UpdateFetchLike } from '../../runtime/update-check.ts';
import { realUpdateFileIo, type UpdateFileIo } from '@pellux/goodvibes-sdk/platform/runtime/self-update';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// This suite pins fixture versions ('1.0.0' / '1.1.0' / 'v9.9.9') rather than
// the live build VERSION, per this repo's rule that tests must never compare
// against the running package version (which shifts on every release bump).
// All network access goes through a stubbed fetchImpl — nothing here makes a
// live call.

interface FakeResponseSpec {
  readonly ok?: boolean;
  readonly status?: number;
  readonly url?: string;
  readonly location?: string | null;
  readonly text?: string;
  readonly buffer?: Buffer;
}

function fakeResponse(spec: FakeResponseSpec) {
  return {
    ok: spec.ok ?? true,
    status: spec.status ?? 200,
    url: spec.url ?? '',
    headers: { get: (name: string) => (name.toLowerCase() === 'location' ? spec.location ?? null : null) },
    text: async () => spec.text ?? '',
    arrayBuffer: async () => {
      const buf = spec.buffer ?? Buffer.alloc(0);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
}

const RELEASES_LATEST_URL = 'https://github.com/mgd34msu/goodvibes-tui/releases/latest';

function buildStubFetch(options: {
  readonly latestTag: string;
  readonly checksumText?: string;
  readonly appBuffer?: Buffer;
  readonly daemonBuffer?: Buffer;
  readonly addonBuffer?: Buffer;
  readonly calls?: string[];
}): UpdateFetchLike {
  const calls = options.calls ?? [];
  return (async (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === RELEASES_LATEST_URL) {
      return fakeResponse({
        status: 302,
        location: `https://github.com/mgd34msu/goodvibes-tui/releases/tag/${options.latestTag}`,
      });
    }
    if (url.endsWith('SHA256SUMS.txt')) {
      return fakeResponse({ text: options.checksumText ?? '' });
    }
    if (url.endsWith('sqlite-vec-linux-x64.so')) {
      return fakeResponse({ buffer: options.addonBuffer ?? Buffer.from('addon-bytes') });
    }
    if (url.endsWith('goodvibes-daemon-linux-x64')) {
      return fakeResponse({ buffer: options.daemonBuffer ?? Buffer.from('daemon-bytes') });
    }
    if (/goodvibes-linux-x64$/.test(url)) {
      return fakeResponse({ buffer: options.appBuffer ?? Buffer.from('app-bytes') });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as UpdateFetchLike;
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * In-memory UpdateFileIo — the SDK-backed swap path runs for real against a
 * virtual filesystem, so the tests observe genuine verify-before-write and
 * kept-.previous behavior without touching the host.
 */
function memoryIo(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, Buffer>(
    Object.entries(initialFiles).map(([path, content]) => [path, Buffer.from(content)]),
  );
  const mutations: string[] = [];
  const io: UpdateFileIo = {
    writeFile: (path, data) => {
      files.set(path, Buffer.from(data));
      mutations.push(`write ${path}`);
    },
    rename: (from, to) => {
      const buffer = files.get(from);
      if (buffer === undefined) throw new Error(`rename of missing file in test io: ${from}`);
      files.delete(from);
      files.set(to, buffer);
      mutations.push(`rename ${from} -> ${to}`);
    },
    chmod: () => {},
    exists: (path) => files.has(path),
    mkdir: () => {},
  };
  return {
    io,
    mutations,
    read: (path: string) => files.get(path)?.toString(),
    has: (path: string) => files.has(path),
  };
}

function baseApplyOptions(overrides: Partial<ApplyUpdateOptions>): ApplyUpdateOptions {
  const printed: string[] = [];
  return {
    fetchImpl: buildStubFetch({ latestTag: 'v1.0.0' }),
    execPath: '/home/user/.local/bin/goodvibes',
    platform: 'linux',
    arch: 'x64',
    currentVersion: '1.0.0',
    print: (line) => printed.push(line),
    configManager: { get: () => undefined },
    io: memoryIo().io,
    ...overrides,
  };
}

describe('applyUpdate — non-binary install kinds never attempt a swap', () => {
  test('running from source prints the curl installer one-liner and makes no download calls', async () => {
    const printed: string[] = [];
    const calls: string[] = [];
    await applyUpdate(
      baseApplyOptions({
        execPath: '/home/user/.bun/bin/bun',
        fetchImpl: buildStubFetch({ latestTag: 'v9.9.9', calls }),
        print: (line) => printed.push(line),
      }),
    );
    expect(calls).toEqual([]); // never even checks the network for a non-binary install
    expect(printed.join('\n')).toContain('curl -fsSL https://goodvibes.sh/install.sh | sh');
    expect(printed.join('\n')).toContain('running from source');
  });

  test('a bun-global package install prints the bun add -g command and makes no download calls', async () => {
    const printed: string[] = [];
    const calls: string[] = [];
    await applyUpdate(
      baseApplyOptions({
        execPath: '/home/user/.bun/install/global/node_modules/@pellux/goodvibes-tui/vendor/goodvibes-linux-x64',
        fetchImpl: buildStubFetch({ latestTag: 'v9.9.9', calls }),
        print: (line) => printed.push(line),
      }),
    );
    expect(calls).toEqual([]);
    expect(printed.join('\n')).toContain('bun add -g @pellux/goodvibes-tui');
  });
});

describe('applyUpdate — binary install, version comparison', () => {
  test('reports already current honestly and does not download artifacts', async () => {
    const printed: string[] = [];
    const calls: string[] = [];
    await applyUpdate(
      baseApplyOptions({
        currentVersion: '1.0.0',
        fetchImpl: buildStubFetch({ latestTag: 'v1.0.0', calls }),
        print: (line) => printed.push(line),
      }),
    );
    expect(calls).toEqual([`HEAD ${RELEASES_LATEST_URL}`]);
    expect(printed.join('\n')).toContain('Already current');
    expect(printed.join('\n')).toContain('1.0.0');
  });

  test('reports already current when the running build is even newer than the latest tag', async () => {
    const printed: string[] = [];
    await applyUpdate(
      baseApplyOptions({
        currentVersion: '2.0.0',
        fetchImpl: buildStubFetch({ latestTag: 'v1.9.9' }),
        print: (line) => printed.push(line),
      }),
    );
    expect(printed.join('\n')).toContain('Already current');
  });
});

describe('applyUpdate — binary install, checksum verification', () => {
  const APP_PATH = '/home/user/.local/bin/goodvibes';
  const DAEMON_PATH = '/home/user/.local/bin/goodvibes-daemon';
  const ADDON_PATH = '/home/user/.local/bin/lib/sqlite-vec-linux-x64/vec0.so';

  test('a missing manifest entry hard-fails the update and never swaps either binary', async () => {
    const fs = memoryIo({ [APP_PATH]: 'old-app', [DAEMON_PATH]: 'old-daemon' });
    const checksumText = ''; // no entries at all for either artifact
    const options = baseApplyOptions({
      currentVersion: '1.0.0',
      fetchImpl: buildStubFetch({ latestTag: 'v1.1.0', checksumText }),
      io: fs.io,
    });
    await expect(applyUpdate(options)).rejects.toThrow(/no checksum entry for goodvibes-linux-x64/);
    expect(fs.mutations).toEqual([]);
    expect(fs.read(APP_PATH)).toBe('old-app');
    expect(fs.read(DAEMON_PATH)).toBe('old-daemon');
  });

  test('a checksum mismatch on the daemon artifact hard-fails and never swaps either binary, even though the app checksum matched', async () => {
    const appBuffer = Buffer.from('app-bytes');
    const daemonBuffer = Buffer.from('daemon-bytes');
    const appHash = sha256Hex(appBuffer);
    const checksumText = [`${appHash}  goodvibes-linux-x64`, `${'0'.repeat(64)}  goodvibes-daemon-linux-x64`].join('\n');
    const fs = memoryIo({ [APP_PATH]: 'old-app', [DAEMON_PATH]: 'old-daemon' });
    const options = baseApplyOptions({
      currentVersion: '1.0.0',
      fetchImpl: buildStubFetch({ latestTag: 'v1.1.0', checksumText, appBuffer, daemonBuffer }),
      io: fs.io,
    });
    await expect(applyUpdate(options)).rejects.toThrow(/checksum mismatch for goodvibes-daemon-linux-x64/);
    expect(fs.mutations).toEqual([]);
    expect(fs.read(APP_PATH)).toBe('old-app');
    expect(fs.read(DAEMON_PATH)).toBe('old-daemon');
  });

  test('matching checksums for both artifacts swap both binaries atomically and place the sqlite-vec addon', async () => {
    const appBuffer = Buffer.from('new-app-bytes');
    const daemonBuffer = Buffer.from('new-daemon-bytes');
    const addonBuffer = Buffer.from('new-addon-bytes');
    const checksumText = [
      `${sha256Hex(appBuffer)}  goodvibes-linux-x64`,
      `${sha256Hex(daemonBuffer)}  goodvibes-daemon-linux-x64`,
      `${sha256Hex(addonBuffer)}  sqlite-vec-linux-x64.so`,
    ].join('\n');
    const fs = memoryIo({ [APP_PATH]: 'old-app-bytes', [DAEMON_PATH]: 'old-daemon-bytes' });
    const printed: string[] = [];
    const options = baseApplyOptions({
      execPath: APP_PATH,
      currentVersion: '1.0.0',
      fetchImpl: buildStubFetch({ latestTag: 'v1.1.0', checksumText, appBuffer, daemonBuffer, addonBuffer }),
      io: fs.io,
      print: (line) => printed.push(line),
    });
    await applyUpdate(options);
    expect(fs.read(APP_PATH)).toBe('new-app-bytes');
    expect(fs.read(DAEMON_PATH)).toBe('new-daemon-bytes');
    // Every swap keeps the outgoing file at `<path>.previous`.
    expect(fs.read(`${APP_PATH}${PREVIOUS_FILE_SUFFIX}`)).toBe('old-app-bytes');
    expect(fs.read(`${DAEMON_PATH}${PREVIOUS_FILE_SUFFIX}`)).toBe('old-daemon-bytes');
    // The addon lands at <execDir>/lib/sqlite-vec-<os>-<arch>/vec0.<suffix> — the
    // exact path the SDK's loader resolves next to the running binary.
    expect(fs.read(ADDON_PATH)).toBe('new-addon-bytes');
    expect(printed.join('\n')).toContain('Updated to v1.1.0');
    expect(printed.join('\n')).toContain(ADDON_PATH);
  });

  test('a target release that predates the sqlite-vec addon (no manifest entry) still swaps the binaries and simply skips the addon', async () => {
    const appBuffer = Buffer.from('new-app-bytes');
    const daemonBuffer = Buffer.from('new-daemon-bytes');
    // Binaries have valid entries; the addon has none. A pre-addon release must
    // not block an otherwise-valid binary update — the addon is skipped, never
    // placed unverified.
    const checksumText = [
      `${sha256Hex(appBuffer)}  goodvibes-linux-x64`,
      `${sha256Hex(daemonBuffer)}  goodvibes-daemon-linux-x64`,
    ].join('\n');
    const fs = memoryIo({ [APP_PATH]: 'old-app', [DAEMON_PATH]: 'old-daemon' });
    const options = baseApplyOptions({
      currentVersion: '1.0.0',
      fetchImpl: buildStubFetch({ latestTag: 'v1.1.0', checksumText, appBuffer, daemonBuffer }),
      io: fs.io,
    });
    await applyUpdate(options);
    expect(fs.read(APP_PATH)).toBe('new-app-bytes');
    expect(fs.read(DAEMON_PATH)).toBe('new-daemon-bytes');
    expect(fs.has(ADDON_PATH)).toBe(false);
  });

  test('a checksum mismatch on the sqlite-vec addon hard-fails and never swaps a binary or writes the addon', async () => {
    const appBuffer = Buffer.from('new-app-bytes');
    const daemonBuffer = Buffer.from('new-daemon-bytes');
    const addonBuffer = Buffer.from('new-addon-bytes');
    const checksumText = [
      `${sha256Hex(appBuffer)}  goodvibes-linux-x64`,
      `${sha256Hex(daemonBuffer)}  goodvibes-daemon-linux-x64`,
      `${'0'.repeat(64)}  sqlite-vec-linux-x64.so`,
    ].join('\n');
    const fs = memoryIo({ [APP_PATH]: 'old-app', [DAEMON_PATH]: 'old-daemon' });
    const options = baseApplyOptions({
      currentVersion: '1.0.0',
      fetchImpl: buildStubFetch({ latestTag: 'v1.1.0', checksumText, appBuffer, daemonBuffer, addonBuffer }),
      io: fs.io,
    });
    await expect(applyUpdate(options)).rejects.toThrow(/checksum mismatch for sqlite-vec-linux-x64\.so/);
    expect(fs.mutations).toEqual([]);
    expect(fs.read(APP_PATH)).toBe('old-app');
    expect(fs.has(ADDON_PATH)).toBe(false);
  });

  test('when the daemon binary is not present at its expected sibling location, only the app binary is swapped and the message says so honestly', async () => {
    const appBuffer = Buffer.from('new-app-bytes');
    const addonBuffer = Buffer.from('new-addon-bytes');
    const checksumText = [
      `${sha256Hex(appBuffer)}  goodvibes-linux-x64`,
      `${sha256Hex(addonBuffer)}  sqlite-vec-linux-x64.so`,
    ].join('\n');
    const fs = memoryIo({ [APP_PATH]: 'old-app' }); // no daemon binary next to the app binary
    const printed: string[] = [];
    const options = baseApplyOptions({
      currentVersion: '1.0.0',
      fetchImpl: buildStubFetch({ latestTag: 'v1.1.0', checksumText, appBuffer, addonBuffer }),
      io: fs.io,
      print: (line) => printed.push(line),
    });
    await applyUpdate(options);
    expect(fs.read(APP_PATH)).toBe('new-app-bytes');
    expect(fs.has(DAEMON_PATH)).toBe(false);
    // The addon is refreshed regardless of whether the daemon binary is present —
    // it serves the app binary too.
    expect(fs.read(ADDON_PATH)).toBe('new-addon-bytes');
    expect(printed.join('\n')).toContain('not found at');
    expect(printed.join('\n')).toContain('left untouched');
  });
});

describe('applyUpdate — cancellation, honoured only up to the moment before the swap', () => {
  const APP_PATH = '/home/user/.local/bin/goodvibes';

  test('an already-aborted signal stops the update before the first request and before any file is touched', async () => {
    const calls: string[] = [];
    const fs = memoryIo({ [APP_PATH]: 'old-app' });
    const controller = new AbortController();
    controller.abort();
    const progress = createUpdateSwapProgress();

    await expect(
      applyUpdate(
        baseApplyOptions({
          execPath: APP_PATH,
          currentVersion: '1.0.0',
          fetchImpl: buildStubFetch({ latestTag: 'v1.1.0', calls }),
          io: fs.io,
          signal: controller.signal,
          progress,
        }),
      ),
    ).rejects.toThrow(UPDATE_ABORTED_MESSAGE);

    expect(calls).toEqual([]); // not one request, let alone a download
    expect(fs.mutations).toEqual([]);
    expect(fs.read(APP_PATH)).toBe('old-app');
    expect(progress).toEqual({ begun: false, committed: false, targetTag: null });
  });

  test('an abort that lands between steps stops at the next boundary: the manifest is never requested and nothing swaps', async () => {
    const calls: string[] = [];
    const fs = memoryIo({ [APP_PATH]: 'old-app' });
    const controller = new AbortController();
    const progress = createUpdateSwapProgress();
    const tagFetch = buildStubFetch({ latestTag: 'v1.1.0', calls });
    // Cancelled while the version lookup is in flight: the tag still resolves,
    // and the step after it is the one that must not run.
    const fetchImpl: UpdateFetchLike = async (url, init) => {
      const response = await tagFetch(url, init);
      controller.abort();
      return response;
    };

    await expect(
      applyUpdate(
        baseApplyOptions({
          execPath: APP_PATH,
          currentVersion: '1.0.0',
          fetchImpl,
          io: fs.io,
          signal: controller.signal,
          progress,
        }),
      ),
    ).rejects.toThrow(UPDATE_ABORTED_MESSAGE);

    expect(calls).toEqual([`HEAD ${RELEASES_LATEST_URL}`]);
    expect(fs.mutations).toEqual([]);
    expect(fs.read(APP_PATH)).toBe('old-app');
    // The target is already named, so a caller that gave up can still say
    // which version was on the way — but nothing was begun or committed.
    expect(progress.targetTag).toBe('v1.1.0');
    expect(progress.begun).toBe(false);
    expect(progress.committed).toBe(false);
  });

  test('the signal rides on every request, so the download itself is cancellable rather than merely abandoned', async () => {
    const seenSignals: Array<AbortSignal | undefined> = [];
    const controller = new AbortController();
    const appBuffer = Buffer.from('new-app-bytes');
    const checksumText = `${sha256Hex(appBuffer)}  goodvibes-linux-x64\n`;
    const inner = buildStubFetch({ latestTag: 'v1.1.0', checksumText, appBuffer });
    const fetchImpl = (async (url: string, init?: { method?: string; signal?: AbortSignal }) => {
      seenSignals.push(init?.signal);
      return await inner(url, init);
    }) as UpdateFetchLike;

    await applyUpdate(
      baseApplyOptions({
        execPath: APP_PATH,
        currentVersion: '1.0.0',
        fetchImpl,
        io: memoryIo({ [APP_PATH]: 'old-app' }).io,
        signal: controller.signal,
      }),
    );

    // Tag lookup, manifest pre-read, manifest again inside the verified apply,
    // and the app artifact — every one of them carrying the caller's signal.
    expect(seenSignals.length).toBeGreaterThanOrEqual(4);
    expect(seenSignals.every((signal) => signal === controller.signal)).toBe(true);
  });
});

describe('checkForUpdate', () => {
  test('reports isCurrent=true when the running version matches the latest tag', async () => {
    const result = await checkForUpdate(buildStubFetch({ latestTag: 'v1.0.0' }), '1.0.0');
    expect(result).toEqual({ latestTag: 'v1.0.0', isCurrent: true });
  });

  test('reports isCurrent=false and the real latest tag when a newer release exists', async () => {
    const result = await checkForUpdate(buildStubFetch({ latestTag: 'v1.2.0' }), '1.0.0');
    expect(result).toEqual({ latestTag: 'v1.2.0', isCurrent: false });
  });
});

describe('detectDaemonServiceManaged', () => {
  const activeRunner: RunCommand = () => ({ status: 0, stdout: 'active\n' });
  const inactiveRunner: RunCommand = () => ({ status: 3, stdout: 'inactive\n' });

  test('reports managed with the real restart command when systemctl reports the unit active on Linux', () => {
    const info = detectDaemonServiceManaged('linux', { get: () => undefined }, activeRunner);
    expect(info.managed).toBe(true);
    expect(info.restartCommand).toBe('systemctl --user restart goodvibes.service');
  });

  test('reports not managed when the unit is not active', () => {
    const info = detectDaemonServiceManaged('linux', { get: () => undefined }, inactiveRunner);
    expect(info.managed).toBe(false);
  });

  test('honors a configured non-default service name', () => {
    const info = detectDaemonServiceManaged('linux', { get: (key) => (key === 'service.serviceName' ? 'my-goodvibes' : undefined) }, activeRunner);
    expect(info.restartCommand).toBe('systemctl --user restart my-goodvibes.service');
  });

  test('reports not managed on non-Linux platforms without shelling out at all', () => {
    let called = false;
    const info = detectDaemonServiceManaged('darwin', { get: () => undefined }, () => {
      called = true;
      return { status: 0, stdout: 'active' };
    });
    expect(info.managed).toBe(false);
    expect(called).toBe(false);
  });
});

// ─── keep-previous swap + one-command rollback ───────────────────────────────

const scratchDirs: string[] = [];
function scratchDir(): string {
  const dir = makeProjectTempDir('gv-update-rollback');
  scratchDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('applyUpdate — the real swap keeps the outgoing binary at .previous', () => {
  test('after an update the target holds the new bytes and .previous holds the old ones', async () => {
    const dir = scratchDir();
    const execPath = join(dir, 'goodvibes');
    writeFileSync(execPath, 'old-app-bytes');

    const appBuffer = Buffer.from('new-app-bytes');
    const checksumText = `${sha256Hex(appBuffer)}  goodvibes-linux-x64\n`;
    const printed: string[] = [];
    // No swap/writeAddon/fileExists seams: this test exercises the REAL
    // filesystem swap inside a scratch directory (no daemon binary present,
    // no addon entry in the manifest, so only the app binary swaps).
    await applyUpdate({
      fetchImpl: buildStubFetch({ latestTag: 'v1.1.0', checksumText, appBuffer }),
      execPath,
      platform: 'linux',
      arch: 'x64',
      currentVersion: '1.0.0',
      print: (line) => printed.push(line),
      configManager: { get: () => undefined },
      runCommand: () => ({ status: 3, stdout: '' }),
    });

    expect(readFileSync(execPath, 'utf-8')).toBe('new-app-bytes');
    expect(readFileSync(`${execPath}${PREVIOUS_FILE_SUFFIX}`, 'utf-8')).toBe('old-app-bytes');
    expect(printed.join('\n')).toContain('Updated to v1.1.0.');
  });

  test('an abort raised the instant the swap starts writing never interrupts it: the new bytes land and .previous still holds the old ones', async () => {
    const dir = scratchDir();
    const execPath = join(dir, 'goodvibes');
    writeFileSync(execPath, 'old-app-bytes');

    const appBuffer = Buffer.from('new-app-bytes');
    const checksumText = `${sha256Hex(appBuffer)}  goodvibes-linux-x64\n`;
    const controller = new AbortController();
    const progress = createUpdateSwapProgress();
    // Fires on the first byte the swap writes — the exact boundary past which
    // cancellation must have no effect at all. Everything else is the REAL
    // filesystem swap, in a scratch directory.
    const io: UpdateFileIo = {
      ...realUpdateFileIo,
      writeFile: (path, data) => {
        controller.abort();
        realUpdateFileIo.writeFile(path, data);
      },
    };

    await applyUpdate({
      fetchImpl: buildStubFetch({ latestTag: 'v1.1.0', checksumText, appBuffer }),
      execPath,
      platform: 'linux',
      arch: 'x64',
      currentVersion: '1.0.0',
      print: () => {},
      configManager: { get: () => undefined },
      runCommand: () => ({ status: 3, stdout: '' }),
      io,
      signal: controller.signal,
      progress,
    });

    expect(readFileSync(execPath, 'utf-8')).toBe('new-app-bytes');
    expect(readFileSync(`${execPath}${PREVIOUS_FILE_SUFFIX}`, 'utf-8')).toBe('old-app-bytes');
    expect(progress.begun).toBe(true);
    expect(progress.committed).toBe(true);
  });
});

describe('rollbackUpdate — one command back to the version that ran before', () => {
  const inactiveRunner: RunCommand = () => ({ status: 3, stdout: '' });

  test('exchanges each file with its kept .previous counterpart, so a second rollback rolls forward', () => {
    const dir = scratchDir();
    const execPath = join(dir, 'goodvibes');
    const daemonPath = join(dir, 'goodvibes-daemon');
    writeFileSync(execPath, 'new-app');
    writeFileSync(`${execPath}${PREVIOUS_FILE_SUFFIX}`, 'old-app');
    writeFileSync(daemonPath, 'new-daemon');
    writeFileSync(`${daemonPath}${PREVIOUS_FILE_SUFFIX}`, 'old-daemon');

    const printed: string[] = [];
    rollbackUpdate({
      execPath,
      platform: 'linux',
      arch: 'x64',
      print: (line) => printed.push(line),
      configManager: { get: () => undefined },
      runCommand: inactiveRunner,
    });

    expect(readFileSync(execPath, 'utf-8')).toBe('old-app');
    expect(readFileSync(`${execPath}${PREVIOUS_FILE_SUFFIX}`, 'utf-8')).toBe('new-app');
    expect(readFileSync(daemonPath, 'utf-8')).toBe('old-daemon');
    expect(readFileSync(`${daemonPath}${PREVIOUS_FILE_SUFFIX}`, 'utf-8')).toBe('new-daemon');
    expect(printed.join('\n')).toContain('Rolled back to the previously installed version.');

    // Roll forward again: the exchange is symmetric.
    rollbackUpdate({
      execPath,
      platform: 'linux',
      arch: 'x64',
      print: () => {},
      configManager: { get: () => undefined },
      runCommand: inactiveRunner,
    });
    expect(readFileSync(execPath, 'utf-8')).toBe('new-app');
    expect(readFileSync(daemonPath, 'utf-8')).toBe('new-daemon');
  });

  test('restores the kept vector addon alongside the binaries', () => {
    const dir = scratchDir();
    const execPath = join(dir, 'goodvibes');
    writeFileSync(execPath, 'new-app');
    writeFileSync(`${execPath}${PREVIOUS_FILE_SUFFIX}`, 'old-app');
    const addonDir = join(dir, 'lib', 'sqlite-vec-linux-x64');
    mkdirSync(addonDir, { recursive: true });
    const addonPath = join(addonDir, 'vec0.so');
    writeFileSync(addonPath, 'new-addon');
    writeFileSync(`${addonPath}${PREVIOUS_FILE_SUFFIX}`, 'old-addon');

    const printed: string[] = [];
    rollbackUpdate({
      execPath,
      platform: 'linux',
      arch: 'x64',
      print: (line) => printed.push(line),
      configManager: { get: () => undefined },
      runCommand: inactiveRunner,
    });

    expect(readFileSync(addonPath, 'utf-8')).toBe('old-addon');
    expect(readFileSync(`${addonPath}${PREVIOUS_FILE_SUFFIX}`, 'utf-8')).toBe('new-addon');
    expect(printed.join('\n')).toContain('vector addon');
  });

  test('with nothing kept, says so honestly and touches nothing', () => {
    const dir = scratchDir();
    const execPath = join(dir, 'goodvibes');
    writeFileSync(execPath, 'only-version');

    const printed: string[] = [];
    rollbackUpdate({
      execPath,
      platform: 'linux',
      arch: 'x64',
      print: (line) => printed.push(line),
      configManager: { get: () => undefined },
      runCommand: inactiveRunner,
    });

    expect(readFileSync(execPath, 'utf-8')).toBe('only-version');
    expect(printed.join('\n')).toContain('No previous version is kept beside this install');
  });

  test('non-binary installs are refused with the package-manager alternative', () => {
    const printed: string[] = [];
    const fs = memoryIo({ '/home/u/.bun/install/global/node_modules/@pellux/goodvibes-tui/bin/goodvibes': 'pkg' });
    rollbackUpdate({
      execPath: '/home/u/.bun/install/global/node_modules/@pellux/goodvibes-tui/bin/goodvibes',
      platform: 'linux',
      arch: 'x64',
      print: (line) => printed.push(line),
      configManager: { get: () => undefined },
      runCommand: inactiveRunner,
      io: fs.io,
    });
    expect(fs.mutations).toEqual([]);
    expect(printed.join('\n')).toContain('bun add -g @pellux/goodvibes-tui');
  });
});
