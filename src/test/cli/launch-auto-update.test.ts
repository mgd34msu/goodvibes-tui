import { describe, expect, test } from 'bun:test';
import {
  LAUNCH_UPDATED_FROM_ENV,
  restartOntoUpdatedBinary,
  runLaunchAutoUpdate,
  type RunLaunchAutoUpdateOptions,
} from '@/cli/launch-auto-update.ts';
import type { UpdateFetchLike } from '@/runtime/update-check.ts';

// Decision-logic coverage for the launch-time self-update, with every seam
// stubbed: fetch (never the real network), apply (never a real swap), spawn
// (never a real process), and pinned fixture versions '1.0.0'/'v1.1.0' —
// never the live build VERSION, per this repo's version-decoupled-tests rule.

const RELEASES_LATEST_URL = 'https://github.com/mgd34msu/goodvibes-tui/releases/latest';

/** A fetch stub whose HEAD /releases/latest redirect names `latestTag`. */
function stubFetch(latestTag: string): UpdateFetchLike {
  return async (url: string) => {
    if (url !== RELEASES_LATEST_URL) throw new Error(`unexpected fetch in decision test: ${url}`);
    return {
      ok: true,
      status: 302,
      url,
      headers: { get: (name: string) => (name.toLowerCase() === 'location' ? `https://github.com/mgd34msu/goodvibes-tui/releases/tag/${latestTag}` : null) },
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

const failingFetch: UpdateFetchLike = async () => {
  throw new Error('network unreachable');
};

/** A fetch that never settles — the timeout path, without a real slow network. */
const hangingFetch: UpdateFetchLike = () => new Promise(() => {});

function baseOptions(overrides: Partial<RunLaunchAutoUpdateOptions>): { options: RunLaunchAutoUpdateOptions; printed: string[] } {
  const printed: string[] = [];
  const options: RunLaunchAutoUpdateOptions = {
    fetchImpl: stubFetch('v1.1.0'),
    execPath: '/opt/goodvibes/goodvibes',
    platform: 'linux',
    arch: 'x64',
    currentVersion: '1.0.0',
    settings: {},
    env: {},
    print: (line) => printed.push(line),
    configManager: { get: () => undefined },
    apply: async () => {},
    ...overrides,
  };
  return { options, printed };
}

describe('runLaunchAutoUpdate', () => {
  test('restarted process prints the two-version receipt, consumes the env marker, and does not check again', async () => {
    const env: NodeJS.ProcessEnv = { [LAUNCH_UPDATED_FROM_ENV]: '1.0.0' };
    const { options, printed } = baseOptions({
      env,
      currentVersion: '1.1.0',
      // Any fetch would be a bug on this path.
      fetchImpl: failingFetch,
    });
    const outcome = await runLaunchAutoUpdate(options);
    expect(outcome).toEqual({ action: 'continue', reason: 'just-updated' });
    expect(printed).toEqual(['auto-update: updated from v1.0.0 to v1.1.0 at launch']);
    // Consumed: sessions spawned from inside this one never inherit it.
    expect(env[LAUNCH_UPDATED_FROM_ENV]).toBeUndefined();
  });

  test('autoUpdateAtLaunch=false turns the feature off — silently, with no network traffic', async () => {
    let fetched = false;
    const { options, printed } = baseOptions({
      settings: { autoUpdateAtLaunch: false },
      fetchImpl: (async () => {
        fetched = true;
        throw new Error('must not fetch');
      }) as UpdateFetchLike,
    });
    const outcome = await runLaunchAutoUpdate(options);
    expect(outcome).toEqual({ action: 'continue', reason: 'disabled' });
    expect(printed).toEqual([]);
    expect(fetched).toBe(false);
  });

  test('package-manager and from-source installs never self-update at launch', async () => {
    for (const execPath of ['/home/u/.bun/install/global/node_modules/@pellux/goodvibes-tui/bin/goodvibes', '/usr/local/bin/bun']) {
      const { options, printed } = baseOptions({ execPath, fetchImpl: failingFetch });
      const outcome = await runLaunchAutoUpdate(options);
      expect(outcome).toEqual({ action: 'continue', reason: 'not-swappable-install' });
      expect(printed).toEqual([]);
    }
  });

  test('an unreachable network skips the check with one honest line and starts the current version', async () => {
    const { options, printed } = baseOptions({ fetchImpl: failingFetch });
    const outcome = await runLaunchAutoUpdate(options);
    expect(outcome).toEqual({ action: 'continue', reason: 'check-skipped' });
    expect(printed).toEqual(['update check skipped: offline']);
  });

  test('a check that outlives its budget is skipped the same way (launch is never held hostage)', async () => {
    const { options, printed } = baseOptions({ fetchImpl: hangingFetch, timeoutMs: 10 });
    const outcome = await runLaunchAutoUpdate(options);
    expect(outcome).toEqual({ action: 'continue', reason: 'check-skipped' });
    expect(printed).toEqual(['update check skipped: offline']);
  });

  test('an already-current binary continues silently', async () => {
    let applied = false;
    const { options, printed } = baseOptions({
      fetchImpl: stubFetch('v1.0.0'),
      apply: async () => {
        applied = true;
      },
    });
    const outcome = await runLaunchAutoUpdate(options);
    expect(outcome).toEqual({ action: 'continue', reason: 'already-current' });
    expect(printed).toEqual([]);
    expect(applied).toBe(false);
  });

  test('a newer release is installed through the injected apply seam and asks for a restart', async () => {
    const applyCalls: Array<{ execPath: string; currentVersion: string }> = [];
    const { options, printed } = baseOptions({
      apply: async (applyOptions) => {
        applyCalls.push({ execPath: applyOptions.execPath, currentVersion: applyOptions.currentVersion });
        applyOptions.print('Updated to v1.1.0.');
      },
    });
    const outcome = await runLaunchAutoUpdate(options);
    expect(outcome).toEqual({ action: 'restart', latestTag: 'v1.1.0' });
    expect(applyCalls).toEqual([{ execPath: '/opt/goodvibes/goodvibes', currentVersion: '1.0.0' }]);
    expect(printed).toEqual(['Updated to v1.1.0.', 'auto-update: v1.1.0 installed — restarting onto the new version']);
  });

  test('a failed install states the failure and starts the current version', async () => {
    const { options, printed } = baseOptions({
      apply: async () => {
        throw new Error('checksum mismatch for goodvibes-linux-x64');
      },
    });
    const outcome = await runLaunchAutoUpdate(options);
    expect(outcome).toEqual({ action: 'continue', reason: 'update-failed' });
    expect(printed).toEqual([
      'auto-update failed: checksum mismatch for goodvibes-linux-x64 — starting the current version v1.0.0',
    ]);
  });

  test('never throws: even a fetch that rejects after the race resolves leaves the outcome honest', async () => {
    const { options } = baseOptions({
      fetchImpl: (async () => {
        throw new Error('boom');
      }) as UpdateFetchLike,
    });
    await expect(runLaunchAutoUpdate(options)).resolves.toEqual({ action: 'continue', reason: 'check-skipped' });
  });
});

describe('restartOntoUpdatedBinary', () => {
  test('spawns the swapped binary with the original argv, marks the child env, and returns its exit code', () => {
    const spawned: Array<{ execPath: string; argv: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const code = restartOntoUpdatedBinary({
      execPath: '/opt/goodvibes/goodvibes',
      argv: ['--working-dir', '/tmp/w'],
      env: { PATH: '/usr/bin' },
      fromVersion: '1.0.0',
      spawn: (execPath, argv, env) => {
        spawned.push({ execPath, argv, env });
        return 42;
      },
    });
    expect(code).toBe(42);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.execPath).toBe('/opt/goodvibes/goodvibes');
    expect(spawned[0]!.argv).toEqual(['--working-dir', '/tmp/w']);
    expect(spawned[0]!.env[LAUNCH_UPDATED_FROM_ENV]).toBe('1.0.0');
    expect(spawned[0]!.env['PATH']).toBe('/usr/bin');
  });

  test('a null child status maps to exit code 0', () => {
    const code = restartOntoUpdatedBinary({
      execPath: '/opt/goodvibes/goodvibes',
      argv: [],
      env: {},
      fromVersion: '1.0.0',
      spawn: () => null,
    });
    expect(code).toBe(0);
  });
});
