export type ArtifactKind = string;
export type FetchExtractMode = string;
export type MediaArtifact = Record<string, unknown>;
export type MultimodalAnalysisResult = unknown;
export type MultimodalDetail = string;
export type VoiceAudioArtifact = Record<string, unknown>;
export type WebSearchSafeSearch = string;
export type WebSearchTimeRange = string;
export type WebSearchVerbosity = string;

export interface ConfigManagerLike {
  get(key: string): unknown;
}

export interface VoiceServiceLike {
  getStatus(enabled: boolean): Promise<{ providers: readonly unknown[] }>;
  listVoices(providerId?: string): Promise<readonly unknown[]>;
  synthesize(providerId: string | undefined, input: Record<string, unknown>): Promise<unknown>;
  transcribe(providerId: string | undefined, input: Record<string, unknown>): Promise<unknown>;
  openRealtimeSession(providerId: string | undefined, input: Record<string, unknown>): Promise<unknown>;
}

export interface WebSearchServiceLike {
  getStatus(): Promise<{ providers: readonly unknown[] }>;
  search(input: Record<string, unknown>): Promise<unknown>;
}

export interface ArtifactStoreLike {
  list(): readonly unknown[];
  create(input: Record<string, unknown>): Promise<unknown>;
  get(artifactId: string): unknown | null;
  readContent(artifactId: string): Promise<{
    readonly record: { readonly mimeType: string; readonly filename?: string };
    readonly buffer: ArrayBuffer | Uint8Array;
  }>;
}

export interface MediaProviderLike {
  analyze?(input: Record<string, unknown>): Promise<unknown>;
  transform?(input: Record<string, unknown>): Promise<unknown>;
  generate?(input: Record<string, unknown>): Promise<unknown>;
}

export interface MediaProviderRegistryLike {
  status(): Promise<unknown>;
  findProvider(
    capability: 'understand' | 'transform' | 'generate',
    providerId?: string,
  ): MediaProviderLike | null;
}

export interface MultimodalServiceLike {
  getStatus(): Promise<unknown>;
  listProviders(): Promise<readonly unknown[]>;
  analyze(input: Record<string, unknown>): Promise<MultimodalAnalysisResult>;
  buildPacket(
    analysis: MultimodalAnalysisResult,
    detail: MultimodalDetail,
    budgetLimit?: number,
  ): unknown;
  writeBackAnalysis(analysis: MultimodalAnalysisResult, input: Record<string, unknown>): Promise<unknown>;
}

export interface DaemonMediaRouteContext {
  readonly artifactStore: ArtifactStoreLike;
  readonly configManager: ConfigManagerLike;
  readonly mediaProviders: MediaProviderRegistryLike;
  readonly multimodalService: MultimodalServiceLike;
  readonly parseJsonBody: (req: Request) => Promise<Record<string, unknown> | Response>;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly voiceService: VoiceServiceLike;
  readonly webSearchService: WebSearchServiceLike;
}
