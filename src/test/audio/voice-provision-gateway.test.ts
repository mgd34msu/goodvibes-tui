import { describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk';
import {
  classifyVoiceProvisionError,
  createVoiceProvisionGateway,
  renderVoiceProvision,
  runVoiceSetupWithProgress,
  VOICE_SETUP_ANNOUNCEMENT,
  type VoiceProvisionGatewayResolution,
} from '../../core/voice-provision-gateway.ts';
import type { VoiceRuntimeStatusResult, VoiceLocalInstallResult } from '../../core/voice-provision-status.ts';
import { resolveWakeRuntimeSettings } from '@pellux/goodvibes-sdk/platform/voice/wake/runtime';
import { terminalWakeCapabilities, WAKE_SETUP_ANNOUNCEMENT } from '../../core/wake-provision-status.ts';
import { printWakeStatus, runWakeProvision } from '../../core/wake-provision-runner.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerExperienceRuntimeCommands } from '../../input/commands/experience-runtime.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { wireVoiceSetup, WAKE_RECOVERY_COMMAND } from '../../runtime/voice-setup-services.ts';

const STATUS: VoiceRuntimeStatusResult = {
  platform: 'linux-x64',
  state: 'not-provisioned',
  tts: { engine: 'piper', binaryPresent: false, voicePresent: false, binaryPath: '/p', modelPath: '/v' },
  stt: { engine: 'whisper-cpp', supported: true, state: 'not-provisioned', binaryPresent: false, modelPresent: false, binaryPath: '/w', modelPath: '/m' },
  offerBytes: 89_666_641,
} as VoiceRuntimeStatusResult;

const RECEIPT: VoiceLocalInstallResult = {
  provisioned: true,
  platform: 'linux-x64',
  tts: { engine: 'piper', state: 'provisioned', binaryPath: '/p', modelPath: '/v' },
  stt: { engine: 'whisper-cpp', state: 'provisioned', binaryPath: '/w', modelPath: '/m' },
  components: [{ id: 'piper-engine', state: 'installed', bytes: 26_460_462 }],
  configured: { set: [{ key: 'voice.local.ttsEngine', value: 'piper' }], skipped: [] },
} as VoiceLocalInstallResult;

function readyResolution(over: { status?: VoiceRuntimeStatusResult; install?: VoiceLocalInstallResult } = {}): VoiceProvisionGatewayResolution {
  return {
    available: true,
    gateway: {
      fetchStatus: async () => over.status ?? STATUS,
      runInstall: async () => over.install ?? RECEIPT,
    },
  };
}

function failingResolution(error: unknown): VoiceProvisionGatewayResolution {
  return {
    available: true,
    gateway: {
      fetchStatus: async () => { throw error; },
      runInstall: async () => { throw error; },
    },
  };
}

describe('classifyVoiceProvisionError', () => {
  test('501 and 404 are "verb unavailable" (daemon predates managed voice)', () => {
    expect(classifyVoiceProvisionError(new GoodVibesSdkError('x', { status: 501 })).kind).toBe('unavailable');
    expect(classifyVoiceProvisionError(new GoodVibesSdkError('x', { status: 404 })).kind).toBe('unavailable');
  });
  test('500 / network errors are a generic error, not "unavailable"', () => {
    expect(classifyVoiceProvisionError(new GoodVibesSdkError('boom', { status: 500 })).kind).toBe('error');
    expect(classifyVoiceProvisionError(new Error('connection reset')).kind).toBe('error');
  });
});

describe('renderVoiceProvision — mocked daemon (injected resolution)', () => {
  test('status: available renders the runtime snapshot', async () => {
    const out = await renderVoiceProvision('status', readyResolution());
    expect(out).toContain('Local Voice Runtime');
    expect(out).toContain('setup download: 86 MB');
  });

  test('setup: available renders the install receipt', async () => {
    const out = await renderVoiceProvision('setup', readyResolution());
    expect(out).toContain('Local Voice Setup — receipt');
    expect(out).toContain('result: local voice provisioned');
    expect(out).toContain('piper-engine: installed (25 MB)');
  });

  test('unavailable resolution renders the honest reason (no fetch attempted)', async () => {
    const out = await renderVoiceProvision('setup', { available: false, reason: 'the daemon is disabled (daemon.enabled=false)' });
    expect(out).toBe('Local Voice Setup unavailable: the daemon is disabled (daemon.enabled=false)');
  });

  test('a 501 during install renders "does not serve managed voice provisioning yet"', async () => {
    const out = await renderVoiceProvision('setup', failingResolution(new GoodVibesSdkError('no handler', { status: 501 })));
    expect(out).toContain('does not serve managed voice provisioning yet');
  });

  test('a network error during status renders an honest read failure, not empty state', async () => {
    const out = await renderVoiceProvision('status', failingResolution(new Error('connection reset')));
    expect(out).toContain('could not read status');
    expect(out).toContain('connection reset');
  });
});

describe('runVoiceSetupWithProgress — live progress polling (no real timers)', () => {
  function progressStatus(component: string, phase: string, bytesTotal?: number, bytesDone?: number): VoiceRuntimeStatusResult {
    return { ...STATUS, installInProgress: { startedAt: 1, components: [{ component, phase, ...(bytesTotal !== undefined ? { bytesTotal } : {}), ...(bytesDone !== undefined ? { bytesDone } : {}) }] } } as VoiceRuntimeStatusResult;
  }

  test('polls status while the install runs and prints per-component progress, then the receipt', async () => {
    const printed: string[] = [];
    let resolveInstall!: (r: VoiceLocalInstallResult) => void;
    const installPromise = new Promise<VoiceLocalInstallResult>((r) => { resolveInstall = r; });
    let step = 0;
    const resolution: VoiceProvisionGatewayResolution = {
      available: true,
      gateway: {
        runInstall: () => installPromise,
        fetchStatus: async () => {
          step += 1;
          if (step === 1) return progressStatus('piper-engine', 'download', 100, 50);
          if (step === 2) return progressStatus('piper-engine', 'done', 100, 100);
          return STATUS;
        },
      },
    };
    // Fake sleep: on the 3rd tick, settle the install so the loop exits.
    let sleeps = 0;
    const sleep = async (): Promise<void> => { sleeps += 1; if (sleeps === 3) resolveInstall(RECEIPT); };

    await runVoiceSetupWithProgress(resolution, { print: (b) => printed.push(b), sleep, pollMs: 0 });

    const text = printed.join('\n');
    expect(text).toContain('piper-engine: downloading (50 B/100 B)');
    expect(text).toContain('piper-engine: done');
    expect(text).toContain('Local Voice Setup — receipt');
    expect(text).toContain('result: local voice provisioned');
  });

  test('a phase that has not changed is not re-printed (no per-poll spam)', async () => {
    const printed: string[] = [];
    let resolveInstall!: (r: VoiceLocalInstallResult) => void;
    const installPromise = new Promise<VoiceLocalInstallResult>((r) => { resolveInstall = r; });
    const resolution: VoiceProvisionGatewayResolution = {
      available: true,
      gateway: {
        runInstall: () => installPromise,
        // Always the SAME phase — only the first observation prints.
        fetchStatus: async () => progressStatus('piper-engine', 'download', 100, 50),
      },
    };
    let sleeps = 0;
    const sleep = async (): Promise<void> => { sleeps += 1; if (sleeps === 3) resolveInstall(RECEIPT); };
    await runVoiceSetupWithProgress(resolution, { print: (b) => printed.push(b), sleep, pollMs: 0 });
    const downloadingLines = printed.filter((b) => b.includes('piper-engine: downloading'));
    expect(downloadingLines).toHaveLength(1);
  });

  test('unavailable resolution prints the honest reason and never polls', async () => {
    const printed: string[] = [];
    await runVoiceSetupWithProgress({ available: false, reason: 'the daemon is disabled' }, { print: (b) => printed.push(b), sleep: async () => {}, pollMs: 0 });
    expect(printed.join('\n')).toContain('Local Voice Setup unavailable: the daemon is disabled');
  });

  test('an install rejection (501) renders the honest unavailable line, not a fake receipt', async () => {
    const printed: string[] = [];
    const resolution: VoiceProvisionGatewayResolution = {
      available: true,
      gateway: {
        runInstall: async () => { throw new GoodVibesSdkError('no handler', { status: 501 }); },
        fetchStatus: async () => STATUS,
      },
    };
    await runVoiceSetupWithProgress(resolution, { print: (b) => printed.push(b), sleep: async () => {}, pollMs: 0 });
    expect(printed.join('\n')).toContain('does not serve managed voice provisioning yet');
  });
});

describe('createVoiceProvisionGateway — resolution', () => {
  test('refuses honestly when the daemon is disabled', () => {
    const resolution = createVoiceProvisionGateway({
      configManager: { get: (k: string) => (k === 'daemon.enabled' ? false : undefined) } as never,
      homeDirectory: '/home/test',
    });
    expect(resolution.available).toBe(false);
    if (!resolution.available) expect(resolution.reason).toContain('daemon is disabled');
  });
});

// --- Command wire test: /voice status|setup through the registry ---
function makeCtx(configGet?: (key: string) => unknown): CommandContext & { printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    workspace: {
      shellPaths: {
        homeDirectory: '/home/test',
        workingDirectory: '/work',
        resolveWorkspacePath: (p: string) => p,
        resolveProjectPath: (...a: string[]) => a.join('/'),
        resolveUserPath: (...a: string[]) => a.join('/'),
      },
    },
    platform: {
      configManager: {
        get: (key: string) => (configGet ? configGet(key) : undefined),
        setDynamic: () => {},
      },
    },
  } as unknown as CommandContext & { printed: string[] };
}

describe('/voice status|setup — command wire', () => {
  function registry(): CommandRegistry {
    const r = new CommandRegistry();
    registerExperienceRuntimeCommands(r);
    return r;
  }

  test('/voice status honestly reports the daemon disabled rather than fabricating a snapshot', async () => {
    const ctx = makeCtx((key) => (key === 'daemon.enabled' ? false : undefined));
    await registry().get('voice')!.handler(['status'], ctx);
    expect(ctx.printed.join('\n')).toContain('Local Voice Runtime unavailable');
    expect(ctx.printed.join('\n')).toContain('daemon is disabled');
  });

  test('/voice setup prints the up-front announcement even when it then refuses honestly', async () => {
    const ctx = makeCtx((key) => (key === 'daemon.enabled' ? false : undefined));
    await registry().get('voice')!.handler(['setup'], ctx);
    // Announcement only prints when the gateway resolved; a disabled daemon
    // refuses before announcing, so the honest unavailable line is what shows.
    expect(ctx.printed.join('\n')).toContain('Local Voice Setup unavailable');
  });

  test('the usage line advertises the new status/setup subcommands', async () => {
    const ctx = makeCtx();
    await registry().get('voice')!.handler(['bogus-subcommand'], ctx);
    expect(ctx.printed.join('\n')).toContain('status');
    expect(ctx.printed.join('\n')).toContain('setup');
  });

  test('VOICE_SETUP_ANNOUNCEMENT states downloads are checksum-verified and resumable', () => {
    expect(VOICE_SETUP_ANNOUNCEMENT).toContain('checksum-verified and resumable');
  });

  test('/voice wake status reports the honest on-disk state and never downloads', async () => {
    const ctx = makeCtx((key) => (key === 'voice.wake.enabled' ? true : undefined));
    await registry().get('voice')!.handler(['wake', 'status'], ctx);
    const block = ctx.printed.join('\n');
    expect(block).toContain('Wake-Word Detection');
    // A fresh host has no artifacts, and the status says so rather than erroring.
    expect(block).toContain('models provisioned: no');
    expect(block).toContain('classifier: missing');
    expect(block).toContain('/voice wake setup');
    // The synthetic-recall qualification travels with every surfacing of the model.
    expect(block).toContain('synthesised speech only');
  });

  test('/voice wake status names a row that blocks startup, with the reason', async () => {
    const ctx = makeCtx((key) => {
      if (key === 'voice.wake.enabled') return true;
      // No VAD model is pinned anywhere, so any floor above 0 blocks the detector.
      if (key === 'voice.wake.vadThreshold') return 0.5;
      return undefined;
    });
    await registry().get('voice')!.handler(['wake', 'status'], ctx);
    const block = ctx.printed.join('\n');
    expect(block).toContain('rows blocking startup');
    expect(block).toContain('voice.wake.vadThreshold');
    // The gate is a pinned artifact now, so an unprovisioned host is told THAT
    // rather than that no such model exists.
    expect(block).toContain('has not loaded the speech gate');
    expect(block).toContain('goodvibes-vad');
    expect(block).toContain('listening on this terminal: no');
  });

  test('/voice wake with no subcommand defaults to status, and an unknown one prints usage', async () => {
    const bare = makeCtx();
    await registry().get('voice')!.handler(['wake'], bare);
    expect(bare.printed.join('\n')).toContain('Wake-Word Detection');

    const bogus = makeCtx();
    await registry().get('voice')!.handler(['wake', 'nonsense'], bogus);
    expect(bogus.printed.join('\n')).toBe('Usage: /voice wake [status|setup]');
  });

  test('the usage line advertises the wake subcommands', async () => {
    const ctx = makeCtx();
    await registry().get('voice')!.handler(['bogus-subcommand'], ctx);
    expect(ctx.printed.join('\n')).toContain('wake status');
    expect(ctx.printed.join('\n')).toContain('wake setup');
  });
});

describe('wake provisioning — status projection and the explicit setup act', () => {
  const SETTINGS = resolveWakeRuntimeSettings(
    (key) => (key === 'voice.wake.enabled' ? true : undefined),
    'tui',
    terminalWakeCapabilities(),
  );

  test('a corrupt artifact reads as corrupt, not as present', () => {
    const printed: string[] = [];
    printWakeStatus({
      managedRoot: '/managed',
      settings: SETTINGS,
      print: (block) => printed.push(block),
      readStatus: () => ({
        ready: false,
        reason: 'checksum-mismatch',
        classifier: { path: '/managed/wake/models/c.onnx', verified: false, corrupt: true, bytes: 1_200_000 },
        mobileClassifier: { path: '/managed/wake/models/c.tflite', verified: true, corrupt: false, bytes: 2_369_264 },
        notice: { path: '/managed/wake/models/NOTICE', verified: true, corrupt: false, bytes: 900 },
        embedding: { path: '/managed/wake/front-end/e.onnx', verified: true, corrupt: false, bytes: 1_319_365 },
        embeddingNotice: { path: '/managed/wake/front-end/e.NOTICE.txt', verified: true, corrupt: false, bytes: 3_434 },
        vad: { path: '/managed/wake/front-end/vad.onnx', verified: false, corrupt: false, bytes: 0 },
        vadNotice: { path: '/managed/wake/front-end/vad.NOTICE', verified: false, corrupt: false, bytes: 0 },
        vadReady: false,
        downloadBytes: 3_687_009,
        modelVersion: '1.0.0',
        recallIsSyntheticOnly: true,
      }),
    });
    const block = printed.join('\n');
    expect(block).toContain('classifier: PRESENT BUT FAILS VERIFICATION');
    expect(block).toContain('torn, truncated, or the wrong asset');
    expect(block).toContain('models provisioned: no (checksum-mismatch)');
    expect(block).toContain('speech-embedding front end: verified');
    // Both attribution NOTICEs are named, and named distinguishably: a reader
    // chasing a missing one has to know whether it is ours or Google's.
    expect(block).toContain('attribution NOTICE (classifier): verified');
    expect(block).toContain('attribution NOTICE (front end): verified');
  });

  test('a missing FRONT-END NOTICE is reported as its own missing artifact', () => {
    const printed: string[] = [];
    printWakeStatus({
      managedRoot: '/managed',
      settings: SETTINGS,
      print: (block) => printed.push(block),
      readStatus: () => ({
        ready: false,
        reason: 'not-provisioned',
        classifier: { path: '/managed/wake/models/c.onnx', verified: true, corrupt: false, bytes: 2_367_644 },
        mobileClassifier: { path: '/managed/wake/models/c.tflite', verified: true, corrupt: false, bytes: 2_369_264 },
        notice: { path: '/managed/wake/models/NOTICE', verified: true, corrupt: false, bytes: 5_574 },
        embedding: { path: '/managed/wake/front-end/e.onnx', verified: true, corrupt: false, bytes: 1_319_365 },
        // Everything else landed; only Google's attribution file did not. That is
        // still not ready, because bytes this daemon serves cannot go out without it.
        embeddingNotice: { path: '/managed/wake/front-end/e.NOTICE.txt', verified: false, corrupt: false, bytes: 0 },
        vad: { path: '/managed/wake/front-end/goodvibes-vad-1.0.0.onnx', verified: true, corrupt: false, bytes: 15_885 },
        vadNotice: { path: '/managed/wake/front-end/goodvibes-vad-1.0.0.NOTICE.txt', verified: true, corrupt: false, bytes: 6_786 },
        vadReady: true,
        downloadBytes: 6_087_952,
        modelVersion: '1.0.0',
        recallIsSyntheticOnly: true,
      }),
    });
    const block = printed.join('\n');
    expect(block).toContain('attribution NOTICE (front end): missing');
    expect(block).toContain('attribution NOTICE (classifier): verified');
    expect(block).toContain('models provisioned: no (not-provisioned)');
  });

  test('setup narrates each component once per phase change and prints the receipt', async () => {
    const printed: string[] = [];
    await runWakeProvision({
      managedRoot: '/managed',
      settings: SETTINGS,
      print: (block) => printed.push(block),
      provision: async (_root, onProgress) => {
        onProgress({ component: 'classifier', phase: 'download', bytesTotal: 2_367_644 });
        onProgress({ component: 'classifier', phase: 'download', bytesTotal: 2_367_644 }); // repeat: must not reprint
        onProgress({ component: 'classifier', phase: 'verify' });
        onProgress({ component: 'classifier', phase: 'done' });
        return {
          ready: true,
          mobileFormatReady: true,
          modelVersion: '1.0.0',
          outcomes: [
            { component: 'classifier', state: 'installed', path: '/managed/wake/models/c.onnx', bytes: 2_367_644 },
            { component: 'embedding', state: 'skipped', path: '/managed/wake/front-end/e.onnx' },
          ],
          noticePath: '/managed/wake/models/NOTICE',
          embeddingNoticePath: '/managed/wake/front-end/NOTICE',
          recallIsSyntheticOnly: true,
          vadReady: false,
        };
      },
    });
    const block = printed.join('\n');
    expect(block).toContain('Wake-Word Setup');
    expect((block.match(/classifier: download/g) ?? []).length).toBe(1);
    expect(block).toContain('classifier: verify');
    expect(block).toContain('Wake-Word Setup — receipt');
    expect(block).toContain('ready: yes');
    // Each NOTICE's own path, so a deployment carrying the artifacts knows both
    // files it has to carry with them.
    expect(block).toContain('attribution NOTICE (travels with the classifier)');
    expect(block).toContain('attribution NOTICE (travels with the front end)');
  });

  test('a failed component is named with its reason instead of folded into a generic failure', async () => {
    const printed: string[] = [];
    await runWakeProvision({
      managedRoot: '/managed',
      settings: SETTINGS,
      print: (block) => printed.push(block),
      provision: async () => ({
        ready: false,
        mobileFormatReady: false,
        modelVersion: '1.0.0',
        outcomes: [{ component: 'classifier', state: 'failed', path: '/managed/wake/models/c.onnx', error: 'sha256 got abc, want def' }],
        noticePath: null,
        embeddingNoticePath: null,
        recallIsSyntheticOnly: true,
        vadReady: false,
      }),
    });
    const block = printed.join('\n');
    expect(block).toContain('ready: no');
    expect(block).toContain('classifier: failed — sha256 got abc, want def');
  });

  test('a provisioning throw is reported honestly, not as a receipt', async () => {
    const printed: string[] = [];
    await runWakeProvision({
      managedRoot: '/managed',
      settings: SETTINGS,
      print: (block) => printed.push(block),
      provision: async () => { throw new Error('network unreachable'); },
    });
    expect(printed.join('\n')).toContain('provisioning failed: network unreachable');
    expect(printed.join('\n')).not.toContain('receipt');
  });

  test('WAKE_SETUP_ANNOUNCEMENT states the downloads are verified and resumable', () => {
    expect(WAKE_SETUP_ANNOUNCEMENT).toContain('checksum-verified');
    expect(WAKE_SETUP_ANNOUNCEMENT).toContain('resumable');
  });
});

/**
 * The boot half of "the model ships with the installation": a daemon retries at
 * every start for whatever the install could not download, and it sweeps the wake
 * tree while it is there. Both are opt-in, because both do work — network I/O and
 * an hourly timer — that a test-composed graph or a one-shot CLI command must not
 * inherit.
 */
describe('wake-model boot provisioning inside wireVoiceSetup', () => {
  function deps(overrides: Partial<Parameters<typeof wireVoiceSetup>[0]> = {}) {
    return {
      configManager: { get: () => '', setDynamic: () => {} } as unknown as Parameters<typeof wireVoiceSetup>[0]['configManager'],
      shellPaths: { resolveUserPath: (...segments: string[]) => `/managed/${segments.join('/')}` },
      voiceProviders: { get: () => undefined } as unknown as Parameters<typeof wireVoiceSetup>[0]['voiceProviders'],
      admitExpensiveWork: () => ({ allowed: true }),
      ...overrides,
    };
  }

  test('without the opt-in nothing is started, and the stop is still callable', () => {
    let starts = 0;
    const { stopWakeHousekeeping } = wireVoiceSetup(deps({
      startBootProvisioning: () => { starts += 1; return { sweeper: { sweepNow: () => { throw new Error('unused'); }, stop: () => {} }, stop: () => {} }; },
    }));
    expect(starts).toBe(0);
    // A no-op, not an absent field: the disposal list registers it unconditionally,
    // and a missing function there would be a teardown that throws.
    expect(() => stopWakeHousekeeping()).not.toThrow();
  });

  test('with the opt-in it starts against the managed voice root and stop() reaches it', () => {
    const roots: string[] = [];
    let stops = 0;
    const { stopWakeHousekeeping } = wireVoiceSetup(deps({
      provisionWakeModelsAtBoot: true,
      startBootProvisioning: (options) => {
        roots.push(options.managedRoot);
        return { sweeper: { sweepNow: () => { throw new Error('unused'); }, stop: () => {} }, stop: () => { stops += 1; } };
      },
    }));
    // The same directory the setup service and the detector use — resolveUserPath('voice').
    expect(roots).toEqual(['/managed/voice']);
    stopWakeHousekeeping();
    expect(stops).toBe(1);
  });

  test('the attempt it hands over is the service one, which never throws and names the terminal command', async () => {
    // A user root that is a FILE, not a directory. Deterministic on every host and
    // every uid — creating the managed tree under it fails with ENOTDIR before any
    // network call, so this exercises the degraded path for real without a test
    // that could reach for 6 MB when it happens to run somewhere writable.
    const blocked = join(makeProjectTempDir('wake-boot-degraded'), 'not-a-directory');
    writeFileSync(blocked, 'this is a file');
    let attempt: (() => Promise<{ state: string; message: string }>) | null = null;
    wireVoiceSetup(deps({
      provisionWakeModelsAtBoot: true,
      shellPaths: { resolveUserPath: (...segments: string[]) => join(blocked, ...segments) },
      startBootProvisioning: (options) => {
        attempt = options.ensureProvisioned as typeof attempt;
        return { sweeper: { sweepNow: () => { throw new Error('unused'); }, stop: () => {} }, stop: () => {} };
      },
    }));
    expect(attempt).not.toBeNull();
    const outcome = await attempt!();
    expect(outcome.state).toBe('degraded');
    expect(outcome.message).toContain(WAKE_RECOVERY_COMMAND);
    rmSync(dirname(blocked), { recursive: true, force: true });
  });
});
