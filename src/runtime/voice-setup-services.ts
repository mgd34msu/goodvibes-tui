// ---------------------------------------------------------------------------
// voice-setup-services.ts — managed local-voice provisioning composition (TUI wiring)
//
// Backs the daemon's voice.local.status / voice.local.install verbs. The
// provisioning policy — a single-flight one-act install that provisions the
// piper engine + a default voice (and whisper STT where a bundle is published),
// live install-progress folded onto status(), ownership-aware preconfigure of
// the voice.local.* keys (values THIS installer previously wrote update to the
// new managed paths; genuinely user-set values still win; a user-cleared
// installer value stays cleared), a no-network status() read, and critical-tier
// admission gating — lives in the SDK's createVoiceSetupService. Earlier the
// composer was not exported, so the TUI rebuilt it from the voice primitives;
// SDK 1.10.1 exports it through ./platform/runtime/voice-setup, so this module
// is now a thin adapter that maps the TUI's injected seams (configManager,
// shellPaths, voiceProviders) onto the SDK service's flat deps.
//
// Extracted into its own module rather than built inline in services.ts, which
// sits at the architecture check's 800-line cap (scripts/check-architecture.ts)
// — new service construction gets its own module and a single wiring call there.
// ---------------------------------------------------------------------------

import {
  createVoiceSetupService,
  type VoiceSetupService,
} from '@pellux/goodvibes-sdk/platform/runtime/voice-setup';
import type { VoiceProviderRegistry } from '@pellux/goodvibes-sdk/platform/voice';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ShellPathService } from '@/runtime/index.ts';

export type { VoiceSetupService };

export interface VoiceSetupServicesDeps {
  readonly configManager: ConfigManager;
  readonly shellPaths: Pick<ShellPathService, 'resolveUserPath'>;
  readonly voiceProviders: VoiceProviderRegistry;
  /** Critical-tier admission gate — a provision run allocates archive + model buffers. */
  readonly admitExpensiveWork: (label: string) => { allowed: boolean; reason?: string | undefined };
}

/** Compose the managed-voice single-flight install + no-network status read. */
export function wireVoiceSetup(deps: VoiceSetupServicesDeps): { voiceSetup: VoiceSetupService } {
  const { configManager, voiceProviders } = deps;
  const voiceSetup = createVoiceSetupService({
    managedVoiceRoot: deps.shellPaths.resolveUserPath('voice'),
    getConfig: (key) => String(configManager.get(key as Parameters<typeof configManager.get>[0]) ?? ''),
    setConfig: (key, value) => configManager.setDynamic(key as Parameters<typeof configManager.setDynamic>[0], value),
    // A successful (re-)install clears any tripped local-engine breaker.
    resetLocalEngineFailureState: () => voiceProviders.get('local')?.resetEngineFailureState?.(),
    admitExpensiveWork: deps.admitExpensiveWork,
  });
  return { voiceSetup };
}
