/**
 * voice-stt-gateway.ts, speech-to-text for captured audio.
 *
 * Both voice consumers end here: push-to-talk hands over what the user just
 * said, and a confirmed wake hands over the utterance that followed it. The
 * transcription itself is the daemon's, not this process's, `voice.stt`
 * (POST /api/voice/stt) transcribes an audio artifact through whichever voice
 * provider is registered, including the managed local whisper that
 * `/voice setup` provisions.
 *
 * The verb has no named facade on the in-process OperatorClient, so it goes over
 * the generic operator invoke path exactly like the voice PROVISIONING verbs do
 * (see core/voice-provision-gateway.ts), same daemon, same resolution, same
 * honest refusal reasons up front rather than a throw mid-capture.
 */

import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk';
import type { OperatorMethodOutput } from '@pellux/goodvibes-sdk';
import type { UtteranceAudioArtifact } from '@pellux/goodvibes-sdk/platform/voice';
import { resolveOperatorRpc, describeOperatorRpcError } from '../input/commands/operator-rpc.ts';

/** voice.stt output, the recognised text plus the provider that produced it. */
export type VoiceTranscriptionResult = OperatorMethodOutput<'voice.stt'>;

/** The narrow verb surface a capture consumer needs. */
export interface VoiceSttGateway {
  /** Transcribe one captured utterance; resolves to the recognised text. */
  transcribe(audio: UtteranceAudioArtifact): Promise<string>;
}

/**
 * Why transcription is unavailable, surfaced verbatim so a capture path prints
 * the daemon's reason instead of inventing one.
 */
export type VoiceSttGatewayResolution =
  | { readonly available: true; readonly gateway: VoiceSttGateway }
  | { readonly available: false; readonly reason: string };

export interface VoiceSttGatewayDeps {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
}

/** Build the live speech-to-text gateway, or say why there is none. */
export function createVoiceSttGateway(deps: VoiceSttGatewayDeps): VoiceSttGatewayResolution {
  const rpc = resolveOperatorRpc({ configManager: deps.configManager, homeDirectory: deps.homeDirectory });
  if (!rpc.available) return { available: false, reason: rpc.reason };
  const { sdk } = rpc;
  return {
    available: true,
    gateway: {
      transcribe: async (audio) => {
        // The generic invoke widens to `unknown` for this verb; the cast names the
        // contract's own output type rather than inventing a local shape, so a
        // contract change surfaces here as a type error.
        const result = await sdk.operator.invoke('voice.stt', { audio }) as VoiceTranscriptionResult;
        return result.text;
      },
    },
  };
}

/**
 * Render a `voice.stt` rejection honestly. A 501 (the verb is cataloged but this
 * daemon has no voice provider wired behind it) and a 404 (an older daemon
 * without the route) are both "no transcription here", distinct from a request
 * that reached a provider and failed, which the user can act on differently.
 */
export function describeTranscriptionFailure(error: unknown): string {
  if (error instanceof GoodVibesSdkError && (error.status === 501 || error.status === 404)) {
    return 'this daemon has no speech-to-text provider wired up; run /voice setup to provision the managed local runtime.';
  }
  return describeOperatorRpcError(error);
}
