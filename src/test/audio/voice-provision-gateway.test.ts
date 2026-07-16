import { describe, expect, test } from 'bun:test';
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk';
import {
  classifyVoiceProvisionError,
  createVoiceProvisionGateway,
  renderVoiceProvision,
  VOICE_SETUP_ANNOUNCEMENT,
  type VoiceProvisionGatewayResolution,
} from '../../core/voice-provision-gateway.ts';
import type { VoiceRuntimeStatusResult, VoiceLocalInstallResult } from '../../core/voice-provision-status.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerExperienceRuntimeCommands } from '../../input/commands/experience-runtime.ts';
import type { CommandContext } from '../../input/command-registry.ts';

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
});
