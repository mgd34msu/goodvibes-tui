import { describe, expect, test } from 'bun:test';
import {
  LAUNCH_UPDATED_FROM_ENV,
  restartOntoUpdatedBinary,
  runLaunchAutoUpdate,
  type RunLaunchAutoUpdateOptions,
} from '@/cli/launch-auto-update.ts';
import type { ApplyUpdateOptions } from '@/input/commands/update-runtime.ts';
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

/** A couple of milliseconds of real time, only ever used to prove that work STOPPED. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

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
    expect(printed).toEqual(["couldn't reach the update server — check skipped"]);
  });

  test('a check that outlives its budget is skipped the same way (launch is never held hostage)', async () => {
    const { options, printed } = baseOptions({ fetchImpl: hangingFetch, timeoutMs: 10 });
    const outcome = await runLaunchAutoUpdate(options);
    expect(outcome).toEqual({ action: 'continue', reason: 'check-skipped' });
    expect(printed).toEqual(["couldn't reach the update server — check skipped"]);
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
    expect(printed).toEqual(['downloading v1.1.0…', 'Updated to v1.1.0.', 'auto-update: v1.1.0 installed — restarting onto the new version']);
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
      'downloading v1.1.0…',
      'auto-update failed: checksum mismatch for goodvibes-linux-x64 — starting the current version v1.0.0',
    ]);
  });

  test('an apply that outlives its own (generous) budget is deferred, not left hanging launch forever', async () => {
    const { options, printed } = baseOptions({
      apply: () => new Promise(() => { /* never resolves — simulates a stalled download */ }),
      applyTimeoutMs: 10,
    });
    const outcome = await runLaunchAutoUpdate(options);
    expect(outcome).toEqual({ action: 'continue', reason: 'update-deferred' });
    expect(printed).toEqual(['downloading v1.1.0…', 'update deferred — will retry next launch']);
  });

  test('update.applyTimeoutMs from settings is honored when no explicit override is passed', async () => {
    const { options, printed } = baseOptions({
      settings: { applyTimeoutMs: 10 },
      apply: () => new Promise(() => { /* never resolves */ }),
    });
    const outcome = await runLaunchAutoUpdate(options);
    expect(outcome).toEqual({ action: 'continue', reason: 'update-deferred' });
    expect(printed).toEqual(['downloading v1.1.0…', 'update deferred — will retry next launch']);
  });

  // ── the receipt has to match what actually happened ───────────────────────
  // Losing the race only stops the launcher WAITING for the install. On its
  // own that would leave the download and the swap running, so "deferred"
  // could be printed while the binary was being replaced underneath the
  // session. The install now takes a real AbortSignal and reports its swap
  // state back, and these cases pin both halves of that.

  interface StalledDownloadRecord {
    sawSignal: boolean;
    abortListenerFired: boolean;
    steps: number;
    stepsAtAbort: number | null;
    stopped: boolean;
  }

  function newStalledDownloadRecord(): StalledDownloadRecord {
    return { sawSignal: false, abortListenerFired: false, steps: 0, stepsAtAbort: null, stopped: false };
  }

  /**
   * An install stuck in its download phase, honouring the signal the way
   * applyUpdate does: it steps through the download on a 1ms timer, stops the
   * moment the signal fires, and never reaches a swap.
   */
  function stalledDownloadApply(record: StalledDownloadRecord): (options: ApplyUpdateOptions) => Promise<void> {
    return (applyOptions) =>
      new Promise<void>((_resolve, reject) => {
        record.sawSignal = applyOptions.signal !== undefined;
        applyOptions.signal?.addEventListener('abort', () => {
          record.abortListenerFired = true;
          record.stepsAtAbort = record.steps;
          record.stopped = true;
          reject(new Error('update cancelled before any file was replaced'));
        });
        const step = (): void => {
          if (record.stopped) return;
          record.steps += 1;
          const timer = setTimeout(step, 1);
          timer.unref?.();
        };
        step();
      });
  }

  test('a stalled install is genuinely cancelled: the signal reaches it, its download stops, and the deferral is true', async () => {
    const record = newStalledDownloadRecord();
    const { options, printed } = baseOptions({ apply: stalledDownloadApply(record), applyTimeoutMs: 10 });

    const outcome = await runLaunchAutoUpdate(options);

    expect(outcome).toEqual({ action: 'continue', reason: 'update-deferred' });
    // The signal was delivered and actually fired, not merely accepted.
    expect(record.sawSignal).toBe(true);
    expect(record.abortListenerFired).toBe(true);
    expect(record.steps).toBeGreaterThan(0);
    // And the download stopped there instead of running on unwatched.
    const stepsAtAbort = record.stepsAtAbort;
    expect(stepsAtAbort).not.toBeNull();
    await delay(5);
    expect(record.steps).toBe(stepsAtAbort!);
    expect(printed).toEqual(['downloading v1.1.0…', 'update deferred — will retry next launch']);
  });

  test('a budget that runs out BEFORE the swap begins prints only the deferral, never the background line', async () => {
    let signalSeen: AbortSignal | undefined;
    const { options, printed } = baseOptions({
      applyTimeoutMs: 10,
      apply: (applyOptions) => {
        signalSeen = applyOptions.signal;
        // Still downloading: nothing written, so there is nothing to keep.
        return new Promise<void>(() => {});
      },
    });

    const outcome = await runLaunchAutoUpdate(options);

    expect(outcome).toEqual({ action: 'continue', reason: 'update-deferred' });
    expect(signalSeen?.aborted).toBe(true);
    expect(printed).toContain('update deferred — will retry next launch');
    expect(printed.some((line) => line.includes('updated in background'))).toBe(false);
  });

  test('a budget that runs out AFTER the swap began names the installed version and never cancels the swap', async () => {
    let signalSeen: AbortSignal | undefined;
    const { options, printed } = baseOptions({
      applyTimeoutMs: 10,
      apply: (applyOptions) => {
        signalSeen = applyOptions.signal;
        // The swap has started; from here it always runs to completion, so a
        // deferral would be a false receipt in the other direction.
        applyOptions.progress!.targetTag = 'v1.1.0';
        applyOptions.progress!.begun = true;
        return new Promise<void>(() => {});
      },
    });

    const outcome = await runLaunchAutoUpdate(options);

    expect(outcome).toEqual({ action: 'continue', reason: 'update-in-background' });
    expect(printed).toEqual(['downloading v1.1.0…', 'updated in background; restart to use v1.1.0']);
    expect(printed).not.toContain('update deferred — will retry next launch');
    // Cancellation is never signalled once the files are being replaced.
    expect(signalSeen?.aborted).toBe(false);
  });

  test('the background receipt names the version the install actually resolved, not just the checked tag', async () => {
    const { options, printed } = baseOptions({
      applyTimeoutMs: 10,
      apply: (applyOptions) => {
        // A release published between the check and the install: the receipt
        // must name what is being written, not what was checked.
        applyOptions.progress!.targetTag = 'v1.2.0';
        applyOptions.progress!.begun = true;
        return new Promise<void>(() => {});
      },
    });

    const outcome = await runLaunchAutoUpdate(options);

    expect(outcome).toEqual({ action: 'continue', reason: 'update-in-background' });
    expect(printed).toEqual(['downloading v1.1.0…', 'updated in background; restart to use v1.2.0']);
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
