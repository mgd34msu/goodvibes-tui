import { VoiceProviderRegistry } from './provider-registry.ts';
import type {
  VoiceDescriptor,
  VoiceRealtimeSession,
  VoiceRealtimeSessionRequest,
  VoiceSynthesisRequest,
  VoiceSynthesisResult,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResult,
} from './types.ts';

export interface VoiceServiceStatus {
  readonly enabled: boolean;
  readonly providerCount: number;
  readonly providers: Awaited<ReturnType<VoiceProviderRegistry['status']>>;
  readonly note: string;
}

export class VoiceService {
  constructor(private readonly registry: VoiceProviderRegistry) {}

  async getStatus(enabled: boolean): Promise<VoiceServiceStatus> {
    const providers = await this.registry.status();
    return {
      enabled,
      providerCount: providers.length,
      providers,
      note: 'Voice capture is intentionally external to the TUI process; web or companion clients can stream audio into these provider-backed APIs.',
    };
  }

  async listVoices(providerId?: string): Promise<readonly VoiceDescriptor[]> {
    const providers = providerId
      ? [this.registry.get(providerId)].filter((provider): provider is NonNullable<typeof provider> => provider !== null)
      : this.registry.list().map((entry) => this.registry.get(entry.id)).filter((provider): provider is NonNullable<typeof provider> => provider !== null);
    const voices: VoiceDescriptor[] = [];
    for (const provider of providers) {
      if (!provider.listVoices) continue;
      voices.push(...await provider.listVoices());
    }
    return voices.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  async synthesize(providerId: string | undefined, request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    const provider = this.registry.findProvider('tts', providerId);
    if (!provider?.synthesize) {
      throw new Error(providerId ? `Voice TTS provider unavailable: ${providerId}` : 'No voice TTS provider is registered');
    }
    return provider.synthesize(request);
  }

  async transcribe(providerId: string | undefined, request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> {
    const provider = this.registry.findProvider('stt', providerId);
    if (!provider?.transcribe) {
      throw new Error(providerId ? `Voice STT provider unavailable: ${providerId}` : 'No voice STT provider is registered');
    }
    return provider.transcribe(request);
  }

  async openRealtimeSession(providerId: string | undefined, request: VoiceRealtimeSessionRequest): Promise<VoiceRealtimeSession> {
    const provider = this.registry.findProvider('realtime', providerId);
    if (!provider?.openRealtimeSession) {
      throw new Error(providerId ? `Voice realtime provider unavailable: ${providerId}` : 'No voice realtime provider is registered');
    }
    return provider.openRealtimeSession(request);
  }
}
