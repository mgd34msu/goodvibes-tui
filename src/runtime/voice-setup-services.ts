// ---------------------------------------------------------------------------
// voice-setup-services.ts — managed local-voice provisioning composition (TUI wiring)
//
// Backs the daemon's voice.local.status / voice.local.install verbs. Extracted
// into its own module rather than built inline in services.ts, which sits at
// the architecture check's 800-line cap (scripts/check-architecture.ts) — new
// service construction gets its own module and a single wiring call there.
//
// Mirrors the SDK's own createRuntimeServices voiceSetup: a single-flight
// one-act install that provisions the piper engine + a default voice (and
// whisper STT where a bundle is published) and pre-configures the voice.local.*
// keys with ownership awareness (values THIS installer previously wrote update
// to the new managed paths; genuinely user-set values still win; a user-cleared
// installer value stays cleared). status() is a no-network read.
// ---------------------------------------------------------------------------

import {
  createVoiceInstallProgressTracker,
  localVoiceRuntimeStatus,
  preconfigureLocalVoiceKeys,
  provisionLocalVoiceRuntime,
  readVoiceInstallStamp,
  writeVoiceInstallStamp,
  type VoiceProviderRegistry,
} from '@pellux/goodvibes-sdk/platform/voice';
import { singleFlight } from '@pellux/goodvibes-sdk/platform/utils';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ShellPathService } from '@/runtime/index.ts';
import type { VoiceLocalInstallResult } from '../core/voice-provision-status.ts';

export interface VoiceSetupServicesDeps {
  readonly configManager: ConfigManager;
  readonly shellPaths: Pick<ShellPathService, 'resolveUserPath'>;
  readonly voiceProviders: VoiceProviderRegistry;
  /** Critical-tier admission gate — a provision run allocates archive + model buffers. */
  readonly admitExpensiveWork: (label: string) => { allowed: boolean; reason?: string | undefined };
}

/** The narrow provisioning slice the voice.local.* gateway verbs consume. */
export interface VoiceSetupService {
  status(): unknown;
  install(): Promise<VoiceLocalInstallResult>;
}

/** Compose the managed-voice single-flight install + no-network status read. */
export function wireVoiceSetup(deps: VoiceSetupServicesDeps): { voiceSetup: VoiceSetupService } {
  const { configManager, voiceProviders } = deps;
  const managedVoiceRoot = deps.shellPaths.resolveUserPath('voice');
  // Live install progress: the install verb is plain request/response, so during
  // a multi-hundred-MB provision a surface would otherwise only see busy→receipt.
  // The tracker folds the provisioner's onProgress stream into a poll-able
  // snapshot that status() carries as `installInProgress` WHILE (and only while)
  // an install runs — surfaces poll status during install (mirrors the SDK).
  const progress = createVoiceInstallProgressTracker();
  // Single-flight: concurrent installs join the in-progress promise instead of
  // starting parallel multi-hundred-MB downloads.
  const runVoiceInstall = singleFlight(async () => {
    progress.begin();
    try {
    const provision = await provisionLocalVoiceRuntime({ managedRoot: managedVoiceRoot, onProgress: (p) => progress.onProgress(p) });
    let configured: { set: { key: string; value: string }[]; skipped: { key: string; reason: string }[] } = { set: [], skipped: [] };
    if (provision.tts.state === 'provisioned' && provision.tts.binaryPath && provision.tts.modelPath) {
      const stamp = readVoiceInstallStamp(managedVoiceRoot);
      const receipt = preconfigureLocalVoiceKeys({
        getConfig: (k) => String(configManager.get(k as Parameters<typeof configManager.get>[0]) ?? ''),
        setConfig: (k, v) => configManager.setDynamic(k as Parameters<typeof configManager.setDynamic>[0], v),
        ttsEngine: provision.tts.engine,
        ttsBinary: provision.tts.binaryPath,
        ttsModelPath: provision.tts.modelPath,
        ...(provision.stt.state === 'provisioned' && provision.stt.binaryPath && provision.stt.modelPath
          ? { sttEngine: provision.stt.engine, sttBinary: provision.stt.binaryPath, sttModelPath: provision.stt.modelPath }
          : {}),
        priorInstallWrites: stamp?.configWrites,
      });
      configured = { set: [...receipt.set], skipped: [...receipt.skipped] };
      if (stamp) {
        writeVoiceInstallStamp(managedVoiceRoot, { ...stamp, configWrites: { ...stamp.configWrites, ...receipt.installWrites } });
      }
      // A successful (re-)install clears any tripped local-engine breaker.
      voiceProviders.get('local')?.resetEngineFailureState?.();
    }
    return { provisioned: provision.tts.state === 'provisioned', platform: provision.platform, tts: provision.tts, stt: provision.stt, components: provision.components, configured };
    } finally {
      progress.end();
    }
  });
  const voiceSetup: VoiceSetupService = {
    status: () => {
      const base = localVoiceRuntimeStatus({ managedRoot: managedVoiceRoot });
      const snapshot = progress.snapshot();
      // Carry live per-component progress ONLY while an install is active.
      return snapshot ? { ...base, installInProgress: snapshot } : base;
    },
    install: async () => {
      // Critical-tier admission: refuse honestly instead of piling onto pressure.
      const admission = deps.admitExpensiveWork('voice runtime install');
      if (!admission.allowed) {
        throw new Error(admission.reason ?? 'voice runtime install refused: daemon is under critical memory pressure.');
      }
      return runVoiceInstall();
    },
  };
  return { voiceSetup };
}
