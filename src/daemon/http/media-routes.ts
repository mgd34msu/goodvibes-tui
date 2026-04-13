import type { ConfigManager } from '../../config/manager.ts';
import type { DaemonApiRouteHandlers } from '../../control-plane/routes/context.ts';
import type { ArtifactStore } from '../../artifacts/index.ts';
import type { ArtifactKind } from '../../artifacts/index.ts';
import type { MediaArtifact, MediaProviderRegistry } from '../../media/index.ts';
import type { MultimodalAnalysisRequest, MultimodalAnalysisResult, MultimodalDetail, MultimodalService } from '../../multimodal/index.ts';
import type { VoiceAudioArtifact, VoiceService } from '../../voice/index.ts';
import type { WebSearchSafeSearch, WebSearchService, WebSearchTimeRange, WebSearchVerbosity } from '../../web-search/index.ts';
import type { FetchExtractMode } from '../../tools/fetch/schema.ts';
import { resolvePrivateHostFetchOptions } from '../http-policy.ts';

type JsonBody = Record<string, unknown>;

interface DaemonMediaRouteContext {
  readonly parseJsonBody: (req: Request) => Promise<JsonBody | Response>;
  readonly voiceService: VoiceService;
  readonly configManager: ConfigManager;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly webSearchService: WebSearchService;
  readonly artifactStore: ArtifactStore;
  readonly mediaProviders: MediaProviderRegistry;
  readonly multimodalService: MultimodalService;
}

export function createDaemonMediaRouteHandlers(
  context: DaemonMediaRouteContext,
): Pick<
  DaemonApiRouteHandlers,
  | 'getVoiceStatus'
  | 'getVoiceProviders'
  | 'getVoiceVoices'
  | 'postVoiceTts'
  | 'postVoiceStt'
  | 'postVoiceRealtimeSession'
  | 'getWebSearchProviders'
  | 'postWebSearch'
  | 'getArtifacts'
  | 'postArtifact'
  | 'getArtifact'
  | 'getArtifactContent'
  | 'getMediaProviders'
  | 'postMediaAnalyze'
  | 'postMediaTransform'
  | 'postMediaGenerate'
  | 'getMultimodalStatus'
  | 'getMultimodalProviders'
  | 'postMultimodalAnalyze'
  | 'postMultimodalPacket'
  | 'postMultimodalWriteback'
> {
  return {
    getVoiceStatus: async () => Response.json(await context.voiceService.getStatus(Boolean(context.configManager.get('ui.voiceEnabled')))),
    getVoiceProviders: async () => Response.json({
      providers: await context.voiceService.getStatus(Boolean(context.configManager.get('ui.voiceEnabled'))).then((status) => status.providers),
    }),
    getVoiceVoices: async (url) => Response.json({ voices: await context.voiceService.listVoices(url.searchParams.get('providerId') ?? undefined) }),
    postVoiceTts: async (request) => handleVoiceTts(context, request),
    postVoiceStt: async (request) => handleVoiceStt(context, request),
    postVoiceRealtimeSession: async (request) => handleVoiceRealtimeSession(context, request),
    getWebSearchProviders: async () => Response.json({ providers: await context.webSearchService.getStatus().then((status) => status.providers) }),
    postWebSearch: async (request) => handleWebSearch(context, request),
    getArtifacts: () => Response.json({ artifacts: context.artifactStore.list() }),
    postArtifact: async (request) => handleArtifactCreate(context, request),
    getArtifact: (artifactId) => {
      const artifact = context.artifactStore.get(artifactId);
      return artifact
        ? Response.json({ artifact })
        : Response.json({ error: 'Unknown artifact' }, { status: 404 });
    },
    getArtifactContent: async (artifactId, request) => handleArtifactContent(context, artifactId, request),
    getMediaProviders: async () => Response.json({ providers: await context.mediaProviders.status() }),
    postMediaAnalyze: async (request) => handleMediaAnalyze(context, request),
    postMediaTransform: async (request) => handleMediaTransform(context, request),
    postMediaGenerate: async (request) => handleMediaGenerate(context, request),
    getMultimodalStatus: async () => Response.json(await context.multimodalService.getStatus()),
    getMultimodalProviders: async () => Response.json({ providers: await context.multimodalService.listProviders() }),
    postMultimodalAnalyze: async (request) => handleMultimodalAnalyze(context, request),
    postMultimodalPacket: async (request) => handleMultimodalPacket(context, request),
    postMultimodalWriteback: async (request) => handleMultimodalWriteback(context, request),
  };
}

async function handleVoiceTts(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return Response.json({ error: 'Missing text' }, { status: 400 });
  try {
    const result = await context.voiceService.synthesize(
      typeof body.providerId === 'string' ? body.providerId : undefined,
      {
        text,
        voiceId: typeof body.voiceId === 'string' ? body.voiceId : undefined,
        modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
        format: typeof body.format === 'string' ? body.format : undefined,
        speed: typeof body.speed === 'number' ? body.speed : undefined,
        metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
      },
    );
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 });
  }
}

async function handleVoiceStt(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  if (typeof body.audio !== 'object' || body.audio === null) {
    return Response.json({ error: 'Missing audio artifact' }, { status: 400 });
  }
  try {
    const result = await context.voiceService.transcribe(
      typeof body.providerId === 'string' ? body.providerId : undefined,
      {
        audio: body.audio as VoiceAudioArtifact,
        language: typeof body.language === 'string' ? body.language : undefined,
        modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
        prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
        metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
      },
    );
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 });
  }
}

async function handleVoiceRealtimeSession(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  try {
    const result = await context.voiceService.openRealtimeSession(
      typeof body.providerId === 'string' ? body.providerId : undefined,
      {
        modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
        voiceId: typeof body.voiceId === 'string' ? body.voiceId : undefined,
        inputFormat: typeof body.inputFormat === 'string' ? body.inputFormat : undefined,
        outputFormat: typeof body.outputFormat === 'string' ? body.outputFormat : undefined,
        instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
        metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
      },
    );
    return Response.json(result, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 });
  }
}

async function handleMediaAnalyze(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const provider = context.mediaProviders.findProvider('understand', typeof body.providerId === 'string' ? body.providerId : undefined);
  if (!provider?.analyze) return Response.json({ error: 'No media analysis provider is registered' }, { status: 404 });
  const artifact = typeof body.artifact === 'object' && body.artifact !== null
    ? body.artifact as MediaArtifact
    : typeof body.artifactId === 'string' && body.artifactId.trim().length > 0
      ? {
          artifactId: body.artifactId.trim(),
          mimeType: 'application/octet-stream',
          metadata: {},
        } satisfies MediaArtifact
      : null;
  if (!artifact) {
    return Response.json({ error: 'Missing media artifact' }, { status: 400 });
  }
  return Response.json(await provider.analyze({
    artifact,
    prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
    modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
  }));
}

async function handleArtifactCreate(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const privateHostFetchOptions = resolvePrivateHostFetchOptions(body.allowPrivateHosts, {
    configManager: context.configManager,
    req,
    requireElevatedAccess: (request) => context.requireAdmin(request),
  });
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  try {
    const artifact = await context.artifactStore.create({
      ...(typeof body.kind === 'string' ? { kind: body.kind as ArtifactKind } : {}),
      ...(typeof body.mimeType === 'string' ? { mimeType: body.mimeType } : {}),
      ...(typeof body.filename === 'string' ? { filename: body.filename } : {}),
      ...(typeof body.dataBase64 === 'string' ? { dataBase64: body.dataBase64 } : {}),
      ...(typeof body.text === 'string' ? { text: body.text } : {}),
      ...(typeof body.path === 'string' ? { path: body.path } : {}),
      ...(typeof body.uri === 'string' ? { uri: body.uri } : {}),
      ...privateHostFetchOptions,
      ...(typeof body.retentionMs === 'number' ? { retentionMs: body.retentionMs } : {}),
      ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
    });
    return Response.json({ artifact }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

async function handleArtifactContent(context: DaemonMediaRouteContext, artifactId: string, req: Request): Promise<Response> {
  try {
    const { record, buffer } = await context.artifactStore.readContent(artifactId);
    const headers = new Headers({
      'Content-Type': record.mimeType,
      'Content-Length': String(buffer.length),
      'Cache-Control': 'private, max-age=60',
    });
    const download = new URL(req.url).searchParams.get('download');
    if (record.filename && download !== '0') {
      headers.set('Content-Disposition', `attachment; filename="${record.filename.replace(/"/g, '\\"')}"`);
    }
    return new Response(new Uint8Array(buffer), { status: 200, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 });
  }
}

async function handleWebSearch(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return Response.json({ error: 'Missing query' }, { status: 400 });
  try {
    return Response.json(await context.webSearchService.search({
      query,
      ...(typeof body.providerId === 'string' ? { providerId: body.providerId } : {}),
      ...(typeof body.maxResults === 'number' ? { maxResults: body.maxResults } : {}),
      ...(typeof body.verbosity === 'string' ? { verbosity: body.verbosity as WebSearchVerbosity } : {}),
      ...(typeof body.region === 'string' ? { region: body.region } : {}),
      ...(typeof body.safeSearch === 'string' ? { safeSearch: body.safeSearch as WebSearchSafeSearch } : {}),
      ...(typeof body.timeRange === 'string' ? { timeRange: body.timeRange as WebSearchTimeRange } : {}),
      ...(typeof body.includeInstantAnswer === 'boolean' ? { includeInstantAnswer: body.includeInstantAnswer } : {}),
      ...(typeof body.includeEvidence === 'boolean' ? { includeEvidence: body.includeEvidence } : {}),
      ...(typeof body.evidenceTopN === 'number' ? { evidenceTopN: body.evidenceTopN } : {}),
      ...(typeof body.evidenceExtract === 'string' ? { evidenceExtract: body.evidenceExtract as FetchExtractMode } : {}),
    }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

async function handleMediaTransform(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const provider = context.mediaProviders.findProvider('transform', typeof body.providerId === 'string' ? body.providerId : undefined);
  if (!provider?.transform) return Response.json({ error: 'No media transform provider is registered' }, { status: 404 });
  if (typeof body.artifact !== 'object' || body.artifact === null) {
    return Response.json({ error: 'Missing media artifact' }, { status: 400 });
  }
  const operation = typeof body.operation === 'string' ? body.operation : '';
  if (!operation) return Response.json({ error: 'Missing media transform operation' }, { status: 400 });
  return Response.json(await provider.transform({
    artifact: body.artifact as MediaArtifact,
    operation,
    outputMimeType: typeof body.outputMimeType === 'string' ? body.outputMimeType : undefined,
    options: typeof body.options === 'object' && body.options !== null ? body.options as Record<string, unknown> : {},
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
  }));
}

async function handleMediaGenerate(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const provider = context.mediaProviders.findProvider('generate', typeof body.providerId === 'string' ? body.providerId : undefined);
  if (!provider?.generate) return Response.json({ error: 'No media generation provider is registered' }, { status: 404 });
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim()) return Response.json({ error: 'Missing media generation prompt' }, { status: 400 });
  return Response.json(await provider.generate({
    prompt,
    outputMimeType: typeof body.outputMimeType === 'string' ? body.outputMimeType : undefined,
    modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
    options: typeof body.options === 'object' && body.options !== null ? body.options as Record<string, unknown> : {},
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
  }));
}

async function handleMultimodalAnalyze(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const requestedArtifact = typeof body.artifact === 'object' && body.artifact !== null
    ? body.artifact as Record<string, unknown>
    : null;
  const privateHostFetchOptions = resolvePrivateHostFetchOptions(
    body.allowPrivateHosts === true || requestedArtifact?.allowPrivateHosts === true,
    {
      configManager: context.configManager,
      req,
      requireElevatedAccess: (request) => context.requireAdmin(request),
    },
  );
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  try {
    const analysis = await context.multimodalService.analyze({
      ...(typeof body.artifactId === 'string' ? { artifactId: body.artifactId } : {}),
      ...(requestedArtifact ? {
        artifact: {
          ...(requestedArtifact as MultimodalAnalysisRequest['artifact']),
          ...privateHostFetchOptions,
        },
      } : {}),
      ...(typeof body.prompt === 'string' ? { prompt: body.prompt } : {}),
      ...(typeof body.imageProviderId === 'string' ? { imageProviderId: body.imageProviderId } : {}),
      ...(typeof body.audioProviderId === 'string' ? { audioProviderId: body.audioProviderId } : {}),
      ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {}),
      ...(typeof body.language === 'string' ? { language: body.language } : {}),
      ...(typeof body.detail === 'string' ? { detail: body.detail as MultimodalDetail } : {}),
      ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
    });
    const includePacket = body.includePacket === true;
    const writeback = body.writeback === true || (typeof body.writeback === 'object' && body.writeback !== null);
    const writebackBody = typeof body.writeback === 'object' && body.writeback !== null
      ? body.writeback as Record<string, unknown>
      : null;
    const packet = includePacket
      ? context.multimodalService.buildPacket(
          analysis,
          typeof body.detail === 'string' ? body.detail as MultimodalDetail : 'standard',
        )
      : undefined;
    const writebackResult = writeback
      ? await context.multimodalService.writeBackAnalysis(analysis, {
          ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
          ...(typeof writebackBody?.title === 'string' ? { title: writebackBody.title } : {}),
          ...(Array.isArray(writebackBody?.tags) ? { tags: writebackBody.tags.filter((entry): entry is string => typeof entry === 'string') } : {}),
          ...(typeof writebackBody?.folderPath === 'string' ? { folderPath: writebackBody.folderPath } : {}),
          ...(typeof writebackBody?.metadata === 'object' && writebackBody.metadata !== null ? { metadata: writebackBody.metadata as Record<string, unknown> } : {}),
        })
      : undefined;
    return Response.json({
      analysis,
      ...(packet ? { packet } : {}),
      ...(writebackResult ? { writeback: writebackResult } : {}),
    }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

async function handleMultimodalPacket(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  if (typeof body.analysis !== 'object' || body.analysis === null) {
    return Response.json({ error: 'Missing analysis payload' }, { status: 400 });
  }
  const detail = typeof body.detail === 'string' ? body.detail as MultimodalDetail : 'standard';
  const budgetLimit = typeof body.budgetLimit === 'number' ? body.budgetLimit : undefined;
  return Response.json({
    packet: context.multimodalService.buildPacket(
      body.analysis as MultimodalAnalysisResult,
      detail,
      budgetLimit,
    ),
  });
}

async function handleMultimodalWriteback(context: DaemonMediaRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  if (typeof body.analysis !== 'object' || body.analysis === null) {
    return Response.json({ error: 'Missing analysis payload' }, { status: 400 });
  }
  try {
    const writeback = await context.multimodalService.writeBackAnalysis(
      body.analysis as MultimodalAnalysisResult,
      {
        ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(Array.isArray(body.tags) ? { tags: body.tags.filter((entry): entry is string => typeof entry === 'string') } : {}),
        ...(typeof body.folderPath === 'string' ? { folderPath: body.folderPath } : {}),
        ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
      },
    );
    return Response.json({ writeback }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
