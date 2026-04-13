import { randomUUID } from 'node:crypto';
import { ArtifactStore } from '../artifacts/index.ts';
import type { ArtifactDescriptor, ArtifactRecord } from '../artifacts/types.ts';
import { MediaProviderRegistry } from '../media/index.ts';
import { extractKnowledgeArtifact } from '../knowledge/extractors.ts';
import { KnowledgeService } from '../knowledge/index.ts';
import { VoiceService } from '../voice/index.ts';
import type { VoiceAudioArtifact } from '../voice/index.ts';
import type {
  MultimodalAnalysisRequest,
  MultimodalAnalysisResult,
  MultimodalDetail,
  MultimodalKind,
  MultimodalPacket,
  MultimodalProviderDescriptor,
  MultimodalServiceStatus,
  MultimodalWritebackResult,
} from './types.ts';

const PACKET_BUDGETS: Record<MultimodalDetail, number> = {
  compact: 280,
  standard: 680,
  detailed: 1_280,
};

function estimateTokens(...values: Array<string | undefined>): number {
  const total = values.reduce((sum, value) => sum + (value?.length ?? 0), 0);
  return Math.max(1, Math.ceil(total / 4));
}

function compactText(value: string | undefined, maxLength = 240): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1).trim()}…`;
}

function coerceStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim());
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function topKeywords(input: string, limit = 8): string[] {
  const counts = new Map<string, number>();
  for (const token of input.toLowerCase().split(/[^a-z0-9_./:-]+/).map((entry) => entry.trim()).filter(Boolean)) {
    if (token.length < 3) continue;
    if (/^(https?|www|the|and|for|with|from|this|that|into|over)$/.test(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(1, limit))
    .map(([token]) => token);
}

function audioFormatFromMimeType(mimeType: string): VoiceAudioArtifact['format'] {
  const lower = mimeType.toLowerCase();
  if (lower.includes('wav')) return 'wav';
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3';
  if (lower.includes('ogg')) return 'ogg';
  if (lower.includes('webm')) return 'webm';
  if (lower.includes('flac')) return 'flac';
  return 'wav';
}

function detailLimit(detail: MultimodalDetail, compact: number, standard: number, detailed: number): number {
  switch (detail) {
    case 'compact':
      return compact;
    case 'detailed':
      return detailed;
    default:
      return standard;
  }
}

function mergeUnique(...groups: Array<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const group of groups) {
    for (const entry of group ?? []) {
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

export class MultimodalService {
  constructor(
    private readonly artifactStore: ArtifactStore,
    private readonly mediaProviders: MediaProviderRegistry,
    private readonly voiceService: VoiceService,
    private readonly knowledgeService: KnowledgeService,
  ) {}

  async getStatus(): Promise<MultimodalServiceStatus> {
    const providers = await this.listProviders();
    return {
      enabled: providers.length > 0,
      providerCount: providers.length,
      providers,
      note: 'Multimodal analysis routes images through media understanding, audio through speech-to-text, documents through TS extractors, and video through keyframe/transcript fusion. Generated markdown packets and write-back are optional.',
    };
  }

  async listProviders(): Promise<readonly MultimodalProviderDescriptor[]> {
    const media = (await this.mediaProviders.status())
      .filter((provider) => provider.capabilities.includes('understand'))
      .map<MultimodalProviderDescriptor>((provider) => ({
        id: provider.id,
        label: provider.label,
        transport: 'media',
        capabilities: ['image.describe'],
        configured: provider.configured,
        metadata: provider.metadata,
      }));
    const voice = (await this.voiceService.getStatus(true)).providers
      .filter((provider) => provider.capabilities.includes('stt'))
      .map<MultimodalProviderDescriptor>((provider) => ({
        id: provider.id,
        label: provider.label,
        transport: provider.capabilities.includes('realtime') ? 'hybrid' : 'voice',
        capabilities: provider.capabilities.includes('realtime')
          ? ['audio.transcribe', 'audio.realtime']
          : ['audio.transcribe'],
        configured: provider.configured,
        metadata: provider.metadata,
      }));
    const extractors: MultimodalProviderDescriptor[] = [
      {
        id: 'knowledge-extractors',
        label: 'Built-in Knowledge Extractors',
        transport: 'extractor',
        capabilities: ['document.extract', 'video.keyframe-fusion'],
        configured: true,
        metadata: {},
      },
    ];
    return [...media, ...voice, ...extractors].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  async analyze(request: MultimodalAnalysisRequest): Promise<MultimodalAnalysisResult> {
    const { descriptor, record, buffer } = await this.resolveArtifactInput(request);
    switch (this.resolveKind(descriptor)) {
      case 'image':
        return this.analyzeImage(descriptor, request);
      case 'audio':
        return this.analyzeAudio(descriptor, buffer, request);
      case 'video':
        return this.analyzeVideo(descriptor, request);
      default:
        return this.analyzeDocument(record, buffer, request);
    }
  }

  buildPacket(result: MultimodalAnalysisResult, detail: MultimodalDetail = 'standard', budgetLimit = PACKET_BUDGETS[detail]): MultimodalPacket {
    const highlights = [
      result.summary,
      ...result.labels.slice(0, detailLimit(detail, 2, 4, 8)),
      ...result.segments.map((segment) => compactText(segment.text, detailLimit(detail, 100, 180, 260))).filter((segment): segment is string => Boolean(segment)),
    ].filter((entry): entry is string => Boolean(entry));
    const lines = [
      '## Multimodal Analysis',
      `Kind: ${result.kind} | detail: ${detail} | artifact: ${result.artifact.id}`,
    ];
    if (result.summary) lines.push(`Summary: ${result.summary}`);
    if (result.labels.length > 0) lines.push(`Labels: ${result.labels.join(', ')}`);
    if (result.entities.length > 0) lines.push(`Entities: ${result.entities.join(', ')}`);
    if (result.text) lines.push(`Text: ${compactText(result.text, detailLimit(detail, 180, 320, 520))}`);
    for (const segment of result.segments.slice(0, detailLimit(detail, 2, 4, 8))) {
      const segmentLabel = segment.title ? `${segment.kind}:${segment.title}` : segment.kind;
      if (segment.text) lines.push(`- ${segmentLabel}: ${compactText(segment.text, detailLimit(detail, 120, 220, 360))}`);
    }
    const rendered = lines.join('\n');
    return {
      detail,
      budgetLimit,
      estimatedTokens: estimateTokens(rendered),
      rendered,
      highlights: highlights.slice(0, detailLimit(detail, 4, 8, 16)),
    };
  }

  async writeBackAnalysis(
    result: MultimodalAnalysisResult,
    input: {
      readonly sessionId?: string;
      readonly title?: string;
      readonly tags?: readonly string[];
      readonly folderPath?: string;
      readonly metadata?: Record<string, unknown>;
    } = {},
  ): Promise<MultimodalWritebackResult> {
    const analysisArtifact = await this.artifactStore.create({
      mimeType: 'application/json',
      filename: `${result.artifact.filename ?? result.artifact.id}.analysis.json`,
      text: `${JSON.stringify(result, null, 2)}\n`,
      metadata: {
        sourceArtifactId: result.artifact.id,
        multimodalKind: result.kind,
        providerIds: [...result.providerIds],
        ...(input.metadata ?? {}),
      },
    });
    const ingest = await this.knowledgeService.ingestArtifact({
      artifactId: analysisArtifact.id,
      title: input.title ?? `${result.artifact.filename ?? result.artifact.id} analysis`,
      tags: mergeUnique(
        input.tags,
        result.labels,
        result.entities,
        [`multimodal:${result.kind}`],
      ),
      folderPath: input.folderPath,
      sessionId: input.sessionId,
      sourceType: 'document',
      connectorId: 'multimodal-analysis',
      metadata: {
        sourceArtifactId: result.artifact.id,
        multimodalKind: result.kind,
        providerIds: [...result.providerIds],
        ...(input.metadata ?? {}),
      },
    });
    await this.knowledgeService.recordUsage({
      targetKind: 'source',
      targetId: ingest.source.id,
      usageKind: 'multimodal-writeback',
      sessionId: input.sessionId,
      metadata: {
        sourceArtifactId: result.artifact.id,
        multimodalKind: result.kind,
      },
    });
    return {
      analysisArtifact,
      knowledgeSourceId: ingest.source.id,
      metadata: {
        sourceArtifactId: result.artifact.id,
        multimodalKind: result.kind,
      },
    };
  }

  private async resolveArtifactInput(
    request: MultimodalAnalysisRequest,
  ): Promise<{ descriptor: ArtifactDescriptor; record: ArtifactRecord; buffer: Buffer }> {
    const artifactId = request.artifactId ?? request.artifact?.artifactId;
    if (artifactId) {
      const { record, buffer } = await this.artifactStore.readContent(artifactId);
      return {
        descriptor: this.artifactStore.get(artifactId)!,
        record,
        buffer,
      };
    }

    const artifact = request.artifact;
    if (!artifact) throw new Error('Multimodal analysis requires artifactId or artifact input.');
    const created = await this.artifactStore.create({
      ...(artifact.dataBase64 ? { dataBase64: artifact.dataBase64 } : {}),
      ...(artifact.uri ? { uri: artifact.uri, allowPrivateHosts: artifact.allowPrivateHosts } : {}),
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      ...(artifact.filename ? { filename: artifact.filename } : {}),
      metadata: artifact.metadata ?? {},
    });
    const { record, buffer } = await this.artifactStore.readContent(created.id);
    return { descriptor: created, record, buffer };
  }

  private resolveKind(descriptor: ArtifactDescriptor): MultimodalKind {
    switch (descriptor.kind) {
      case 'image':
        return 'image';
      case 'audio':
        return 'audio';
      case 'video':
        return 'video';
      default:
        return 'document';
    }
  }

  private async analyzeImage(
    descriptor: ArtifactDescriptor,
    request: MultimodalAnalysisRequest,
  ): Promise<MultimodalAnalysisResult> {
    const provider = this.mediaProviders.findProvider('understand', request.imageProviderId);
    if (!provider?.analyze) {
      throw new Error('No image-understanding provider is registered.');
    }
    const result = await provider.analyze({
      artifact: {
        artifactId: descriptor.id,
        mimeType: descriptor.mimeType,
        filename: descriptor.filename,
        sizeBytes: descriptor.sizeBytes,
        metadata: descriptor.metadata,
      },
      prompt: request.prompt,
      modelId: request.modelId,
      metadata: request.metadata,
    });
    const text = compactText(result.text, 2_000);
    const summary = compactText(result.description ?? text, 320);
    const segments = [
      ...(text ? [{ kind: 'ocr' as const, text, metadata: {} }] : []),
      ...(summary ? [{ kind: 'summary' as const, text: summary, metadata: {} }] : []),
    ];
    return {
      id: `mm-${randomUUID().slice(0, 8)}`,
      kind: 'image',
      artifact: descriptor,
      providerIds: [result.providerId],
      summary,
      ...(text ? { text } : {}),
      labels: mergeUnique(result.labels),
      entities: topKeywords([summary ?? '', text ?? '', ...result.labels ?? []].join(' '), 8),
      segments,
      metadata: result.metadata,
    };
  }

  private async analyzeAudio(
    descriptor: ArtifactDescriptor,
    buffer: Buffer,
    request: MultimodalAnalysisRequest,
  ): Promise<MultimodalAnalysisResult> {
    const transcript = await this.voiceService.transcribe(request.audioProviderId, {
      audio: {
        mimeType: descriptor.mimeType,
        format: audioFormatFromMimeType(descriptor.mimeType),
        dataBase64: buffer.toString('base64'),
        metadata: descriptor.metadata,
      },
      language: request.language,
      modelId: request.modelId,
      prompt: request.prompt,
      metadata: request.metadata,
    });
    const summary = compactText(transcript.text, 320);
    const text = compactText(transcript.text, 4_000);
    const segments = (transcript.segments ?? []).map((segment) => ({
      kind: 'transcript' as const,
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
      confidence: segment.confidence,
      metadata: {},
    }));
    return {
      id: `mm-${randomUUID().slice(0, 8)}`,
      kind: 'audio',
      artifact: descriptor,
      providerIds: [transcript.providerId],
      summary,
      ...(text ? { text } : {}),
      labels: request.language ? [request.language] : transcript.language ? [transcript.language] : [],
      entities: topKeywords(transcript.text, 10),
      segments,
      metadata: transcript.metadata,
    };
  }

  private async analyzeDocument(
    record: ArtifactRecord,
    buffer: Buffer,
    _request: MultimodalAnalysisRequest,
  ): Promise<MultimodalAnalysisResult> {
    const extraction = await extractKnowledgeArtifact(record, buffer);
    const segments = extraction.sections.slice(0, 12).map((section) => ({
      kind: 'section' as const,
      title: section,
      text: section,
      metadata: {},
    }));
    const text = compactText([extraction.summary ?? '', extraction.excerpt ?? ''].join('\n\n'), 4_000);
    return {
      id: `mm-${randomUUID().slice(0, 8)}`,
      kind: 'document',
      artifact: this.artifactStore.get(record.id)!,
      providerIds: ['knowledge-extractors'],
      summary: compactText(extraction.summary ?? extraction.excerpt, 320),
      ...(text ? { text } : {}),
      labels: mergeUnique(extraction.sections.slice(0, 8)),
      entities: mergeUnique(topKeywords([extraction.title ?? '', extraction.summary ?? '', extraction.excerpt ?? ''].join(' '), 10)),
      segments,
      metadata: {
        extractorId: extraction.extractorId,
        format: extraction.format,
        structure: extraction.structure,
        extractionMetadata: extraction.metadata,
      },
    };
  }

  private async analyzeVideo(
    descriptor: ArtifactDescriptor,
    request: MultimodalAnalysisRequest,
  ): Promise<MultimodalAnalysisResult> {
    const requestMetadata = request.metadata ?? {};
    const keyframeIds = coerceStringList(requestMetadata.keyframeArtifactIds ?? descriptor.metadata.keyframeArtifactIds);
    const transcriptArtifactId = typeof requestMetadata.transcriptArtifactId === 'string'
      ? requestMetadata.transcriptArtifactId
      : typeof descriptor.metadata.transcriptArtifactId === 'string'
        ? descriptor.metadata.transcriptArtifactId
        : undefined;
    const audioArtifactId = typeof requestMetadata.audioArtifactId === 'string'
      ? requestMetadata.audioArtifactId
      : typeof descriptor.metadata.audioArtifactId === 'string'
        ? descriptor.metadata.audioArtifactId
        : undefined;

    const sceneSegments: Array<MultimodalAnalysisResult['segments'][number]> = [];
    const labels: string[] = [];
    const providerIds = new Set<string>();

    for (const [index, keyframeId] of keyframeIds.slice(0, 6).entries()) {
      const frameDescriptor = this.artifactStore.get(keyframeId);
      if (!frameDescriptor) continue;
      const frameAnalysis = await this.analyzeImage(frameDescriptor, {
        imageProviderId: request.imageProviderId,
        modelId: request.modelId,
        prompt: request.prompt ? `${request.prompt}\nFocus on this video keyframe.` : 'Describe this video keyframe.',
        metadata: request.metadata,
      });
      for (const providerId of frameAnalysis.providerIds) providerIds.add(providerId);
      labels.push(...frameAnalysis.labels);
      sceneSegments.push({
        kind: 'scene',
        title: `Scene ${index + 1}`,
        text: frameAnalysis.summary ?? frameAnalysis.text,
        metadata: {
          frameArtifactId: frameDescriptor.id,
        },
      });
    }

    if (audioArtifactId || transcriptArtifactId) {
      const audioDescriptor = this.artifactStore.get(audioArtifactId ?? transcriptArtifactId!);
      if (audioDescriptor) {
        const audioResult = await this.analyzeAudio(
          audioDescriptor,
          (await this.artifactStore.readContent(audioArtifactId ?? transcriptArtifactId!)).buffer,
          {
            audioProviderId: request.audioProviderId,
            modelId: request.modelId,
            prompt: request.prompt,
            language: request.language,
            metadata: request.metadata,
          },
        );
        for (const providerId of audioResult.providerIds) providerIds.add(providerId);
        labels.push(...audioResult.labels);
        sceneSegments.push(...audioResult.segments.slice(0, 6));
      }
    }

    const summary = compactText([
      sceneSegments[0]?.text,
      sceneSegments[1]?.text,
      sceneSegments.find((segment) => segment.kind === 'transcript')?.text,
    ].filter(Boolean).join(' '), 320) ?? 'Video metadata is available but no keyframes or transcripts were provided for deeper analysis.';

    return {
      id: `mm-${randomUUID().slice(0, 8)}`,
      kind: 'video',
      artifact: descriptor,
      providerIds: [...providerIds].length > 0 ? [...providerIds] : ['knowledge-extractors'],
      summary,
      text: compactText(sceneSegments.map((segment) => segment.text).filter(Boolean).join('\n\n'), 4_000),
      labels: mergeUnique(labels),
      entities: topKeywords(sceneSegments.map((segment) => segment.text).filter(Boolean).join(' '), 10),
      segments: sceneSegments,
      metadata: {
        keyframeArtifactIds: keyframeIds,
        transcriptArtifactId,
        audioArtifactId,
      },
    };
  }
}
