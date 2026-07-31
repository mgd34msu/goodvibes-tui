import { describe, expect, test } from 'bun:test';
import {
  DAEMON_REPO_RELEASES_LATEST_URL,
  DAEMON_SPLIT_FLOOR_VERSION,
  createDaemonHandoverProgress,
  daemonReleaseDownloadBaseUrl,
  decideDaemonHandover,
  isPreSplitDaemonVersion,
  parseDaemonVersionOutput,
  performDaemonHandover,
  readInstalledDaemonVersion,
  restartHandedOverDaemon,
  runDaemonHandover,
  type PerformDaemonHandoverOptions,
  type RunCommandLike,
  type RunDaemonHandoverOptions,
} from '@pellux/goodvibes-sdk/platform/runtime/client';
import type { UpdateFileIo } from '@pellux/goodvibes-sdk/platform/runtime/self-update';
import type { UpdateFetchLike } from '@/runtime/update-check.ts';

// Pins the old→new daemon handover. Every seam is stubbed: the `--version`
// probe never spawns a binary, fetch never reaches the network, the filesystem
// is a map, and systemctl is a recorded call list. Versions are fixtures
// ('1.27.1' as the shipped pre-split build, 'v1.28.0' as the first release from
// the daemon's own repository) — never the live build VERSION.

const PRE_SPLIT_VERSION = '1.27.1';
const SPLIT_TAG = 'v1.28.0';
const DAEMON_PATH = '/home/op/.local/bin/goodvibes-daemon';
const DAEMON_ASSET = 'goodvibes-daemon-linux-x64';

/** A run-command stub whose `--version` answer and systemctl answers are scripted. */
function stubRunCommand(script: {
  readonly version?: { status: number | null; stdout: string };
  readonly isActive?: { status: number | null; stdout: string };
  readonly restart?: { status: number | null; stdout: string };
  readonly calls?: string[][];
}): RunCommandLike {
  return (command, args) => {
    script.calls?.push([command, ...args]);
    if (args[0] === '--version') return script.version ?? { status: 0, stdout: `goodvibes-daemon ${PRE_SPLIT_VERSION}\n` };
    if (args.includes('is-active')) return script.isActive ?? { status: 0, stdout: 'active\n' };
    if (args.includes('restart')) return script.restart ?? { status: 0, stdout: '' };
    return { status: 1, stdout: '' };
  };
}

/**
 * A fetch stub serving the daemon repository's release: a HEAD redirect naming
 * `tag`, a SHA256SUMS.txt, and the asset bytes themselves. `publishedAssets`
 * decides which asset names exist — everything else 404s, which is exactly how
 * a missing terminal binary behaves against the daemon's real releases.
 */
function stubDaemonReleaseFetch(options: {
  readonly tag?: string;
  readonly assets?: Record<string, string>;
  readonly requested?: string[];
}): UpdateFetchLike {
  const tag = options.tag ?? SPLIT_TAG;
  const assets = options.assets ?? { [DAEMON_ASSET]: 'new-daemon-bytes' };
  const manifest = Object.entries(assets)
    .map(([name, body]) => `${Bun.SHA256.hash(body, 'hex')}  ${name}`)
    .join('\n');
  return async (url: string) => {
    options.requested?.push(url);
    if (url === DAEMON_REPO_RELEASES_LATEST_URL) {
      return {
        ok: true,
        status: 302,
        url,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'location'
              ? `https://github.com/mgd34msu/goodvibes-daemon/releases/tag/${tag}`
              : null,
        },
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    const base = `${daemonReleaseDownloadBaseUrl(tag)}/`;
    const name = url.startsWith(base) ? url.slice(base.length) : null;
    const body = name === 'SHA256SUMS.txt' ? manifest : name ? assets[name] : undefined;
    if (body === undefined) {
      return {
        ok: false,
        status: 404,
        url,
        headers: { get: () => null },
        text: async () => 'Not Found',
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return {
      ok: true,
      status: 200,
      url,
      headers: { get: () => null },
      text: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    };
  };
}

/** An in-memory filesystem standing in for the install directory. */
function memoryIo(seed: Record<string, string> = {}): UpdateFileIo & { readonly files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    files,
    writeFile: (path, data) => {
      files.set(path, Buffer.from(data as Uint8Array).toString('utf-8'));
    },
    rename: (from, to) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`rename of missing file ${from}`);
      files.delete(from);
      files.set(to, value);
    },
    chmod: () => {},
    exists: (path) => files.has(path),
    mkdir: () => {},
  };
}

describe('parseDaemonVersionOutput', () => {
  test('reads the shipped daemon banner', () => {
    expect(parseDaemonVersionOutput('goodvibes-daemon 1.27.1\n')).toBe('1.27.1');
  });

  test('tolerates a leading v', () => {
    expect(parseDaemonVersionOutput('goodvibes-daemon v1.28.0')).toBe('1.28.0');
  });

  test('refuses output with no dotted version — an unidentifiable binary is never a number', () => {
    expect(parseDaemonVersionOutput('unknown flag: --version')).toBeNull();
    expect(parseDaemonVersionOutput('')).toBeNull();
    expect(parseDaemonVersionOutput('goodvibes-daemon')).toBeNull();
  });
});

describe('readInstalledDaemonVersion', () => {
  test('returns the parsed version for a binary that answers', () => {
    expect(readInstalledDaemonVersion(DAEMON_PATH, stubRunCommand({}))).toBe(PRE_SPLIT_VERSION);
  });

  test('returns null when the probe exits non-zero', () => {
    const run = stubRunCommand({ version: { status: 1, stdout: 'goodvibes-daemon 1.27.1' } });
    expect(readInstalledDaemonVersion(DAEMON_PATH, run)).toBeNull();
  });

  test('returns null when the probe could not run at all', () => {
    const run: RunCommandLike = () => ({ status: null, stdout: '' });
    expect(readInstalledDaemonVersion(DAEMON_PATH, run)).toBeNull();
  });
});

describe('isPreSplitDaemonVersion', () => {
  test('every shipped pre-split build is below the floor', () => {
    for (const version of ['1.24.1', '1.26.0', '1.27.0', '1.27.1']) {
      expect(isPreSplitDaemonVersion(version)).toBe(true);
    }
  });

  test('the floor itself and anything above it is left alone', () => {
    for (const version of [DAEMON_SPLIT_FLOOR_VERSION, '1.28.1', '1.29.0', '2.0.0']) {
      expect(isPreSplitDaemonVersion(version)).toBe(false);
    }
  });
});

describe('decideDaemonHandover', () => {
  const base = { platform: 'linux' as NodeJS.Platform, arch: 'x64' };

  test('hands over a pre-split binary installed beside this one', () => {
    const decision = decideDaemonHandover({
      ...base,
      binaryPath: DAEMON_PATH,
      installedVersion: PRE_SPLIT_VERSION,
    });
    expect(decision).toEqual({
      action: 'handover',
      binaryPath: DAEMON_PATH,
      fromVersion: PRE_SPLIT_VERSION,
      assetName: DAEMON_ASSET,
    });
  });

  test('skips when no daemon binary was found', () => {
    expect(decideDaemonHandover({ ...base, binaryPath: null, installedVersion: null }))
      .toEqual({ action: 'skip', reason: 'no-daemon-binary' });
  });

  test('never swaps a package-manager-managed daemon in place', () => {
    const decision = decideDaemonHandover({
      ...base,
      binaryPath: '/home/op/.bun/install/global/node_modules/goodvibes-daemon/vendor/goodvibes-daemon-linux-x64',
      installedVersion: PRE_SPLIT_VERSION,
    });
    expect(decision).toEqual({ action: 'skip', reason: 'not-swappable-install' });
  });

  test('never swaps a binary whose version could not be read', () => {
    expect(decideDaemonHandover({ ...base, binaryPath: DAEMON_PATH, installedVersion: null }))
      .toEqual({ action: 'skip', reason: 'version-unreadable' });
  });

  test('leaves a daemon that already comes from its own repository alone', () => {
    expect(decideDaemonHandover({ ...base, binaryPath: DAEMON_PATH, installedVersion: '1.28.0' }))
      .toEqual({ action: 'skip', reason: 'already-split' });
  });

  test('skips a platform the daemon publishes no assets for', () => {
    const decision = decideDaemonHandover({
      binaryPath: 'C:\\goodvibes\\goodvibes-daemon.exe',
      installedVersion: PRE_SPLIT_VERSION,
      platform: 'win32',
      arch: 'x64',
    });
    expect(decision).toEqual({ action: 'skip', reason: 'unsupported-platform' });
  });
});

describe('performDaemonHandover', () => {
  test('verifies and swaps ONLY the daemon binary, keeping the outgoing build', async () => {
    const io = memoryIo({
      [DAEMON_PATH]: 'old-daemon-bytes',
      '/home/op/.local/bin/goodvibes': 'terminal-bytes',
      '/home/op/.local/bin/lib/sqlite-vec-linux-x64/vec0.so': 'addon-bytes',
    });
    const requested: string[] = [];
    const result = await performDaemonHandover({
      fetchImpl: stubDaemonReleaseFetch({ requested }),
      binaryPath: DAEMON_PATH,
      assetName: DAEMON_ASSET,
      io,
    });

    expect(result.tag).toBe(SPLIT_TAG);
    expect(io.files.get(DAEMON_PATH)).toBe('new-daemon-bytes');
    expect(io.files.get(`${DAEMON_PATH}.previous`)).toBe('old-daemon-bytes');
    // The neighbours are this handover's business only insofar as it must not
    // touch them: the terminal binary is this product's own and the addon is
    // shared by all three.
    expect(io.files.get('/home/op/.local/bin/goodvibes')).toBe('terminal-bytes');
    expect(io.files.get('/home/op/.local/bin/lib/sqlite-vec-linux-x64/vec0.so')).toBe('addon-bytes');
    // And it never even ASKS for them, which is what keeps it immune to the
    // 404 that stops the shipped daemon's own updater.
    expect(requested.some((url) => url.includes('goodvibes-linux-x64'))).toBe(false);
    expect(requested.some((url) => url.includes('sqlite-vec'))).toBe(false);
  });

  test('refuses a release below the split floor rather than installing a downgrade', async () => {
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
    await expect(
      performDaemonHandover({
        fetchImpl: stubDaemonReleaseFetch({ tag: 'v1.27.2', assets: { [DAEMON_ASSET]: 'wrong-line' } }),
        binaryPath: DAEMON_PATH,
        assetName: DAEMON_ASSET,
        io,
      }),
    ).rejects.toThrow(/below the 1\.28\.0 split floor/);
    expect(io.files.get(DAEMON_PATH)).toBe('old-daemon-bytes');
  });

  test('a checksum that does not match leaves the installed daemon untouched', async () => {
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
    const fetchImpl: UpdateFetchLike = async (url: string) => {
      const honest = stubDaemonReleaseFetch({});
      const response = await honest(url);
      if (!url.endsWith(DAEMON_ASSET)) return response;
      // Same manifest, different bytes.
      return {
        ...response,
        text: async () => 'tampered',
        arrayBuffer: async () => new TextEncoder().encode('tampered').buffer as ArrayBuffer,
      };
    };
    await expect(
      performDaemonHandover({ fetchImpl, binaryPath: DAEMON_PATH, assetName: DAEMON_ASSET, io }),
    ).rejects.toThrow(/checksum mismatch/);
    expect(io.files.get(DAEMON_PATH)).toBe('old-daemon-bytes');
    expect(io.files.has(`${DAEMON_PATH}.previous`)).toBe(false);
  });

  test('an asset missing from the release is a refusal, not a silent skip', async () => {
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
    await expect(
      performDaemonHandover({
        fetchImpl: stubDaemonReleaseFetch({ assets: { 'something-else': 'x' } }),
        binaryPath: DAEMON_PATH,
        assetName: DAEMON_ASSET,
        io,
      }),
    ).rejects.toThrow(/download failed \(404\)/);
    expect(io.files.get(DAEMON_PATH)).toBe('old-daemon-bytes');
  });

  test('records the resolved tag on the progress record before writing anything', async () => {
    const progress = createDaemonHandoverProgress();
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
    expect(progress.begun).toBe(false);
    await performDaemonHandover({
      fetchImpl: stubDaemonReleaseFetch({}),
      binaryPath: DAEMON_PATH,
      assetName: DAEMON_ASSET,
      io,
      progress,
    });
    expect(progress.tag).toBe(SPLIT_TAG);
    expect(progress.begun).toBe(true);
  });
});

describe('restartHandedOverDaemon', () => {
  const config = { get: (key: string) => (key === 'service.serviceName' ? 'goodvibes' : undefined) };

  test('restarts an active systemd user unit', () => {
    const calls: string[][] = [];
    const outcome = restartHandedOverDaemon('linux', config, stubRunCommand({ calls }));
    expect(outcome.restarted).toBe(true);
    expect(outcome.unitName).toBe('goodvibes');
    expect(calls).toContainEqual(['systemctl', '--user', 'restart', 'goodvibes.service']);
  });

  test('does not restart a unit that is not active, and says so honestly', () => {
    const calls: string[][] = [];
    const outcome = restartHandedOverDaemon(
      'linux',
      config,
      stubRunCommand({ calls, isActive: { status: 3, stdout: 'inactive\n' } }),
    );
    expect(outcome.restarted).toBe(false);
    expect(outcome.detail).toContain('next time the daemon starts');
    expect(calls.some((call) => call.includes('restart'))).toBe(false);
  });

  test('a failed restart names the command to run rather than claiming success', () => {
    const outcome = restartHandedOverDaemon(
      'linux',
      config,
      stubRunCommand({ restart: { status: 1, stdout: '' } }),
    );
    expect(outcome.restarted).toBe(false);
    expect(outcome.detail).toContain('systemctl --user restart goodvibes.service');
  });

  test('never prints a systemctl command on a platform that does not have one', () => {
    const outcome = restartHandedOverDaemon('darwin', config, stubRunCommand({}));
    expect(outcome.restarted).toBe(false);
    expect(outcome.detail).not.toContain('systemctl');
  });
});

describe('runDaemonHandover', () => {
  function baseOptions(
    overrides: Partial<RunDaemonHandoverOptions> = {},
  ): { options: RunDaemonHandoverOptions; printed: string[] } {
    const printed: string[] = [];
    const options: RunDaemonHandoverOptions = {
      fetchImpl: stubDaemonReleaseFetch({}),
      binaryPath: DAEMON_PATH,
      platform: 'linux',
      arch: 'x64',
      configManager: { get: () => undefined },
      print: (line) => printed.push(line),
      runCommand: stubRunCommand({}),
      io: memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' }),
      ...overrides,
    };
    return { options, printed };
  }

  test('the whole path: pre-split daemon detected, swapped, restarted, reported', async () => {
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
    const calls: string[][] = [];
    const { options, printed } = baseOptions({ io, runCommand: stubRunCommand({ calls }) });
    const outcome = await runDaemonHandover(options);

    expect(outcome).toEqual({
      action: 'handed-over',
      fromVersion: PRE_SPLIT_VERSION,
      toTag: SPLIT_TAG,
      restarted: true,
      unitName: 'goodvibes',
    });
    expect(io.files.get(DAEMON_PATH)).toBe('new-daemon-bytes');
    expect(io.files.get(`${DAEMON_PATH}.previous`)).toBe('old-daemon-bytes');
    expect(calls).toContainEqual(['systemctl', '--user', 'restart', 'goodvibes.service']);
    // The receipt names both versions and the rollback, so the swap is not silent.
    const receipt = printed.join('\n');
    expect(receipt).toContain('v1.27.1');
    expect(receipt).toContain('v1.28.0');
    expect(receipt).toContain('rollback');
  });

  test('a daemon already on its own release line is left alone and says nothing', async () => {
    const io = memoryIo({ [DAEMON_PATH]: 'new-daemon-bytes' });
    const { options, printed } = baseOptions({
      io,
      runCommand: stubRunCommand({ version: { status: 0, stdout: 'goodvibes-daemon 1.28.0\n' } }),
    });
    const outcome = await runDaemonHandover(options);
    expect(outcome).toEqual({ action: 'skipped', reason: 'already-split' });
    expect(printed).toEqual([]);
    expect(io.files.get(DAEMON_PATH)).toBe('new-daemon-bytes');
  });

  test('is idempotent: a second launch after a handover does nothing', async () => {
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
    let reported = PRE_SPLIT_VERSION;
    const runCommand: RunCommandLike = (command, args) => {
      if (args[0] === '--version') return { status: 0, stdout: `goodvibes-daemon ${reported}\n` };
      return { status: 0, stdout: 'active\n' };
    };
    const first = await runDaemonHandover(baseOptions({ io, runCommand }).options);
    expect(first.action).toBe('handed-over');
    // The swapped binary now reports the new version, exactly as the real one would.
    reported = '1.28.0';
    const second = await runDaemonHandover(baseOptions({ io, runCommand }).options);
    expect(second).toEqual({ action: 'skipped', reason: 'already-split' });
  });

  test('a failure leaves the installed daemon in place and reports what happened', async () => {
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
    const { options, printed } = baseOptions({
      io,
      fetchImpl: stubDaemonReleaseFetch({ assets: {} }),
    });
    const outcome = await runDaemonHandover(options);
    expect(outcome.action).toBe('failed');
    expect(io.files.get(DAEMON_PATH)).toBe('old-daemon-bytes');
    expect(printed.join('\n')).toContain('daemon handover failed');
  });

  test('never throws, whatever the swap does', async () => {
    const { options } = baseOptions({
      performHandover: async () => {
        throw new Error('disk full');
      },
    });
    const outcome = await runDaemonHandover(options);
    expect(outcome).toEqual({ action: 'failed', detail: 'disk full' });
  });

  test('a budget that runs out before any write defers instead of half-swapping', async () => {
    const { options, printed } = baseOptions({
      timeoutMs: 5,
      performHandover: (perform: PerformDaemonHandoverOptions) =>
        new Promise((_resolve, reject) => {
          perform.signal?.addEventListener('abort', () => reject(new Error('cancelled')));
        }),
    });
    const outcome = await runDaemonHandover(options);
    expect(outcome).toEqual({ action: 'deferred' });
    expect(printed.join('\n')).toContain('deferred');
  });

  test('a budget that runs out AFTER the swap began reports the replacement, not a deferral', async () => {
    const { options, printed } = baseOptions({
      timeoutMs: 5,
      performHandover: (perform: PerformDaemonHandoverOptions) =>
        new Promise(() => {
          if (perform.progress) {
            perform.progress.begun = true;
            perform.progress.tag = SPLIT_TAG;
          }
        }),
    });
    const outcome = await runDaemonHandover(options);
    expect(outcome).toEqual({ action: 'swapped-needs-restart', toTag: SPLIT_TAG });
    expect(printed.join('\n')).toContain('restart it');
  });

  test('no daemon beside this install is a silent, reasoned skip', async () => {
    const { options, printed } = baseOptions({ binaryPath: null });
    expect(await runDaemonHandover(options)).toEqual({ action: 'skipped', reason: 'no-daemon-binary' });
    expect(printed).toEqual([]);
  });
});
