export type VoiceProviderCapability = 'tts' | 'stt' | 'realtime' | 'voice-list';
export type VoiceProviderState = 'healthy' | 'degraded' | 'disabled' | 'unconfigured';
export type VoiceAudioFormat = 'wav' | 'mp3' | 'ogg' | 'webm' | 'pcm16' | 'flac';

export interface VoiceProviderStatus {
  readonly id: string;
  readonly label: string;
  readonly state: VoiceProviderState;
  readonly capabilities: readonly VoiceProviderCapability[];
  readonly configured: boolean;
  readonly detail?: string;
  readonly metadata: Record<string, unknown>;
}

export interface VoiceDescriptor {
  readonly id: string;
  readonly label: string;
  readonly locale?: string;
  readonly gender?: string;
  readonly metadata: Record<string, unknown>;
}

export interface VoiceAudioArtifact {
  readonly mimeType: string;
  readonly format: VoiceAudioFormat | string;
  readonly dataBase64?: string;
  readonly uri?: string;
  readonly sampleRateHz?: number;
  readonly durationMs?: number;
  readonly metadata: Record<string, unknown>;
}

export interface VoiceSynthesisRequest {
  readonly text: string;
  readonly voiceId?: string;
  readonly modelId?: string;
  readonly format?: VoiceAudioFormat | string;
  readonly speed?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface VoiceSynthesisResult {
  readonly providerId: string;
  readonly audio: VoiceAudioArtifact;
  readonly metadata: Record<string, unknown>;
}

export interface VoiceTranscriptionRequest {
  readonly audio: VoiceAudioArtifact;
  readonly language?: string;
  readonly modelId?: string;
  readonly prompt?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface VoiceTranscriptionResult {
  readonly providerId: string;
  readonly text: string;
  readonly language?: string;
  readonly segments?: readonly {
    readonly text: string;
    readonly startMs?: number;
    readonly endMs?: number;
    readonly confidence?: number;
  }[];
  readonly metadata: Record<string, unknown>;
}

export interface VoiceRealtimeSessionRequest {
  readonly modelId?: string;
  readonly voiceId?: string;
  readonly inputFormat?: VoiceAudioFormat | string;
  readonly outputFormat?: VoiceAudioFormat | string;
  readonly instructions?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface VoiceRealtimeSession {
  readonly providerId: string;
  readonly sessionId: string;
  readonly transport: 'websocket' | 'webrtc' | 'sse' | 'http' | 'custom';
  readonly url?: string;
  readonly expiresAt?: number;
  readonly headers?: Record<string, string>;
  readonly metadata: Record<string, unknown>;
}

export interface VoiceProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly VoiceProviderCapability[];
  status?(): Promise<VoiceProviderStatus> | VoiceProviderStatus;
  listVoices?(): Promise<readonly VoiceDescriptor[]> | readonly VoiceDescriptor[];
  synthesize?(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult>;
  transcribe?(request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult>;
  openRealtimeSession?(request: VoiceRealtimeSessionRequest): Promise<VoiceRealtimeSession>;
}
