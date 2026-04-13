import type { ArtifactDescriptor } from '../artifacts/types.ts';

export type MultimodalKind = 'image' | 'audio' | 'video' | 'document';
export type MultimodalDetail = 'compact' | 'standard' | 'detailed';

export interface MultimodalArtifactInput {
  readonly artifactId?: string;
  readonly mimeType?: string;
  readonly dataBase64?: string;
  readonly uri?: string;
  readonly allowPrivateHosts?: boolean;
  readonly filename?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface MultimodalProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly transport: 'media' | 'voice' | 'extractor' | 'hybrid';
  readonly capabilities: readonly string[];
  readonly configured: boolean;
  readonly metadata: Record<string, unknown>;
}

export interface MultimodalSegment {
  readonly kind: 'transcript' | 'section' | 'scene' | 'ocr' | 'summary';
  readonly title?: string;
  readonly text?: string;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly confidence?: number;
  readonly metadata: Record<string, unknown>;
}

export interface MultimodalAnalysisRequest {
  readonly artifactId?: string;
  readonly artifact?: MultimodalArtifactInput;
  readonly prompt?: string;
  readonly imageProviderId?: string;
  readonly audioProviderId?: string;
  readonly modelId?: string;
  readonly language?: string;
  readonly detail?: MultimodalDetail;
  readonly metadata?: Record<string, unknown>;
}

export interface MultimodalAnalysisResult {
  readonly id: string;
  readonly kind: MultimodalKind;
  readonly artifact: ArtifactDescriptor;
  readonly providerIds: readonly string[];
  readonly summary?: string;
  readonly text?: string;
  readonly labels: readonly string[];
  readonly entities: readonly string[];
  readonly segments: readonly MultimodalSegment[];
  readonly metadata: Record<string, unknown>;
}

export interface MultimodalPacket {
  readonly detail: MultimodalDetail;
  readonly budgetLimit: number;
  readonly estimatedTokens: number;
  readonly rendered: string;
  readonly highlights: readonly string[];
}

export interface MultimodalWritebackResult {
  readonly analysisArtifact: ArtifactDescriptor;
  readonly knowledgeSourceId?: string;
  readonly metadata: Record<string, unknown>;
}

export interface MultimodalServiceStatus {
  readonly enabled: boolean;
  readonly providerCount: number;
  readonly providers: readonly MultimodalProviderDescriptor[];
  readonly note: string;
}
