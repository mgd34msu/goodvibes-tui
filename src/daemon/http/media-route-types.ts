export type {
  ArtifactKind,
  DaemonMediaRouteContext,
  FetchExtractMode,
  MediaArtifact,
  MediaProviderRegistryLike,
  MultimodalAnalysisResult,
  MultimodalDetail,
  MultimodalServiceLike,
  VoiceAudioArtifact,
  VoiceServiceLike,
  WebSearchSafeSearch,
  WebSearchServiceLike,
  WebSearchTimeRange,
  WebSearchVerbosity,
} from '@pellux/goodvibes-sdk-beta/daemon';

export interface ConfigManagerLike {
  get(key: string): unknown;
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
