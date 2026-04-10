import { ArtifactStore } from '../artifacts/index.ts';
import { providerRegistry } from '../providers/registry.ts';
import type { ContentPart, LLMProvider, ProviderMessage } from '../providers/interface.ts';
import type {
  MediaAnalysisRequest,
  MediaAnalysisResult,
  MediaProvider,
  MediaProviderStatus,
} from './provider-registry.ts';

interface StructuredImageAnalysis {
  description?: string;
  text?: string;
  labels?: string[];
  [key: string]: unknown;
}

interface ImageUnderstandingScope {
  readonly providerId: string;
  readonly label: string;
  readonly allowProviderIds?: readonly string[];
  readonly requireLocal?: boolean;
}

function buildAnalysisPrompt(prompt?: string): string {
  const task = prompt?.trim().length
    ? prompt.trim()
    : 'Describe the image, extract visible text, and identify the main labels or objects.';
  return [
    'Analyze the attached image.',
    `Task: ${task}`,
    'Return valid JSON only with this shape:',
    '{"description":"string","text":"string","labels":["string"],"observations":{}}',
    'Use an empty string or empty array when a field is not available.',
  ].join('\n');
}

function parseStructuredAnalysis(content: string): StructuredImageAnalysis | null {
  const candidates = [
    content.trim(),
    ...[...content.matchAll(/```json\s*([\s\S]*?)```/gi)].map((match) => match[1]?.trim() ?? ''),
    ...[...content.matchAll(/(\{[\s\S]*\})/g)].map((match) => match[1]?.trim() ?? ''),
  ].filter((candidate, index, values) => candidate.length > 0 && values.indexOf(candidate) === index);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as StructuredImageAnalysis;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

async function modelMatchesScope(
  model: Record<string, unknown>,
  scope: ImageUnderstandingScope,
): Promise<boolean> {
  const providerId = typeof model.provider === 'string' ? model.provider : '';
  if ((scope.allowProviderIds?.length ?? 0) > 0 && !scope.allowProviderIds!.includes(providerId)) {
    return false;
  }
  if (!scope.requireLocal) return true;
  try {
    const provider = providerRegistry.getForModel(
      String(model.registryKey ?? model.id ?? ''),
      providerId,
    ) as LLMProvider;
    const runtime = await provider.describeRuntime?.();
    return runtime?.policy?.local === true;
  } catch {
    return false;
  }
}

async function resolveModel(
  scope: ImageUnderstandingScope,
  modelId?: string,
): Promise<{
  providerId: string;
  provider: LLMProvider;
  modelId: string;
}> {
  const models = providerRegistry.listModels();
  const resolveCandidate = async () => {
    if (modelId) {
      const explicit = models.find((model) => model.registryKey === modelId || model.id === modelId);
      if (!explicit) {
        throw new Error(`Unknown model for media analysis: ${modelId}`);
      }
      if (!explicit.capabilities.multimodal) {
        throw new Error(`Model does not support image input: ${explicit.displayName}`);
      }
      if (!await modelMatchesScope(explicit as unknown as Record<string, unknown>, scope)) {
        throw new Error(`Model does not match media provider scope ${scope.label}: ${explicit.displayName}`);
      }
      return explicit;
    }
    const current = providerRegistry.getCurrentModel();
    if (current.capabilities.multimodal && await modelMatchesScope(current as unknown as Record<string, unknown>, scope)) {
      return current;
    }
    for (const candidate of models) {
      if (!candidate.selectable || !candidate.capabilities.multimodal) continue;
      if (await modelMatchesScope(candidate as unknown as Record<string, unknown>, scope)) {
        return candidate;
      }
    }
    const fallback = models.find((model) => model.selectable && model.capabilities.multimodal);
    if (fallback) return fallback;
    throw new Error('No multimodal model is available for image understanding');
  };

  const selected = await resolveCandidate();
  const provider = providerRegistry.getForModel(selected.registryKey ?? selected.id, selected.provider);
  return {
    providerId: selected.provider,
    provider,
    modelId: selected.id,
  };
}

async function resolveArtifactInput(request: MediaAnalysisRequest): Promise<{
  mimeType: string;
  dataBase64: string;
  metadata: Record<string, unknown>;
}> {
  if (request.artifact.dataBase64) {
    return {
      mimeType: request.artifact.mimeType,
      dataBase64: request.artifact.dataBase64,
      metadata: request.artifact.metadata,
    };
  }
  const artifactId = request.artifact.artifactId ?? request.artifact.id;
  if (artifactId) {
    const { record, buffer } = await ArtifactStore.getActive().readContent(artifactId);
    return {
      mimeType: record.mimeType,
      dataBase64: buffer.toString('base64'),
      metadata: record.metadata,
    };
  }
  throw new Error('Media analysis requires dataBase64 or artifactId');
}

async function analyzeWithScope(
  scope: ImageUnderstandingScope,
  request: MediaAnalysisRequest,
): Promise<MediaAnalysisResult> {
  const artifact = await resolveArtifactInput(request);
  if (!artifact.mimeType.toLowerCase().startsWith('image/')) {
    throw new Error(`Unsupported media type for image understanding: ${artifact.mimeType}`);
  }

  const selected = await resolveModel(scope, request.modelId);
  const content: ContentPart[] = [
    { type: 'text', text: buildAnalysisPrompt(request.prompt) },
    { type: 'image', data: artifact.dataBase64, mediaType: artifact.mimeType },
  ];
  const messages: ProviderMessage[] = [
    {
      role: 'user',
      content,
    },
  ];
  const response = await selected.provider.chat({
    model: selected.modelId,
    messages,
    maxTokens: 1200,
  });

  const structured = parseStructuredAnalysis(response.content);
  if (structured) {
    const { description, text, labels, ...rest } = structured;
    return {
      providerId: scope.providerId,
      description: typeof description === 'string' ? description.trim() : undefined,
      text: typeof text === 'string' ? text.trim() : undefined,
      labels: normalizeLabels(labels),
      metadata: {
        ...request.metadata,
        ...artifact.metadata,
        llmProviderId: selected.providerId,
        modelId: selected.modelId,
        structured: rest,
      },
    };
  }

  return {
    providerId: scope.providerId,
    description: response.content.trim() || undefined,
    metadata: {
      ...request.metadata,
      ...artifact.metadata,
      llmProviderId: selected.providerId,
      modelId: selected.modelId,
      format: 'plain-text-fallback',
    },
  };
}

function createScopedImageUnderstandingProvider(scope: ImageUnderstandingScope): MediaProvider {
  return {
    id: scope.providerId,
    label: scope.label,
    capabilities: ['understand'],
    async status(): Promise<MediaProviderStatus> {
      let available = false;
      for (const model of providerRegistry.listModels()) {
        if (!model.selectable || !model.capabilities.multimodal) continue;
        if (await modelMatchesScope(model as unknown as Record<string, unknown>, scope)) {
          available = true;
          break;
        }
      }
      return {
        id: scope.providerId,
        label: scope.label,
        state: available ? 'healthy' : 'unconfigured',
        capabilities: ['understand'],
        configured: available,
        detail: available
          ? `Uses ${scope.label} model routing for image understanding.`
          : `Register a matching multimodal model to enable ${scope.label}.`,
        metadata: {},
      };
    },
    analyze: (request) => analyzeWithScope(scope, request),
  };
}

export function createBuiltinImageUnderstandingProvider(): MediaProvider {
  return createScopedImageUnderstandingProvider({
    providerId: 'builtin:image-understanding',
    label: 'Built-in Image Understanding',
  });
}

export function createOpenAIImageUnderstandingProvider(): MediaProvider {
  return createScopedImageUnderstandingProvider({
    providerId: 'builtin:image-openai',
    label: 'OpenAI Image Understanding',
    allowProviderIds: ['openai'],
  });
}

export function createGeminiImageUnderstandingProvider(): MediaProvider {
  return createScopedImageUnderstandingProvider({
    providerId: 'builtin:image-gemini',
    label: 'Gemini Image Understanding',
    allowProviderIds: ['gemini'],
  });
}

export function createAnthropicImageUnderstandingProvider(): MediaProvider {
  return createScopedImageUnderstandingProvider({
    providerId: 'builtin:image-anthropic',
    label: 'Anthropic Image Understanding',
    allowProviderIds: ['anthropic'],
  });
}

export function createLocalImageUnderstandingProvider(): MediaProvider {
  return createScopedImageUnderstandingProvider({
    providerId: 'builtin:image-local',
    label: 'Local OpenAI-Compatible Image Understanding',
    requireLocal: true,
  });
}
