import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChatRequest, ChatResponse, LLMProvider, ProviderRuntimeMetadata, ProviderRuntimeMetadataDeps } from './interface.ts';
import { OpenAICompatProvider } from './openai-compat.ts';
import { AnthropicCompatProvider } from './anthropic-compat.ts';
import { ProviderError } from '../types/errors.ts';
import { buildStandardProviderAuthRoutes } from './runtime-metadata.ts';
import { toProviderError } from '../utils/error-display.ts';

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const DEFAULT_COPILOT_API_BASE_URL = 'https://api.individual.githubcopilot.com';
const COPILOT_EDITOR_VERSION = 'vscode/1.96.2';
const COPILOT_USER_AGENT = 'GitHubCopilotChat/0.26.7';
const COPILOT_GITHUB_API_VERSION = '2025-04-01';
const COPILOT_TOKEN_ENV_VARS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

interface CachedCopilotToken {
  readonly token: string;
  readonly expiresAt: number;
  readonly updatedAt: number;
}

export interface GitHubCopilotProviderOptions {
  readonly tokenCachePath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchFn?: typeof fetch;
}

export function getGitHubCopilotTokenCachePath(cacheDir: string): string {
  return join(cacheDir, 'credentials', 'github-copilot.token.json');
}

function readFirstEnv(envVars: readonly string[], env: NodeJS.ProcessEnv): string | null {
  for (const envVar of envVars) {
    const value = env[envVar];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function buildCopilotIdeHeaders(includeApiVersion = false): Record<string, string> {
  return {
    'Editor-Version': COPILOT_EDITOR_VERSION,
    'User-Agent': COPILOT_USER_AGENT,
    ...(includeApiVersion ? { 'X-Github-Api-Version': COPILOT_GITHUB_API_VERSION } : {}),
  };
}

function hasCopilotVisionInput(messages: ChatRequest['messages']): boolean {
  return messages.some((message) =>
    Array.isArray(message.content) && message.content.some((part) => part.type === 'image'));
}

function buildCopilotDynamicHeaders(messages: ChatRequest['messages']): Record<string, string> {
  const last = messages[messages.length - 1];
  const initiator = last && last.role !== 'user' ? 'agent' : 'user';
  return {
    ...buildCopilotIdeHeaders(false),
    'X-Initiator': initiator,
    'Openai-Intent': 'conversation-edits',
    ...(hasCopilotVisionInput(messages) ? { 'Copilot-Vision-Request': 'true' } : {}),
  };
}

function isTokenUsable(cache: CachedCopilotToken, now = Date.now()): boolean {
  return cache.expiresAt - now > 5 * 60 * 1000;
}

function parseCopilotTokenResponse(value: unknown): { token: string; expiresAt: number } {
  if (!value || typeof value !== 'object') {
    throw new Error('Unexpected response from GitHub Copilot token endpoint');
  }
  const record = value as Record<string, unknown>;
  const token = typeof record['token'] === 'string' ? record['token'].trim() : '';
  const rawExpiresAt = record['expires_at'];
  if (!token) throw new Error('Copilot token response missing token');
  let expiresAt: number;
  if (typeof rawExpiresAt === 'number' && Number.isFinite(rawExpiresAt)) {
    expiresAt = rawExpiresAt < 100_000_000_000 ? rawExpiresAt * 1000 : rawExpiresAt;
  } else if (typeof rawExpiresAt === 'string' && rawExpiresAt.trim()) {
    const parsed = Number.parseInt(rawExpiresAt.trim(), 10);
    if (!Number.isFinite(parsed)) throw new Error('Copilot token response has invalid expires_at');
    expiresAt = parsed < 100_000_000_000 ? parsed * 1000 : parsed;
  } else {
    throw new Error('Copilot token response missing expires_at');
  }
  return { token, expiresAt };
}

function deriveCopilotApiBaseUrlFromToken(token: string): string | null {
  const match = token.trim().match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  const proxyEp = match?.[1]?.trim();
  if (!proxyEp) return null;
  const candidate = /^https?:\/\//i.test(proxyEp) ? proxyEp : `https://${proxyEp}`;
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.replace(/^proxy\./i, 'api.');
    return `https://${host}`;
  } catch {
    return null;
  }
}

async function resolveCopilotToken(options: GitHubCopilotProviderOptions): Promise<{ token: string; baseUrl: string; expiresAt: number }> {
  const env = options.env ?? process.env;
  const fetchFn = options.fetchFn ?? fetch;
  const githubToken = readFirstEnv(COPILOT_TOKEN_ENV_VARS, env);
  if (!githubToken) {
    throw new Error('GitHub Copilot requires COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN.');
  }

  const cachePath = options.tokenCachePath;
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as CachedCopilotToken;
      if (cached?.token && typeof cached.expiresAt === 'number' && isTokenUsable(cached)) {
        return {
          token: cached.token,
          baseUrl: deriveCopilotApiBaseUrlFromToken(cached.token) ?? DEFAULT_COPILOT_API_BASE_URL,
          expiresAt: cached.expiresAt,
        };
      }
    } catch {
      // Ignore stale or malformed cache files.
    }
  }

  const response = await fetchFn(COPILOT_TOKEN_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${githubToken}`,
      ...buildCopilotIdeHeaders(true),
    },
  });
  if (!response.ok) {
    throw new Error(`Copilot token exchange failed: HTTP ${response.status}`);
  }
  const parsed = parseCopilotTokenResponse(await response.json());
  const cachePayload: CachedCopilotToken = {
    token: parsed.token,
    expiresAt: parsed.expiresAt,
    updatedAt: Date.now(),
  };
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cachePayload, null, 2));
  return {
    token: parsed.token,
    baseUrl: deriveCopilotApiBaseUrlFromToken(parsed.token) ?? DEFAULT_COPILOT_API_BASE_URL,
    expiresAt: parsed.expiresAt,
  };
}

function usesAnthropicTransport(model: string): boolean {
  return model.trim().toLowerCase().includes('claude');
}

export class GitHubCopilotProvider implements LLMProvider {
  readonly name = 'github-copilot';
  readonly models = [
    'claude-sonnet-4.6',
    'claude-sonnet-4.5',
    'gpt-4o',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'gpt-5.4',
    'o1',
    'o1-mini',
    'o3-mini',
  ];

  constructor(private readonly options: GitHubCopilotProviderOptions) {}

  async chat(params: ChatRequest): Promise<ChatResponse> {
    try {
      const model = params.model ?? this.models[0]!;
      const session = await resolveCopilotToken(this.options);
      const baseURL = `${session.baseUrl.replace(/\/+$/, '')}/v1`;
      const defaultHeaders = buildCopilotDynamicHeaders(params.messages);
      if (usesAnthropicTransport(model)) {
        const provider = new AnthropicCompatProvider({
          name: this.name,
          baseURL,
          apiKey: session.token,
          defaultModel: model,
          models: this.models,
          defaultHeaders,
          authEnvVars: COPILOT_TOKEN_ENV_VARS,
          serviceNames: ['github-copilot'],
          authHeaderMode: 'bearer',
          streamProtocol: 'anthropic-sse',
        });
        return provider.chat({ ...params, model });
      }

      const provider = new OpenAICompatProvider({
        name: this.name,
        baseURL,
        apiKey: session.token,
        defaultModel: model,
        models: this.models,
        defaultHeaders,
        authEnvVars: COPILOT_TOKEN_ENV_VARS,
        serviceNames: ['github-copilot'],
        aliases: ['copilot'],
        streamProtocol: 'openai-sse',
      });
      return provider.chat({ ...params, model });
    } catch (error) {
      throw toProviderError(error, {
        provider: this.name,
        operation: 'chat',
      });
    }
  }

  async describeRuntime(deps: ProviderRuntimeMetadataDeps): Promise<ProviderRuntimeMetadata> {
    const configured = readFirstEnv(COPILOT_TOKEN_ENV_VARS, this.options.env ?? process.env) !== null;
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: this.name,
      apiKeyEnvVars: COPILOT_TOKEN_ENV_VARS,
      secretKeys: COPILOT_TOKEN_ENV_VARS,
      serviceNames: ['github-copilot'],
    }, deps);
    return {
      auth: {
        mode: 'api-key',
        configured,
        detail: configured
          ? 'GitHub token is available for Copilot token exchange.'
          : 'Set COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN to use GitHub Copilot.',
        envVars: COPILOT_TOKEN_ENV_VARS,
        routes: authRoutes,
      },
      models: {
        defaultModel: this.models[0],
        models: this.models,
        aliases: ['copilot'],
      },
      usage: {
        streaming: true,
        toolCalling: true,
        parallelTools: true,
        notes: ['Claude-family Copilot models use Anthropic transport. Other models use the OpenAI-compatible Copilot endpoint.'],
      },
      policy: {
        local: false,
        streamProtocol: 'mixed:anthropic+openai',
        reasoningMode: 'provider-managed',
      },
    };
  }
}
