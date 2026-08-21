// ---------------------------------------------------------------------------
// voice-local-settings.ts, the managed local-voice setup affordance the voice
// settings surfaces render beside ElevenLabs.
//
// The local engine registers in the voice provider registry regardless of
// whether it is provisioned yet (its status is honestly "unconfigured", never
// an error). When it is NOT provisioned, the settings/provider-picker surface
// offers the one-act install with its download size declared up front, the
// size is computed synchronously from the pinned piper manifest
// (piperProvisionBytes) so no daemon round-trip is needed just to label the
// offer. Platforms with no pinned managed build say so honestly.
// ---------------------------------------------------------------------------

import { currentVoicePlatform, piperProvisionBytes } from '@pellux/goodvibes-sdk/platform/voice';
import { formatVoiceBytes } from '../core/voice-provision-status.ts';

export interface LocalVoiceSetupOffer {
  /** A pinned managed piper build exists for the current platform. */
  readonly supported: boolean;
  /** The local TTS engine + model config keys are set (managed install applied or user-set). */
  readonly provisioned: boolean;
  /** Human size label for the one-act install ("~85 MB" or an honest unavailable note). */
  readonly sizeLabel: string;
  /** The detail line the provider picker renders for the local engine. */
  readonly detail: string;
  /** The picker action hint (advertises /voice setup only where it can actually provision). */
  readonly actions: string;
}

/**
 * Compute the managed local-voice setup offer from config, with the download
 * size declared up front. `provisioned` reflects whether the local TTS engine
 * binary + model keys are set; an unprovisioned-but-supported platform offers
 * the size-labeled /voice setup one-act.
 */
export function localVoiceSetupOffer(configGet: (key: string) => unknown): LocalVoiceSetupOffer {
  const platform = currentVoicePlatform();
  const bytes = platform ? piperProvisionBytes(platform) : null;
  const supported = bytes !== null && bytes !== undefined;
  const ttsBinary = String(configGet('voice.local.ttsBinary') ?? '').trim();
  const ttsModel = String(configGet('voice.local.ttsModelPath') ?? '').trim();
  const provisioned = ttsBinary.length > 0 && ttsModel.length > 0;
  const sizeLabel = supported ? `~${formatVoiceBytes(bytes)}` : 'unavailable on this platform';

  let detail: string;
  if (!supported) detail = 'local voice: no managed build for this platform (set voice.local.* by hand to use it)';
  else if (provisioned) detail = 'local voice: configured (managed engine set)';
  else detail = `local voice: not set up; run /voice setup (${sizeLabel})`;

  const actions = supported && !provisioned ? '[Enter] select · /voice setup to provision' : '[Enter] set provider';
  return { supported, provisioned, sizeLabel, detail, actions };
}
