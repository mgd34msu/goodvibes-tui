import type {
  MediaArtifact,
  MediaGenerationRequest,
  MediaGenerationResult,
  MediaProvider,
  MediaProviderStatus,
} from './provider-registry.ts';

function readFirstEnv(envVars: readonly string[]): string | null {
  for (const envVar of envVars) {
    const value = process.env[envVar];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function buildStatus(
  id: string,
  label: string,
  configured: boolean,
  detail: string,
): MediaProviderStatus {
  return {
    id,
    label,
    state: configured ? 'healthy' : 'unconfigured',
    capabilities: ['generate'],
    configured,
    detail,
    metadata: {},
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function trimString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toDataUrl(artifact: MediaArtifact): string | undefined {
  if (artifact.uri?.trim()) return artifact.uri.trim();
  if (artifact.dataBase64?.trim()) {
    return `data:${artifact.mimeType || 'application/octet-stream'};base64,${artifact.dataBase64.trim()}`;
  }
  return undefined;
}

function resolveReferenceArtifact(request: MediaGenerationRequest): MediaArtifact | null {
  const options = asRecord(request.options);
  const candidate = asRecord(options?.['referenceArtifact']) ?? asRecord(options?.['sourceArtifact']);
  if (!candidate) return null;
  const mimeType = trimString(candidate['mimeType']) ?? 'application/octet-stream';
  return {
    mimeType,
    ...(trimString(candidate['dataBase64']) ? { dataBase64: trimString(candidate['dataBase64']) } : {}),
    ...(trimString(candidate['uri']) ? { uri: trimString(candidate['uri']) } : {}),
    ...(trimString(candidate['filename']) ? { filename: trimString(candidate['filename']) } : {}),
    metadata: asRecord(candidate['metadata']) ?? {},
  };
}

function resolveReferenceUrl(request: MediaGenerationRequest): string | undefined {
  const options = asRecord(request.options);
  const direct = trimString(options?.['referenceUrl']) ?? trimString(options?.['imageUrl']) ?? trimString(options?.['videoUrl']);
  if (direct) return direct;
  const artifact = resolveReferenceArtifact(request);
  return artifact ? toDataUrl(artifact) : undefined;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 120_000): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Request failed (${response.status}) ${url}: ${text || response.statusText}`);
  }
  return response.json();
}

async function fetchResponse(url: string, init: RequestInit, timeoutMs = 120_000): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Request failed (${response.status}) ${url}: ${text || response.statusText}`);
  }
  return response;
}

function buildArtifactFromRemote(
  url: string,
  mimeType = 'application/octet-stream',
  filename?: string,
): MediaArtifact {
  return {
    uri: url,
    mimeType,
    ...(filename ? { filename } : {}),
    metadata: { sourceUrl: url },
  };
}

async function maybeInlineArtifact(
  url: string,
  fallbackMimeType: string,
  filename?: string,
  maxInlineBytes = 5_000_000,
): Promise<MediaArtifact> {
  const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20_000) }).catch(() => null);
  const contentLength = Number.parseInt(head?.headers.get('content-length') ?? '', 10);
  const contentType = head?.headers.get('content-type')?.trim() || fallbackMimeType;
  if (Number.isFinite(contentLength) && contentLength > maxInlineBytes) {
    return buildArtifactFromRemote(url, contentType, filename);
  }
  const response = await fetchResponse(url, { method: 'GET' }, 120_000);
  const buffer = Buffer.from(await response.arrayBuffer());
  const mimeType = response.headers.get('content-type')?.trim() || contentType;
  if (buffer.length > maxInlineBytes) {
    return buildArtifactFromRemote(url, mimeType, filename);
  }
  return {
    uri: url,
    mimeType,
    ...(filename ? { filename } : {}),
    dataBase64: buffer.toString('base64'),
    sizeBytes: buffer.length,
    metadata: { sourceUrl: url },
  };
}

function inferVideoArtifact(url: string): Promise<MediaArtifact> {
  return maybeInlineArtifact(url, 'video/mp4', 'video.mp4', 1_500_000);
}

function inferImageArtifact(url: string): Promise<MediaArtifact> {
  return maybeInlineArtifact(url, 'image/png', 'image.png', 5_000_000);
}

function createByteplusProvider(): MediaProvider {
  const envVars = ['BYTEPLUS_API_KEY'] as const;
  const defaultModel = 'seedance-1-0-lite-t2v-250428';
  const defaultBaseUrl = 'https://ark.ap-southeast.bytepluses.com/api/v3';
  return {
    id: 'byteplus',
    label: 'BytePlus',
    capabilities: ['generate'],
    status() {
      const configured = readFirstEnv(envVars) !== null;
      return buildStatus('byteplus', 'BytePlus', configured, configured
        ? 'BytePlus video generation key available.'
        : 'Set BYTEPLUS_API_KEY to enable BytePlus video generation.');
    },
    async generate(request: MediaGenerationRequest): Promise<MediaGenerationResult> {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('BytePlus API key missing');
      const options = asRecord(request.options) ?? {};
      const model = trimString(request.modelId) ?? trimString(options['model']) ?? defaultModel;
      const baseUrl = trimString(options['baseUrl']) ?? defaultBaseUrl;
      const referenceUrl = resolveReferenceUrl(request);
      const content: Array<Record<string, unknown>> = [{ type: 'text', text: request.prompt }];
      if (referenceUrl) {
        content.push({
          type: 'image_url',
          image_url: { url: referenceUrl },
          role: 'first_frame',
        });
      }
      const submitted = await fetchJson(`${baseUrl}/contents/generations/tasks`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          content,
          ...(trimString(options['aspectRatio']) ? { ratio: trimString(options['aspectRatio']) } : {}),
          ...(trimString(options['resolution']) ? { resolution: trimString(options['resolution']) } : {}),
          ...(asNumber(options['durationSeconds']) != null ? { duration: Math.max(1, Math.round(asNumber(options['durationSeconds'])!)) } : {}),
          ...(asBool(options['audio']) != null ? { generate_audio: asBool(options['audio']) } : {}),
          ...(asBool(options['watermark']) != null ? { watermark: asBool(options['watermark']) } : {}),
        }),
      }) as { id?: string };
      const taskId = trimString(submitted.id);
      if (!taskId) throw new Error('BytePlus response missing task id');
      let completed: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const payload = await fetchJson(`${baseUrl}/contents/generations/tasks/${taskId}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
        }, 60_000) as Record<string, unknown>;
        const status = trimString(payload['status'])?.toLowerCase();
        if (status === 'succeeded') {
          completed = payload;
          break;
        }
        if (status === 'failed' || status === 'cancelled') {
          const error = asRecord(payload['error']);
          throw new Error(trimString(error?.['message']) ?? 'BytePlus generation failed');
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      if (!completed) throw new Error('BytePlus generation timed out');
      const contentRecord = asRecord(completed['content']);
      const videoUrl = trimString(contentRecord?.['video_url']) ?? trimString(contentRecord?.['file_url']);
      if (!videoUrl) throw new Error('BytePlus generation completed without a video URL');
      return {
        providerId: 'byteplus',
        artifacts: [await inferVideoArtifact(videoUrl)],
        metadata: {
          taskId,
          model,
        },
      };
    },
  };
}

function createRunwayProvider(): MediaProvider {
  const envVars = ['RUNWAYML_API_SECRET', 'RUNWAY_API_KEY'] as const;
  const defaultBaseUrl = 'https://api.dev.runwayml.com';
  const defaultModel = 'gen4.5';
  return {
    id: 'runway',
    label: 'Runway',
    capabilities: ['generate'],
    status() {
      const configured = readFirstEnv(envVars) !== null;
      return buildStatus('runway', 'Runway', configured, configured
        ? 'Runway API key available.'
        : 'Set RUNWAYML_API_SECRET or RUNWAY_API_KEY to enable Runway generation.');
    },
    async generate(request: MediaGenerationRequest): Promise<MediaGenerationResult> {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('Runway API key missing');
      const options = asRecord(request.options) ?? {};
      const baseUrl = trimString(options['baseUrl']) ?? defaultBaseUrl;
      const model = trimString(request.modelId) ?? trimString(options['model']) ?? defaultModel;
      const referenceArtifact = resolveReferenceArtifact(request);
      const endpoint = referenceArtifact
        ? referenceArtifact.mimeType.startsWith('video/') ? '/v1/video_to_video' : '/v1/image_to_video'
        : '/v1/text_to_video';
      const body: Record<string, unknown> = {
        model,
        promptText: request.prompt,
        ratio: trimString(options['size']) ?? trimString(options['aspectRatio']) ?? '1280:720',
        ...(asNumber(options['durationSeconds']) != null ? { duration: Math.max(2, Math.round(asNumber(options['durationSeconds'])!)) } : { duration: 5 }),
      };
      const referenceUrl = resolveReferenceUrl(request);
      if (endpoint === '/v1/image_to_video' && referenceUrl) body['promptImage'] = referenceUrl;
      if (endpoint === '/v1/video_to_video' && referenceUrl) body['videoUri'] = referenceUrl;
      const submitted = await fetchJson(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Runway-Version': '2024-11-06',
        },
        body: JSON.stringify(body),
      }) as { id?: string };
      const taskId = trimString(submitted.id);
      if (!taskId) throw new Error('Runway response missing task id');
      let completed: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const payload = await fetchJson(`${baseUrl}/v1/tasks/${taskId}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'X-Runway-Version': '2024-11-06',
          },
        }, 60_000) as Record<string, unknown>;
        const status = trimString(payload['status'])?.toUpperCase();
        if (status === 'SUCCEEDED') {
          completed = payload;
          break;
        }
        if (status === 'FAILED' || status === 'CANCELLED') {
          throw new Error(trimString(payload['failure']) ?? 'Runway generation failed');
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      if (!completed) throw new Error('Runway generation timed out');
      const outputs = Array.isArray(completed['output'])
        ? (completed['output'] as unknown[]).filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : [];
      if (outputs.length === 0) throw new Error('Runway generation completed without output URLs');
      return {
        providerId: 'runway',
        artifacts: await Promise.all(outputs.map((url) => inferVideoArtifact(url))),
        metadata: { taskId, model },
      };
    },
  };
}

function createAlibabaProvider(): MediaProvider {
  const envVars = ['MODELSTUDIO_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY'] as const;
  const defaultBaseUrl = 'https://dashscope-intl.aliyuncs.com';
  const defaultModel = 'wan2.6-t2v';
  return {
    id: 'alibaba',
    label: 'Alibaba Model Studio',
    capabilities: ['generate'],
    status() {
      const configured = readFirstEnv(envVars) !== null;
      return buildStatus('alibaba', 'Alibaba Model Studio', configured, configured
        ? 'Alibaba video generation key available.'
        : 'Set MODELSTUDIO_API_KEY, DASHSCOPE_API_KEY, or QWEN_API_KEY to enable Alibaba generation.');
    },
    async generate(request: MediaGenerationRequest): Promise<MediaGenerationResult> {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('Alibaba API key missing');
      const options = asRecord(request.options) ?? {};
      const baseUrl = trimString(options['baseUrl']) ?? defaultBaseUrl;
      const model = trimString(request.modelId) ?? trimString(options['model']) ?? defaultModel;
      const referenceUrl = resolveReferenceUrl(request);
      const submitted = await fetchJson(`${baseUrl.replace(/\/+$/, '')}/api/v1/services/aigc/video-generation/video-synthesis`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable',
        },
        body: JSON.stringify({
          model,
          input: {
            prompt: request.prompt,
            ...(referenceUrl ? { img_url: referenceUrl } : {}),
          },
          parameters: {
            ...(trimString(options['size']) ? { size: trimString(options['size']) } : {}),
            ...(trimString(options['aspectRatio']) ? { aspect_ratio: trimString(options['aspectRatio']) } : {}),
            ...(asNumber(options['durationSeconds']) != null ? { duration: Math.max(1, Math.round(asNumber(options['durationSeconds'])!)) } : {}),
            ...(asBool(options['audio']) != null ? { enable_audio: asBool(options['audio']) } : {}),
            ...(asBool(options['watermark']) != null ? { watermark: asBool(options['watermark']) } : {}),
          },
        }),
      }) as { output?: { task_id?: string } };
      const taskId = trimString(asRecord(submitted.output)?.['task_id']);
      if (!taskId) throw new Error('Alibaba response missing task id');
      let completed: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const payload = await fetchJson(`${baseUrl.replace(/\/+$/, '')}/api/v1/tasks/${taskId}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
        }, 60_000) as Record<string, unknown>;
        const output = asRecord(payload['output']);
        const status = trimString(output?.['task_status'])?.toUpperCase();
        if (status === 'SUCCEEDED') {
          completed = payload;
          break;
        }
        if (status === 'FAILED' || status === 'CANCELED') {
          throw new Error(trimString(output?.['message']) ?? 'Alibaba generation failed');
        }
        await new Promise((resolve) => setTimeout(resolve, 2_500));
      }
      if (!completed) throw new Error('Alibaba generation timed out');
      const output = asRecord(completed['output']);
      const results = Array.isArray(output?.['results']) ? output?.['results'] as Array<Record<string, unknown>> : [];
      const urls = [
        ...results.map((entry) => trimString(entry['video_url'])).filter((entry): entry is string => Boolean(entry)),
        trimString(output?.['video_url']),
      ].filter((entry): entry is string => Boolean(entry));
      if (urls.length === 0) throw new Error('Alibaba generation completed without a video URL');
      return {
        providerId: 'alibaba',
        artifacts: await Promise.all(urls.map((url) => inferVideoArtifact(url))),
        metadata: { taskId, model },
      };
    },
  };
}

function createFalProvider(): MediaProvider {
  const envVars = ['FAL_KEY', 'FAL_API_KEY'] as const;
  const defaultBaseUrl = 'https://fal.run';
  const defaultModel = 'fal-ai/minimax/video-01-live';
  return {
    id: 'fal',
    label: 'fal',
    capabilities: ['generate'],
    status() {
      const configured = readFirstEnv(envVars) !== null;
      return buildStatus('fal', 'fal', configured, configured
        ? 'fal API key available.'
        : 'Set FAL_KEY or FAL_API_KEY to enable fal generation.');
    },
    async generate(request: MediaGenerationRequest): Promise<MediaGenerationResult> {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('fal API key missing');
      const options = asRecord(request.options) ?? {};
      const baseUrl = trimString(options['baseUrl']) ?? defaultBaseUrl;
      const model = trimString(request.modelId) ?? trimString(options['model']) ?? defaultModel;
      const isImage = (request.outputMimeType?.startsWith('image/') ?? false) || asBool(options['image']) === true;
      const path = trimString(options['path']) ?? (isImage ? 'fal-ai/flux/dev' : model);
      const queueBase = baseUrl.replace('://fal.run', '://queue.fal.run');
      const submitted = await fetchJson(`${queueBase.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`, {
        method: 'POST',
        headers: {
          Authorization: `Key ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: request.prompt,
          ...(resolveReferenceUrl(request) ? { image_url: resolveReferenceUrl(request) } : {}),
          ...(trimString(options['aspectRatio']) ? { aspect_ratio: trimString(options['aspectRatio']) } : {}),
          ...(trimString(options['size']) ? { size: trimString(options['size']) } : {}),
          ...(trimString(options['resolution']) ? { resolution: trimString(options['resolution']) } : {}),
          ...(asNumber(options['durationSeconds']) != null ? { duration: Math.max(1, Math.round(asNumber(options['durationSeconds'])!)) } : {}),
        }),
      }, 60_000) as Record<string, unknown>;
      const statusUrl = trimString(submitted['status_url']);
      const responseUrl = trimString(submitted['response_url']);
      if (!statusUrl || !responseUrl) throw new Error('fal response missing queue URLs');
      let completed: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const payload = await fetchJson(statusUrl, {
          method: 'GET',
          headers: { Authorization: `Key ${apiKey}` },
        }, 60_000) as Record<string, unknown>;
        const status = trimString(payload['status'])?.toUpperCase();
        if (status === 'COMPLETED') {
          completed = await fetchJson(responseUrl, {
            method: 'GET',
            headers: { Authorization: `Key ${apiKey}` },
          }, 60_000) as Record<string, unknown>;
          break;
        }
        if (status === 'FAILED' || status === 'CANCELLED') {
          throw new Error(trimString(payload['detail']) ?? trimString(asRecord(payload['error'])?.['message']) ?? 'fal generation failed');
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      if (!completed) throw new Error('fal generation timed out');
      const videoUrl = trimString(asRecord(completed['video'])?.['url'])
        ?? trimString(asRecord((Array.isArray(completed['videos']) ? (completed['videos'] as Array<Record<string, unknown>>)[0] : null))?.['url']);
      const imageUrl = trimString(asRecord(completed['image'])?.['url'])
        ?? trimString(asRecord((Array.isArray(completed['images']) ? (completed['images'] as Array<Record<string, unknown>>)[0] : null))?.['url']);
      const finalUrl = isImage ? imageUrl ?? videoUrl : videoUrl ?? imageUrl;
      if (!finalUrl) throw new Error('fal generation completed without an output URL');
      return {
        providerId: 'fal',
        artifacts: [isImage ? await inferImageArtifact(finalUrl) : await inferVideoArtifact(finalUrl)],
        metadata: { model: path },
      };
    },
  };
}

function createComfyProvider(): MediaProvider {
  const envVars = ['COMFY_API_KEY'] as const;
  return {
    id: 'comfy',
    label: 'Comfy',
    capabilities: ['generate'],
    status() {
      const configured = Boolean(trimString(process.env['COMFY_BASE_URL']) || readFirstEnv(envVars));
      return buildStatus(
        'comfy',
        'Comfy',
        configured,
        'Comfy expects COMFY_BASE_URL plus options.workflow or options.workflowPath; COMFY_API_KEY is optional for cloud deployments.',
      );
    },
    async generate(request: MediaGenerationRequest): Promise<MediaGenerationResult> {
      const options = asRecord(request.options) ?? {};
      const baseUrl = trimString(options['baseUrl']) ?? trimString(process.env['COMFY_BASE_URL']) ?? 'http://127.0.0.1:8188';
      const apiKey = readFirstEnv(envVars);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['x-api-key'] = apiKey;
      const workflowInline = asRecord(options['workflow']);
      let workflow = workflowInline;
      if (!workflow) {
        const workflowPath = trimString(options['workflowPath']);
        if (!workflowPath) throw new Error('Comfy generation requires options.workflow or options.workflowPath.');
        const { readFileSync } = await import('node:fs');
        workflow = JSON.parse(readFileSync(workflowPath, 'utf-8')) as Record<string, unknown>;
      }
      const reference = resolveReferenceArtifact(request);
      if (reference && trimString(options['inputImageNodeId']) && reference.dataBase64) {
        const inputImageNodeId = trimString(options['inputImageNodeId'])!;
        const node = asRecord(workflow[inputImageNodeId]);
        const inputs = asRecord(node?.['inputs']);
        if (inputs) {
          inputs['image'] = `data:${reference.mimeType};base64,${reference.dataBase64}`;
        }
      }
      const endpoint = baseUrl.includes('cloud.comfy.org') ? '/api/prompt' : '/prompt';
      const submitted = await fetchJson(`${baseUrl.replace(/\/+$/, '')}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt: workflow,
          ...(apiKey && baseUrl.includes('cloud.comfy.org') ? { extra_data: { api_key_comfy_org: apiKey } } : {}),
        }),
      }) as Record<string, unknown>;
      const taskId = trimString(submitted['prompt_id']) ?? trimString(submitted['id']);
      if (!taskId) throw new Error('Comfy response missing task id');
      let outputs: Array<Record<string, unknown>> = [];
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const historyPath = baseUrl.includes('cloud.comfy.org') ? `/api/history_v2/${taskId}` : `/history/${taskId}`;
        const payload = await fetchJson(`${baseUrl.replace(/\/+$/, '')}${historyPath}`, {
          method: 'GET',
          headers: apiKey ? { 'x-api-key': apiKey } : undefined,
        }, 60_000) as Record<string, unknown>;
        if (baseUrl.includes('cloud.comfy.org')) {
          const records = Array.isArray(payload['outputs']) ? payload['outputs'] as Array<Record<string, unknown>> : [];
          if (records.length > 0) {
            outputs = records;
            break;
          }
        } else {
          const record = asRecord(payload[taskId]);
          const outputRecord = asRecord(record?.['outputs']);
          const flattened = outputRecord
            ? Object.values(outputRecord).flatMap((value) => Array.isArray(asRecord(value)?.['images']) ? (asRecord(value)?.['images'] as unknown[]) : [])
            : [];
          if (flattened.length > 0) {
            outputs = flattened.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null) as Array<Record<string, unknown>>;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      if (outputs.length === 0) throw new Error('Comfy generation timed out');
      const artifacts: MediaArtifact[] = [];
      for (const entry of outputs) {
        const remoteUrl = trimString(entry['url']);
        if (remoteUrl) {
          artifacts.push((request.outputMimeType?.startsWith('video/') ?? false) ? await inferVideoArtifact(remoteUrl) : await inferImageArtifact(remoteUrl));
          continue;
        }
        const filename = trimString(entry['filename']);
        if (!filename) continue;
        const viewPath = baseUrl.includes('cloud.comfy.org')
          ? `/api/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(trimString(entry['subfolder']) ?? '')}&type=${encodeURIComponent(trimString(entry['type']) ?? 'output')}`
          : `/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(trimString(entry['subfolder']) ?? '')}&type=${encodeURIComponent(trimString(entry['type']) ?? 'output')}`;
        const remote = `${baseUrl.replace(/\/+$/, '')}${viewPath}`;
        artifacts.push((request.outputMimeType?.startsWith('video/') ?? false) ? await inferVideoArtifact(remote) : await inferImageArtifact(remote));
      }
      if (artifacts.length === 0) throw new Error('Comfy generation completed without downloadable artifacts');
      return {
        providerId: 'comfy',
        artifacts,
        metadata: { taskId },
      };
    },
  };
}

export function builtinGenerationProviders(): readonly MediaProvider[] {
  return [
    createByteplusProvider(),
    createRunwayProvider(),
    createAlibabaProvider(),
    createFalProvider(),
    createComfyProvider(),
  ];
}
