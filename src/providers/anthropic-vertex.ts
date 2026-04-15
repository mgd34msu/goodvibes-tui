import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { AnthropicSdkProvider } from '@pellux/goodvibes-sdk/platform/providers/anthropic-sdk-provider';

const VERTEX_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-haiku-4-5',
];

function resolveVertexProjectId(): string | null {
  return process.env['ANTHROPIC_VERTEX_PROJECT_ID']
    ?? process.env['GOOGLE_CLOUD_PROJECT']
    ?? process.env['GOOGLE_CLOUD_PROJECT_ID']
    ?? null;
}

function hasVertexCredentials(): boolean {
  return Boolean(
    resolveVertexProjectId()
    && (process.env['GOOGLE_APPLICATION_CREDENTIALS'] || process.env['ANTHROPIC_VERTEX_USE_GCP_METADATA'] === '1'),
  );
}

export class AnthropicVertexProvider extends AnthropicSdkProvider {
  constructor() {
    const configured = hasVertexCredentials();
    super({
      name: 'anthropic-vertex',
      label: 'Anthropic Vertex',
      defaultModel: 'claude-sonnet-4-6',
      models: VERTEX_MODELS,
      createClient: () => new AnthropicVertex({
        projectId: resolveVertexProjectId(),
        region: process.env['GOOGLE_CLOUD_LOCATION'] ?? process.env['CLOUD_ML_REGION'] ?? 'global',
      }),
      auth: {
        mode: configured ? 'api-key' : 'anonymous',
        configured,
        detail: configured
          ? 'Google Cloud Vertex credentials are available for Anthropic Vertex.'
          : 'Configure project ID plus GOOGLE_APPLICATION_CREDENTIALS or metadata-based auth for Anthropic Vertex.',
        envVars: [
          'ANTHROPIC_VERTEX_PROJECT_ID',
          'GOOGLE_CLOUD_PROJECT',
          'GOOGLE_CLOUD_PROJECT_ID',
          'GOOGLE_CLOUD_LOCATION',
          'CLOUD_ML_REGION',
          'GOOGLE_APPLICATION_CREDENTIALS',
          'ANTHROPIC_VERTEX_USE_GCP_METADATA',
        ],
        allowAnonymous: true,
        anonymousConfigured: Boolean(resolveVertexProjectId()),
        anonymousDetail: 'Anthropic Vertex can use Google ADC or workload identity without a stored API key.',
      },
      streamProtocol: 'anthropic-sdk-stream',
      notes: ['Anthropic Vertex is backed by Google ADC / Vertex auth rather than a provider API key.'],
    });
  }
}
