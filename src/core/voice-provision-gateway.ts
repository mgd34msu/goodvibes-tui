// ---------------------------------------------------------------------------
// voice-provision-gateway.ts
//
// The daemon-backed verbs the /voice setup + /voice status surfaces read:
// voice.local.status (GET /api/voice/local/status) — the no-network installed
// snapshot — and voice.local.install (POST /api/voice/local/install) — the
// one-act managed install. Neither has a named facade on the in-process
// OperatorClient, so — exactly like the memory-consolidation gateway — they go
// over the generic operator invoke path (operator-rpc.ts's resolveOperatorRpc
// -> sdk.operator.invoke), reaching the SAME daemon the command layer does.
//
// A daemon that predates managed voice provisioning answers an honest 501 (verb
// cataloged but no handler) or a 404 (older daemon without the route) — both
// are "verb unavailable", NOT a fabricated empty/failed install (see
// classifyVoiceProvisionError). The interface is injectable so the command and
// its tests round-trip against a mocked daemon.
// ---------------------------------------------------------------------------

import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk';
import { resolveOperatorRpc, describeOperatorRpcError } from '../input/commands/operator-rpc.ts';
import type { VoiceRuntimeStatusResult, VoiceLocalInstallResult } from './voice-provision-status.ts';
import { voiceStatusLines, voiceInstallReceiptLines } from './voice-provision-status.ts';

/** The narrow async verb surface the /voice setup + /voice status surfaces drive. */
export interface VoiceProvisionGateway {
  /** Read the no-network managed-runtime snapshot (voice.local.status). */
  fetchStatus(): Promise<VoiceRuntimeStatusResult>;
  /** Run the one-act managed install (voice.local.install); resolves to the receipt. */
  runInstall(): Promise<VoiceLocalInstallResult>;
}

/**
 * Why the gateway could not be built (daemon disabled / no control-plane URL),
 * surfaced verbatim so the surface prints an honest "unavailable" line rather
 * than guessing — mirrors MemoryConsolidationGatewayResolution.
 */
export type VoiceProvisionGatewayResolution =
  | { readonly available: true; readonly gateway: VoiceProvisionGateway }
  | { readonly available: false; readonly reason: string };

export interface VoiceProvisionGatewayDeps {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
}

/**
 * Build the live voice-provisioning gateway over the generic operator invoke
 * path — the same daemon resolution the command layer uses. Returns an honest
 * unavailable reason when no daemon is reachable, so the surface refuses
 * cleanly instead of throwing mid-render.
 */
export function createVoiceProvisionGateway(deps: VoiceProvisionGatewayDeps): VoiceProvisionGatewayResolution {
  const rpc = resolveOperatorRpc({ configManager: deps.configManager, homeDirectory: deps.homeDirectory });
  if (!rpc.available) return { available: false, reason: rpc.reason };
  const { sdk } = rpc;
  return {
    available: true,
    gateway: {
      fetchStatus: () => sdk.operator.invoke('voice.local.status', {}),
      runInstall: () => sdk.operator.invoke('voice.local.install', {}),
    },
  };
}

/** How a voice verb rejection should render. */
export type VoiceProvisionFetchFailure =
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Classify a voice verb rejection: a 501 (a daemon that predates managed voice
 * provisioning — cataloged but unhandled) or a 404 (an older daemon without the
 * route) are both "verb unavailable", distinct from a generic request failure
 * (network error, 401/403, 500). Reuses describeOperatorRpcError's wording so
 * the call sites never diverge on how they describe the same daemon response.
 */
export function classifyVoiceProvisionError(error: unknown): VoiceProvisionFetchFailure {
  if (error instanceof GoodVibesSdkError && (error.status === 501 || error.status === 404)) {
    return { kind: 'unavailable', reason: 'this daemon does not serve managed voice provisioning yet.' };
  }
  return { kind: 'error', message: describeOperatorRpcError(error) };
}

/** The single one-act setup announcement shown before the (possibly long) install runs. */
export const VOICE_SETUP_ANNOUNCEMENT = [
  'Local Voice Setup',
  '  provisioning the managed local voice runtime (piper TTS + a default voice; whisper STT where a bundle is published)…',
  '  downloads are checksum-verified and resumable — re-run /voice setup to retry any failed component.',
].join('\n');

/**
 * Render the /voice status or /voice setup RESULT block from an already-resolved
 * gateway resolution — the testable core the command wraps. Kept separate from
 * the live gateway construction so a wire test injects a fake resolution
 * (available / unavailable / failing) with no HTTP, mirroring the Memory modal's
 * injectable resolveConsolidationGateway seam. The caller prints
 * VOICE_SETUP_ANNOUNCEMENT itself before awaiting a setup so the up-front notice
 * shows during the (possibly long, multi-hundred-MB) install.
 */
export async function renderVoiceProvision(
  sub: 'status' | 'setup',
  resolution: VoiceProvisionGatewayResolution,
): Promise<string> {
  if (!resolution.available) {
    const label = sub === 'status' ? 'Local Voice Runtime' : 'Local Voice Setup';
    return `${label} unavailable: ${resolution.reason}`;
  }
  if (sub === 'status') {
    try {
      const status = await resolution.gateway.fetchStatus();
      return ['Local Voice Runtime', ...voiceStatusLines(status)].join('\n');
    } catch (error) {
      const failure = classifyVoiceProvisionError(error);
      return failure.kind === 'unavailable'
        ? `Local Voice Runtime\n  ${failure.reason}`
        : `Local Voice Runtime\n  could not read status: ${failure.message}`;
    }
  }
  // setup
  try {
    const receipt = await resolution.gateway.runInstall();
    return ['Local Voice Setup — receipt', ...voiceInstallReceiptLines(receipt)].join('\n');
  } catch (error) {
    const failure = classifyVoiceProvisionError(error);
    return failure.kind === 'unavailable'
      ? `Local Voice Setup\n  ${failure.reason}`
      : `Local Voice Setup\n  install failed: ${failure.message}`;
  }
}
