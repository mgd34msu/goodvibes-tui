/**
 * provision-wake-model.test.ts — the command the curl installer runs.
 *
 * The property under test is not "it downloads a model". It is that an installer
 * calling this CANNOT be made to fail by it: a machine with no network, a home
 * directory that makes no sense, and a download that half-completed all have to
 * come back as exit 0 with one plain line saying what happened. An installer that
 * aborts half-way through is worse than one that finishes without a wake word.
 */
import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
  resolveManagedVoiceRoot,
  wakeProvisionStatus,
} from '@pellux/goodvibes-sdk/platform/voice';
import { runProvisionWakeModelCommand } from '../../daemon/provision-wake-model.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/** A machine with no network at all. */
const offlineFetch = (async () => { throw new Error('ENETUNREACH'); }) as unknown as typeof fetch;

describe('goodvibes-daemon provision-wake-model', () => {
  test('an offline machine exits 0, says so plainly, and names the recovery command', async () => {
    const home = makeProjectTempDir('wake-cmd-offline');
    try {
      const result = await runProvisionWakeModelCommand([], {
        homeDirectory: home,
        env: {},
        // The REAL policy, with only the network replaced — the thing being trusted
        // is the policy's never-throw contract, so it is not stubbed out.
        provisionAtInstall: async (options) => {
          const { provisionWakeWordModelsAtInstall } = await import('@pellux/goodvibes-sdk/platform/voice');
          return provisionWakeWordModelsAtInstall({ ...options, fetchImpl: offlineFetch });
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.lines.length).toBe(1);
      expect(result.lines[0]).toContain('wake-word model:');
      expect(result.lines[0]).toContain('installation continues');
      expect(result.lines[0]).toContain('/voice wake setup');
      // Degraded means exactly the old posture, verified by content.
      expect(wakeProvisionStatus({ managedRoot: resolveManagedVoiceRoot(home) }).ready).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--strict makes the exit code carry the result, for a caller that wants it', async () => {
    const home = makeProjectTempDir('wake-cmd-strict');
    try {
      const result = await runProvisionWakeModelCommand(['--strict'], {
        homeDirectory: home,
        env: {},
        provisionAtInstall: async (options) => {
          const { provisionWakeWordModelsAtInstall } = await import('@pellux/goodvibes-sdk/platform/voice');
          return provisionWakeWordModelsAtInstall({ ...options, fetchImpl: offlineFetch });
        },
      });
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('it targets the SAME managed root the running daemon reads', async () => {
    const home = makeProjectTempDir('wake-cmd-root');
    try {
      let seen = '';
      await runProvisionWakeModelCommand([], {
        homeDirectory: home,
        env: {},
        provisionAtInstall: async (options) => {
          seen = options.managedRoot;
          return {
            state: 'degraded', ready: false, mobileFormatReady: false,
            message: 'no', outcomes: [], modelVersion: null, reapedBeforeAttempt: 0,
          };
        },
      });
      // Not a hand-written join: the one SDK derivation, which is what makes an
      // install-time download and a boot-time status read agree about a directory.
      expect(seen).toBe(resolveManagedVoiceRoot(home));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a home directory it cannot make sense of is a stated skip, not a failed install', async () => {
    const result = await runProvisionWakeModelCommand([], { homeDirectory: 'not/absolute', env: {} });
    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toContain('skipped');
    expect(result.lines[0]).toContain('absolute home directory');
  });

  test('the opt-out is honoured and reported', async () => {
    const home = makeProjectTempDir('wake-cmd-optout');
    try {
      const result = await runProvisionWakeModelCommand([], {
        homeDirectory: home,
        env: { GOODVIBES_SKIP_WAKE_MODEL_DOWNLOAD: '1' },
        provisionAtInstall: async (options) => {
          const { provisionWakeWordModelsAtInstall } = await import('@pellux/goodvibes-sdk/platform/voice');
          return provisionWakeWordModelsAtInstall({
            ...options,
            fetchImpl: (async () => { throw new Error('must not fetch'); }) as unknown as typeof fetch,
          });
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.lines[0]).toContain('GOODVIBES_SKIP_WAKE_MODEL_DOWNLOAD');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
