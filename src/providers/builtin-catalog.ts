import type { OpenAICompatOptions } from './openai-compat.ts';
import type { AnthropicCompatOptions } from './anthropic-compat.ts';

export interface BuiltinProviderDefinition {
  readonly id: string;
  readonly label: string;
  readonly envVars: readonly string[];
  readonly serviceNames?: readonly string[];
  readonly aliases?: readonly string[];
  readonly subscriptionProviderId?: string;
}

export interface BuiltinOpenAICompatDefinition extends BuiltinProviderDefinition {
  readonly kind: 'openai-compat';
  readonly baseURL: string;
  readonly defaultModel: string;
  readonly models: readonly string[];
  readonly embeddingModel?: string;
  readonly reasoningFormat?: OpenAICompatOptions['reasoningFormat'];
  readonly suppressedModels?: readonly string[];
  readonly streamProtocol?: string;
  readonly defaultHeaders?: Record<string, string>;
  readonly allowAnonymous?: boolean;
  readonly anonymousConfigured?: boolean;
  readonly anonymousDetail?: string;
}

export interface BuiltinAnthropicCompatDefinition extends BuiltinProviderDefinition {
  readonly kind: 'anthropic-compat';
  readonly baseURL: string;
  readonly defaultModel: string;
  readonly models: readonly string[];
  readonly defaultHeaders?: Record<string, string>;
  readonly authHeaderMode?: AnthropicCompatOptions['authHeaderMode'];
  readonly streamProtocol?: string;
  readonly allowAnonymous?: boolean;
  readonly anonymousConfigured?: boolean;
  readonly anonymousDetail?: string;
}

export type BuiltinCompatDefinition =
  | BuiltinOpenAICompatDefinition
  | BuiltinAnthropicCompatDefinition;

export const BUILTIN_PROVIDER_ENV_KEYS: Record<string, readonly string[]> = {
  openai: ['OPENAI_API_KEY', 'OPENAI_KEY'],
  anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_API_KEY'],
  inceptionlabs: ['INCEPTION_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  aihubmix: ['AIHUBMIX_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  'ollama-cloud': ['OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY'],
  huggingface: ['HF_API_KEY', 'HUGGINGFACE_API_KEY', 'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN'],
  nvidia: ['NVIDIA_API_KEY', 'NIM_API_KEY'],
  llm7: ['LLM7_API_KEY'],
  'amazon-bedrock': ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  'amazon-bedrock-mantle': ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  'anthropic-vertex': ['GOOGLE_APPLICATION_CREDENTIALS', 'ANTHROPIC_VERTEX_PROJECT_ID', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID'],
  deepseek: ['DEEPSEEK_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  'microsoft-foundry': ['AZURE_OPENAI_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
  qianfan: ['QIANFAN_API_KEY'],
  qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY', 'MODELSTUDIO_API_KEY'],
  sglang: ['SGLANG_API_KEY'],
  stepfun: ['STEPFUN_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  venice: ['VENICE_API_KEY'],
  volcengine: ['VOLCANO_ENGINE_API_KEY'],
  xai: ['XAI_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  zai: ['ZAI_API_KEY', 'Z_AI_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_AI_GATEWAY_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  litellm: ['LITELLM_API_KEY'],
  'copilot-proxy': ['COPILOT_PROXY_API_KEY'],
  perplexity: ['PERPLEXITY_API_KEY'],
  deepgram: ['DEEPGRAM_API_KEY'],
  elevenlabs: ['ELEVENLABS_API_KEY', 'XI_API_KEY'],
  microsoft: [],
  vydra: ['VYDRA_API_KEY'],
  byteplus: ['BYTEPLUS_API_KEY'],
  fal: ['FAL_KEY', 'FAL_API_KEY'],
  comfy: ['COMFY_API_KEY'],
  runway: ['RUNWAYML_API_SECRET', 'RUNWAY_API_KEY'],
  alibaba: ['MODELSTUDIO_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
};

export function getBuiltinProviderEnvVars(providerId: string): readonly string[] {
  return BUILTIN_PROVIDER_ENV_KEYS[providerId] ?? [];
}

export const BUILTIN_COMPAT_PROVIDERS: readonly BuiltinCompatDefinition[] = [
  {
    kind: 'openai-compat',
    id: 'deepseek',
    label: 'DeepSeek',
    envVars: getBuiltinProviderEnvVars('deepseek'),
    serviceNames: ['deepseek'],
    baseURL: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    aliases: ['deepseek-ai'],
  },
  {
    kind: 'openai-compat',
    id: 'fireworks',
    label: 'Fireworks',
    envVars: getBuiltinProviderEnvVars('fireworks'),
    serviceNames: ['fireworks'],
    baseURL: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/routers/kimi-k2p5-turbo',
    models: [
      'accounts/fireworks/routers/kimi-k2p5-turbo',
      'accounts/fireworks/models/kimi-k2p5-turbo',
      'accounts/fireworks/models/llama-v3p1-405b-instruct',
    ],
  },
  {
    kind: 'openai-compat',
    id: 'microsoft-foundry',
    label: 'Microsoft Foundry',
    envVars: getBuiltinProviderEnvVars('microsoft-foundry'),
    serviceNames: ['microsoft-foundry'],
    baseURL: 'https://example.openai.azure.com/openai/v1',
    defaultModel: 'gpt-5.4',
    models: ['gpt-5.4', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'o3-mini'],
    aliases: ['azure-openai', 'azure-openai-responses'],
    streamProtocol: 'openai-sse',
  },
  {
    kind: 'anthropic-compat',
    id: 'minimax',
    label: 'MiniMax',
    envVars: getBuiltinProviderEnvVars('minimax'),
    serviceNames: ['minimax'],
    baseURL: 'https://api.minimax.io/anthropic',
    defaultModel: 'MiniMax-M2.7',
    models: ['MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M1-80k'],
    streamProtocol: 'anthropic-sse',
  },
  {
    kind: 'openai-compat',
    id: 'moonshot',
    label: 'Moonshot',
    envVars: getBuiltinProviderEnvVars('moonshot'),
    serviceNames: ['moonshot'],
    baseURL: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k2.5',
    models: ['kimi-k2.5', 'kimi-k2-thinking', 'kimi-k2-instruct'],
  },
  {
    kind: 'openai-compat',
    id: 'qianfan',
    label: 'Qianfan',
    envVars: getBuiltinProviderEnvVars('qianfan'),
    serviceNames: ['qianfan'],
    baseURL: 'https://qianfan.baidubce.com/v2',
    defaultModel: 'deepseek-v3.2',
    models: ['deepseek-v3.2', 'ernie-4.5-300b-a47b', 'ernie-4.5-turbo-32k'],
  },
  {
    kind: 'openai-compat',
    id: 'qwen',
    label: 'Qwen',
    envVars: getBuiltinProviderEnvVars('qwen'),
    serviceNames: ['qwen'],
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3.5-plus',
    models: ['qwen3.5-plus', 'qwen3-coder-plus', 'qwen3-max', 'qwen-vl-max'],
    aliases: ['dashscope'],
  },
  {
    kind: 'openai-compat',
    id: 'sglang',
    label: 'SGLang',
    envVars: getBuiltinProviderEnvVars('sglang'),
    serviceNames: ['sglang'],
    baseURL: 'http://127.0.0.1:30000/v1',
    defaultModel: 'default',
    models: ['default'],
    allowAnonymous: true,
    anonymousConfigured: true,
    anonymousDetail: 'SGLang usually runs as a local OpenAI-compatible server.',
  },
  {
    kind: 'openai-compat',
    id: 'stepfun',
    label: 'StepFun',
    envVars: getBuiltinProviderEnvVars('stepfun'),
    serviceNames: ['stepfun'],
    baseURL: 'https://api.stepfun.ai/v1',
    defaultModel: 'step-3.5-flash',
    models: ['step-3.5-flash', 'step-2-mini', 'step-1v-8k'],
  },
  {
    kind: 'openai-compat',
    id: 'together',
    label: 'Together AI',
    envVars: getBuiltinProviderEnvVars('together'),
    serviceNames: ['together'],
    baseURL: 'https://api.together.xyz/v1',
    defaultModel: 'moonshotai/Kimi-K2.5',
    models: [
      'moonshotai/Kimi-K2.5',
      'moonshotai/Kimi-K2-Instruct',
      'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
      'Qwen/Qwen3-235B-A22B-fp8-tput',
    ],
  },
  {
    kind: 'openai-compat',
    id: 'venice',
    label: 'Venice',
    envVars: getBuiltinProviderEnvVars('venice'),
    serviceNames: ['venice'],
    baseURL: 'https://api.venice.ai/api/v1',
    defaultModel: 'kimi-k2-5',
    models: ['kimi-k2-5', 'llama-3.3-70b', 'qwen-2.5-coder-32b'],
  },
  {
    kind: 'openai-compat',
    id: 'volcengine',
    label: 'Volcengine',
    envVars: getBuiltinProviderEnvVars('volcengine'),
    serviceNames: ['volcengine'],
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-1-8-251228',
    models: ['doubao-seed-1-8-251228', 'ark-code-latest', 'doubao-1.5-pro-32k'],
    aliases: ['volcano-engine'],
  },
  {
    kind: 'openai-compat',
    id: 'xai',
    label: 'xAI',
    envVars: getBuiltinProviderEnvVars('xai'),
    serviceNames: ['xai'],
    baseURL: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
    models: ['grok-4', 'grok-4-fast', 'grok-4-1-fast', 'grok-code-fast-1'],
    aliases: ['x-ai'],
  },
  {
    kind: 'openai-compat',
    id: 'xiaomi',
    label: 'Xiaomi MiMo',
    envVars: getBuiltinProviderEnvVars('xiaomi'),
    serviceNames: ['xiaomi'],
    baseURL: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2-flash',
    models: ['mimo-v2-flash', 'mimo-v2-preview'],
  },
  {
    kind: 'openai-compat',
    id: 'zai',
    label: 'Z.ai',
    envVars: getBuiltinProviderEnvVars('zai'),
    serviceNames: ['zai'],
    baseURL: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-5',
    models: ['glm-5', 'glm-4.7', 'glm-4.6', 'glm-4.5-air'],
    aliases: ['z-ai'],
  },
  {
    kind: 'openai-compat',
    id: 'cloudflare-ai-gateway',
    label: 'Cloudflare AI Gateway',
    envVars: getBuiltinProviderEnvVars('cloudflare-ai-gateway'),
    serviceNames: ['cloudflare-ai-gateway'],
    baseURL: 'https://gateway.ai.cloudflare.com/v1/account/gateway/openai',
    defaultModel: 'claude-sonnet-4-5',
    models: ['claude-sonnet-4-5', 'gpt-4.1', 'grok-4'],
    aliases: ['cloudflare-gateway'],
  },
  {
    kind: 'openai-compat',
    id: 'vercel-ai-gateway',
    label: 'Vercel AI Gateway',
    envVars: getBuiltinProviderEnvVars('vercel-ai-gateway'),
    serviceNames: ['vercel-ai-gateway'],
    baseURL: 'https://ai-gateway.vercel.sh/v1',
    defaultModel: 'anthropic/claude-opus-4.6',
    models: ['anthropic/claude-opus-4.6', 'openai/gpt-5.4', 'xai/grok-4'],
    aliases: ['ai-gateway'],
  },
  {
    kind: 'openai-compat',
    id: 'litellm',
    label: 'LiteLLM',
    envVars: getBuiltinProviderEnvVars('litellm'),
    serviceNames: ['litellm'],
    baseURL: 'http://localhost:4000/v1',
    defaultModel: 'claude-opus-4-6',
    models: ['claude-opus-4-6', 'gpt-5.4', 'gemini-3-pro'],
    allowAnonymous: true,
    anonymousConfigured: true,
    anonymousDetail: 'LiteLLM commonly runs as a local or self-hosted gateway.',
  },
  {
    kind: 'openai-compat',
    id: 'copilot-proxy',
    label: 'Copilot Proxy',
    envVars: getBuiltinProviderEnvVars('copilot-proxy'),
    serviceNames: ['copilot-proxy'],
    baseURL: 'http://localhost:3000/v1',
    defaultModel: 'gpt-5.2',
    models: [
      'gpt-5.2',
      'gpt-5.2-codex',
      'gpt-5.1',
      'gpt-5-mini',
      'claude-opus-4.6',
      'claude-sonnet-4.5',
      'gemini-3-pro',
      'grok-code-fast-1',
    ],
    allowAnonymous: true,
    anonymousConfigured: true,
    anonymousDetail: 'Copilot Proxy is an operator-managed local gateway.',
  },
];
