import type { LLMProvider } from './interface.ts';
import type { DiscoveredServer } from '../discovery/scanner.ts';
import { OpenAIProvider } from './openai.ts';
import { OpenAICompatProvider } from './openai-compat.ts';
import { AnthropicProvider } from './anthropic.ts';
import { GeminiProvider } from './gemini.ts';
import { config } from '../config/index.ts';
import type { EventBus } from '../core/event-bus.ts';
import { loadCustomProviders, watchCustomProviders } from './custom-loader.ts';

/** Model capability tier — controls system prompt verbosity. */
export type ModelTier = 'free' | 'standard' | 'premium';

/** Describes a selectable model and its capabilities. */
export interface ModelDefinition {
  id: string;
  provider: string;
  displayName: string;
  description: string;
  capabilities: {
    toolCalling: boolean;
    codeEditing: boolean;
    reasoning: boolean;
    multimodal: boolean;
  };
  contextWindow: number;
  /** Whether the user can select this model in the model picker. */
  selectable: boolean;
  /** Available reasoning effort levels for this model (controls UI effort picker). */
  reasoningEffort?: string[];
  /** Model capability tier — controls system prompt verbosity. */
  tier?: ModelTier;
}

const BUILTIN_MODEL_REGISTRY: ModelDefinition[] = [
  // --- InceptionLabs ---
  {
    id: 'mercury-2',
    provider: 'inceptionlabs',
    displayName: 'Mercury 2',
    description: 'InceptionLabs diffusion LLM with configurable reasoning depth.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: true, multimodal: false },
    contextWindow: 32768,
    selectable: true,
    reasoningEffort: ['instant', 'low', 'medium', 'high'],
    tier: 'standard',
  },
  {
    id: 'mercury-edit',
    provider: 'inceptionlabs',
    displayName: 'Mercury Edit',
    description: 'InceptionLabs specialised code-editing model (not user-selectable).',
    capabilities: { toolCalling: false, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 32768,
    selectable: false,
    tier: 'standard',
  },

  // --- OpenAI ---
  {
    id: 'gpt-5.4',
    provider: 'openai',
    displayName: 'GPT-5.4',
    description: 'OpenAI flagship model.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 128000,
    selectable: true,
    tier: 'premium',
  },
  {
    id: 'gpt-5.3-chat-latest',
    provider: 'openai',
    displayName: 'GPT-5.3 Chat (latest)',
    description: 'OpenAI GPT-5.3 chat optimised model.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 128000,
    selectable: true,
    tier: 'premium',
  },
  {
    id: 'gpt-5-mini',
    provider: 'openai',
    displayName: 'GPT-5 Mini',
    description: 'OpenAI lightweight fast model.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
    contextWindow: 128000,
    selectable: true,
    tier: 'standard',
  },
  {
    id: 'gpt-5-nano',
    provider: 'openai',
    displayName: 'GPT-5 Nano',
    description: 'OpenAI ultra-lightweight model for edge tasks.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 32768,
    selectable: true,
    tier: 'standard',
  },
  {
    id: 'gpt-oss-120b',
    provider: 'openai',
    displayName: 'GPT OSS 120B',
    description: 'OpenAI open-source 120B parameter model.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 128000,
    selectable: true,
    tier: 'standard',
  },

  // --- Gemini ---
  {
    id: 'gemini-3.1-pro-preview',
    provider: 'gemini',
    displayName: 'Gemini 3.1 Pro (preview)',
    description: 'Google Gemini 3.1 Pro preview.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'premium',
  },
  {
    id: 'gemini-3-flash',
    provider: 'gemini',
    displayName: 'Gemini 3 Flash',
    description: 'Google Gemini 3 Flash — fast and cost-efficient.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    tier: 'standard',
  },
  {
    id: 'gemini-3.1-flash-lite-preview',
    provider: 'gemini',
    displayName: 'Gemini 3.1 Flash Lite (preview)',
    description: 'Google Gemini 3.1 Flash Lite preview — ultra-fast.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 128000,
    selectable: true,
    tier: 'standard',
  },
  {
    id: 'gemini-2.5-pro',
    provider: 'gemini',
    displayName: 'Gemini 2.5 Pro',
    description: 'Google Gemini 2.5 Pro — current stable release.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'premium',
  },

  // --- OpenRouter (free) ---
  {
    id: 'openrouter/free',
    provider: 'openrouter',
    displayName: 'Free Models Router',
    description: 'Auto-routes to the best available free model on OpenRouter.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 200000,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'arcee-ai/trinity-mini:free',
    provider: 'openrouter',
    displayName: 'Arcee AI Trinity Mini',
    description: 'Arcee AI Trinity Mini — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'minimax/minimax-m2.5:free',
    provider: 'openrouter',
    displayName: 'MiniMax M2.5',
    description: 'MiniMax M2.5 — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 196608,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'nvidia/nemotron-3-super-120b-a12b:free',
    provider: 'openrouter',
    displayName: 'Nemotron 3 Super 120B',
    description: 'NVIDIA Nemotron 3 Super 120B MoE — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 262144,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'nvidia/nemotron-3-nano-30b-a3b:free',
    provider: 'openrouter',
    displayName: 'Nemotron 3 Nano 30B',
    description: 'NVIDIA Nemotron 3 Nano 30B — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 256000,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'nvidia/nemotron-nano-12b-v2-vl:free',
    provider: 'openrouter',
    displayName: 'Nemotron Nano 12B V2 VL',
    description: 'NVIDIA Nemotron Nano 12B V2 with vision — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 128000,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'nvidia/nemotron-nano-9b-v2:free',
    provider: 'openrouter',
    displayName: 'Nemotron Nano 9B V2',
    description: 'NVIDIA Nemotron Nano 9B V2 — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 128000,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'openai/gpt-oss-120b:free',
    provider: 'openrouter',
    displayName: 'GPT OSS 120B',
    description: 'OpenAI open-source 120B via OpenRouter — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'openai/gpt-oss-20b:free',
    provider: 'openrouter',
    displayName: 'GPT OSS 20B',
    description: 'OpenAI open-source 20B via OpenRouter — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'stepfun/step-3.5-flash:free',
    provider: 'openrouter',
    displayName: 'Step 3.5 Flash',
    description: 'StepFun Step 3.5 Flash — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 256000,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },
  {
    id: 'z-ai/glm-4.5-air:free',
    provider: 'openrouter',
    displayName: 'GLM 4.5 Air',
    description: 'Z.ai GLM 4.5 Air — free tier.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'free',
  },

  // --- HuggingFace ---
  // Qwen (34)
  { id: 'Qwen/QwQ-32B', provider: 'huggingface', displayName: 'QwQ-32B (HF)', description: 'Qwen QwQ-32B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen2.5-72B-Instruct', provider: 'huggingface', displayName: 'Qwen2.5-72B-Instruct (HF)', description: 'Qwen 2.5 72B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen2.5-7B-Instruct', provider: 'huggingface', displayName: 'Qwen2.5-7B-Instruct (HF)', description: 'Qwen 2.5 7B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', provider: 'huggingface', displayName: 'Qwen2.5-Coder-32B-Instruct (HF)', description: 'Qwen 2.5 Coder 32B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen2.5-Coder-3B-Instruct', provider: 'huggingface', displayName: 'Qwen2.5-Coder-3B-Instruct (HF)', description: 'Qwen 2.5 Coder 3B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen2.5-Coder-7B-Instruct', provider: 'huggingface', displayName: 'Qwen2.5-Coder-7B-Instruct (HF)', description: 'Qwen 2.5 Coder 7B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen2.5-VL-72B-Instruct', provider: 'huggingface', displayName: 'Qwen2.5-VL-72B-Instruct (HF)', description: 'Qwen 2.5 VL 72B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen2.5-VL-7B-Instruct', provider: 'huggingface', displayName: 'Qwen2.5-VL-7B-Instruct (HF)', description: 'Qwen 2.5 VL 7B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-14B', provider: 'huggingface', displayName: 'Qwen3-14B (HF)', description: 'Qwen3 14B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-235B-A22B', provider: 'huggingface', displayName: 'Qwen3-235B-A22B (HF)', description: 'Qwen3 235B A22B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', provider: 'huggingface', displayName: 'Qwen3-235B-A22B-Instruct-2507 (HF)', description: 'Qwen3 235B A22B Instruct 2507 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-235B-A22B-Thinking-2507', provider: 'huggingface', displayName: 'Qwen3-235B-A22B-Thinking-2507 (HF)', description: 'Qwen3 235B A22B Thinking 2507 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-30B-A3B', provider: 'huggingface', displayName: 'Qwen3-30B-A3B (HF)', description: 'Qwen3 30B A3B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-32B', provider: 'huggingface', displayName: 'Qwen3-32B (HF)', description: 'Qwen3 32B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-4B-Instruct-2507', provider: 'huggingface', displayName: 'Qwen3-4B-Instruct-2507 (HF)', description: 'Qwen3 4B Instruct 2507 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-4B-Thinking-2507', provider: 'huggingface', displayName: 'Qwen3-4B-Thinking-2507 (HF)', description: 'Qwen3 4B Thinking 2507 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-8B', provider: 'huggingface', displayName: 'Qwen3-8B (HF)', description: 'Qwen3 8B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', provider: 'huggingface', displayName: 'Qwen3-Coder-30B-A3B-Instruct (HF)', description: 'Qwen3 Coder 30B A3B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', provider: 'huggingface', displayName: 'Qwen3-Coder-480B-A35B-Instruct (HF)', description: 'Qwen3 Coder 480B A35B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8', provider: 'huggingface', displayName: 'Qwen3-Coder-480B-A35B-Instruct-FP8 (HF)', description: 'Qwen3 Coder 480B A35B Instruct FP8 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-Coder-Next', provider: 'huggingface', displayName: 'Qwen3-Coder-Next (HF)', description: 'Qwen3 Coder Next via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-Coder-Next-FP8', provider: 'huggingface', displayName: 'Qwen3-Coder-Next-FP8 (HF)', description: 'Qwen3 Coder Next FP8 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-Next-80B-A3B-Instruct', provider: 'huggingface', displayName: 'Qwen3-Next-80B-A3B-Instruct (HF)', description: 'Qwen3 Next 80B A3B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-Next-80B-A3B-Thinking', provider: 'huggingface', displayName: 'Qwen3-Next-80B-A3B-Thinking (HF)', description: 'Qwen3 Next 80B A3B Thinking via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-VL-235B-A22B-Instruct', provider: 'huggingface', displayName: 'Qwen3-VL-235B-A22B-Instruct (HF)', description: 'Qwen3 VL 235B A22B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-VL-235B-A22B-Thinking', provider: 'huggingface', displayName: 'Qwen3-VL-235B-A22B-Thinking (HF)', description: 'Qwen3 VL 235B A22B Thinking via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-VL-30B-A3B-Instruct', provider: 'huggingface', displayName: 'Qwen3-VL-30B-A3B-Instruct (HF)', description: 'Qwen3 VL 30B A3B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-VL-30B-A3B-Thinking', provider: 'huggingface', displayName: 'Qwen3-VL-30B-A3B-Thinking (HF)', description: 'Qwen3 VL 30B A3B Thinking via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3-VL-8B-Instruct', provider: 'huggingface', displayName: 'Qwen3-VL-8B-Instruct (HF)', description: 'Qwen3 VL 8B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3.5-122B-A10B', provider: 'huggingface', displayName: 'Qwen3.5-122B-A10B (HF)', description: 'Qwen3.5 122B A10B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3.5-27B', provider: 'huggingface', displayName: 'Qwen3.5-27B (HF)', description: 'Qwen3.5 27B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3.5-35B-A3B', provider: 'huggingface', displayName: 'Qwen3.5-35B-A3B (HF)', description: 'Qwen3.5 35B A3B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3.5-397B-A17B', provider: 'huggingface', displayName: 'Qwen3.5-397B-A17B (HF)', description: 'Qwen3.5 397B A17B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Qwen/Qwen3.5-9B', provider: 'huggingface', displayName: 'Qwen3.5-9B (HF)', description: 'Qwen3.5 9B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  // deepseek-ai (14)
  { id: 'deepseek-ai/DeepSeek-Prover-V2-671B', provider: 'huggingface', displayName: 'DeepSeek-Prover-V2-671B (HF)', description: 'DeepSeek Prover V2 671B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'deepseek-ai/DeepSeek-R1', provider: 'huggingface', displayName: 'DeepSeek-R1 (HF)', description: 'DeepSeek R1 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'deepseek-ai/DeepSeek-R1-0528', provider: 'huggingface', displayName: 'DeepSeek-R1-0528 (HF)', description: 'DeepSeek R1 0528 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B', provider: 'huggingface', displayName: 'DeepSeek-R1-Distill-Llama-70B (HF)', description: 'DeepSeek R1 Distill Llama 70B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'deepseek-ai/DeepSeek-R1-Distill-Llama-8B', provider: 'huggingface', displayName: 'DeepSeek-R1-Distill-Llama-8B (HF)', description: 'DeepSeek R1 Distill Llama 8B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B', provider: 'huggingface', displayName: 'DeepSeek-R1-Distill-Qwen-1.5B (HF)', description: 'DeepSeek R1 Distill Qwen 1.5B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B', provider: 'huggingface', displayName: 'DeepSeek-R1-Distill-Qwen-32B (HF)', description: 'DeepSeek R1 Distill Qwen 32B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', provider: 'huggingface', displayName: 'DeepSeek-R1-Distill-Qwen-7B (HF)', description: 'DeepSeek R1 Distill Qwen 7B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'deepseek-ai/DeepSeek-V3', provider: 'huggingface', displayName: 'DeepSeek-V3 (HF)', description: 'DeepSeek V3 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'deepseek-ai/DeepSeek-V3-0324', provider: 'huggingface', displayName: 'DeepSeek-V3-0324 (HF)', description: 'DeepSeek V3 0324 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'deepseek-ai/DeepSeek-V3.1', provider: 'huggingface', displayName: 'DeepSeek-V3.1 (HF)', description: 'DeepSeek V3.1 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'deepseek-ai/DeepSeek-V3.1-Terminus', provider: 'huggingface', displayName: 'DeepSeek-V3.1-Terminus (HF)', description: 'DeepSeek V3.1 Terminus via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'deepseek-ai/DeepSeek-V3.2', provider: 'huggingface', displayName: 'DeepSeek-V3.2 (HF)', description: 'DeepSeek V3.2 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'deepseek-ai/DeepSeek-V3.2-Exp', provider: 'huggingface', displayName: 'DeepSeek-V3.2-Exp (HF)', description: 'DeepSeek V3.2 Exp via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  // zai-org (16)
  { id: 'zai-org/AutoGLM-Phone-9B-Multilingual', provider: 'huggingface', displayName: 'AutoGLM-Phone-9B-Multilingual (HF)', description: 'AutoGLM Phone 9B Multilingual via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'zai-org/GLM-4-32B-0414', provider: 'huggingface', displayName: 'GLM-4-32B-0414 (HF)', description: 'GLM-4 32B 0414 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'zai-org/GLM-4.5', provider: 'huggingface', displayName: 'GLM-4.5 (HF)', description: 'GLM-4.5 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'zai-org/GLM-4.5-Air', provider: 'huggingface', displayName: 'GLM-4.5-Air (HF)', description: 'GLM-4.5 Air via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'zai-org/GLM-4.5-Air-FP8', provider: 'huggingface', displayName: 'GLM-4.5-Air-FP8 (HF)', description: 'GLM-4.5 Air FP8 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'zai-org/GLM-4.5V', provider: 'huggingface', displayName: 'GLM-4.5V (HF)', description: 'GLM-4.5V via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'zai-org/GLM-4.5V-FP8', provider: 'huggingface', displayName: 'GLM-4.5V-FP8 (HF)', description: 'GLM-4.5V FP8 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'zai-org/GLM-4.6', provider: 'huggingface', displayName: 'GLM-4.6 (HF)', description: 'GLM-4.6 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'zai-org/GLM-4.6-FP8', provider: 'huggingface', displayName: 'GLM-4.6-FP8 (HF)', description: 'GLM-4.6 FP8 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'zai-org/GLM-4.6V', provider: 'huggingface', displayName: 'GLM-4.6V (HF)', description: 'GLM-4.6V via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'zai-org/GLM-4.6V-FP8', provider: 'huggingface', displayName: 'GLM-4.6V-FP8 (HF)', description: 'GLM-4.6V FP8 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'zai-org/GLM-4.6V-Flash', provider: 'huggingface', displayName: 'GLM-4.6V-Flash (HF)', description: 'GLM-4.6V Flash via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'zai-org/GLM-4.7', provider: 'huggingface', displayName: 'GLM-4.7 (HF)', description: 'GLM-4.7 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'zai-org/GLM-4.7-FP8', provider: 'huggingface', displayName: 'GLM-4.7-FP8 (HF)', description: 'GLM-4.7 FP8 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'zai-org/GLM-4.7-Flash', provider: 'huggingface', displayName: 'GLM-4.7-Flash (HF)', description: 'GLM-4.7 Flash via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'zai-org/GLM-5', provider: 'huggingface', displayName: 'GLM-5 (HF)', description: 'GLM-5 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  // meta-llama (9)
  { id: 'meta-llama/Llama-3.1-70B-Instruct', provider: 'huggingface', displayName: 'Llama-3.1-70B-Instruct (HF)', description: 'Meta Llama 3.1 70B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'meta-llama/Llama-3.1-8B-Instruct', provider: 'huggingface', displayName: 'Llama-3.1-8B-Instruct (HF)', description: 'Meta Llama 3.1 8B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'meta-llama/Llama-3.2-1B-Instruct', provider: 'huggingface', displayName: 'Llama-3.2-1B-Instruct (HF)', description: 'Meta Llama 3.2 1B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'meta-llama/Llama-3.3-70B-Instruct', provider: 'huggingface', displayName: 'Llama-3.3-70B-Instruct (HF)', description: 'Meta Llama 3.3 70B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct', provider: 'huggingface', displayName: 'Llama-4-Maverick-17B-128E-Instruct (HF)', description: 'Meta Llama 4 Maverick 17B 128E Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', provider: 'huggingface', displayName: 'Llama-4-Maverick-17B-128E-Instruct-FP8 (HF)', description: 'Meta Llama 4 Maverick 17B 128E Instruct FP8 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'meta-llama/Llama-4-Scout-17B-16E-Instruct', provider: 'huggingface', displayName: 'Llama-4-Scout-17B-16E-Instruct (HF)', description: 'Meta Llama 4 Scout 17B 16E Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'meta-llama/Meta-Llama-3-70B-Instruct', provider: 'huggingface', displayName: 'Meta-Llama-3-70B-Instruct (HF)', description: 'Meta Llama 3 70B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'meta-llama/Meta-Llama-3-8B-Instruct', provider: 'huggingface', displayName: 'Meta-Llama-3-8B-Instruct (HF)', description: 'Meta Llama 3 8B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  // CohereLabs (13)
  { id: 'CohereLabs/aya-expanse-32b', provider: 'huggingface', displayName: 'aya-expanse-32b (HF)', description: 'Cohere Aya Expanse 32B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'CohereLabs/aya-vision-32b', provider: 'huggingface', displayName: 'aya-vision-32b (HF)', description: 'Cohere Aya Vision 32B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'CohereLabs/c4ai-command-a-03-2025', provider: 'huggingface', displayName: 'c4ai-command-a-03-2025 (HF)', description: 'Cohere Command A 03 2025 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'CohereLabs/c4ai-command-r-08-2024', provider: 'huggingface', displayName: 'c4ai-command-r-08-2024 (HF)', description: 'Cohere Command R 08 2024 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'CohereLabs/c4ai-command-r7b-12-2024', provider: 'huggingface', displayName: 'c4ai-command-r7b-12-2024 (HF)', description: 'Cohere Command R7B 12 2024 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'CohereLabs/c4ai-command-r7b-arabic-02-2025', provider: 'huggingface', displayName: 'c4ai-command-r7b-arabic-02-2025 (HF)', description: 'Cohere Command R7B Arabic 02 2025 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'CohereLabs/command-a-reasoning-08-2025', provider: 'huggingface', displayName: 'command-a-reasoning-08-2025 (HF)', description: 'Cohere Command A Reasoning 08 2025 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'CohereLabs/command-a-translate-08-2025', provider: 'huggingface', displayName: 'command-a-translate-08-2025 (HF)', description: 'Cohere Command A Translate 08 2025 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'CohereLabs/command-a-vision-07-2025', provider: 'huggingface', displayName: 'command-a-vision-07-2025 (HF)', description: 'Cohere Command A Vision 07 2025 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'CohereLabs/tiny-aya-earth', provider: 'huggingface', displayName: 'tiny-aya-earth (HF)', description: 'Cohere Tiny Aya Earth via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'CohereLabs/tiny-aya-fire', provider: 'huggingface', displayName: 'tiny-aya-fire (HF)', description: 'Cohere Tiny Aya Fire via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'CohereLabs/tiny-aya-global', provider: 'huggingface', displayName: 'tiny-aya-global (HF)', description: 'Cohere Tiny Aya Global via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'CohereLabs/tiny-aya-water', provider: 'huggingface', displayName: 'tiny-aya-water (HF)', description: 'Cohere Tiny Aya Water via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  // moonshotai (4)
  { id: 'moonshotai/Kimi-K2-Instruct', provider: 'huggingface', displayName: 'Kimi-K2-Instruct (HF)', description: 'Moonshot Kimi K2 Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'moonshotai/Kimi-K2-Instruct-0905', provider: 'huggingface', displayName: 'Kimi-K2-Instruct-0905 (HF)', description: 'Moonshot Kimi K2 Instruct 0905 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'moonshotai/Kimi-K2-Thinking', provider: 'huggingface', displayName: 'Kimi-K2-Thinking (HF)', description: 'Moonshot Kimi K2 Thinking via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'moonshotai/Kimi-K2.5', provider: 'huggingface', displayName: 'Kimi-K2.5 (HF)', description: 'Moonshot Kimi K2.5 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  // MiniMaxAI (4)
  { id: 'MiniMaxAI/MiniMax-M1-80k', provider: 'huggingface', displayName: 'MiniMax-M1-80k (HF)', description: 'MiniMax M1 80k via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'MiniMaxAI/MiniMax-M2', provider: 'huggingface', displayName: 'MiniMax-M2 (HF)', description: 'MiniMax M2 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'MiniMaxAI/MiniMax-M2.1', provider: 'huggingface', displayName: 'MiniMax-M2.1 (HF)', description: 'MiniMax M2.1 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'MiniMaxAI/MiniMax-M2.5', provider: 'huggingface', displayName: 'MiniMax-M2.5 (HF)', description: 'MiniMax M2.5 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  // google (2)
  { id: 'google/gemma-3-27b-it', provider: 'huggingface', displayName: 'gemma-3-27b-it (HF)', description: 'Google Gemma 3 27B IT via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'google/gemma-3n-E4B-it', provider: 'huggingface', displayName: 'gemma-3n-E4B-it (HF)', description: 'Google Gemma 3n E4B IT via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  // openai (3)
  { id: 'openai/gpt-oss-120b', provider: 'huggingface', displayName: 'gpt-oss-120b (HF)', description: 'OpenAI GPT OSS 120B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'openai/gpt-oss-20b', provider: 'huggingface', displayName: 'gpt-oss-20b (HF)', description: 'OpenAI GPT OSS 20B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'openai/gpt-oss-safeguard-20b', provider: 'huggingface', displayName: 'gpt-oss-safeguard-20b (HF)', description: 'OpenAI GPT OSS Safeguard 20B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  // XiaomiMiMo (1)
  { id: 'XiaomiMiMo/MiMo-V2-Flash', provider: 'huggingface', displayName: 'MiMo-V2-Flash (HF)', description: 'Xiaomi MiMo V2 Flash via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  // deepcogito (2)
  { id: 'deepcogito/cogito-671b-v2.1', provider: 'huggingface', displayName: 'cogito-671b-v2.1 (HF)', description: 'DeepCogito Cogito 671B v2.1 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'deepcogito/cogito-671b-v2.1-FP8', provider: 'huggingface', displayName: 'cogito-671b-v2.1-FP8 (HF)', description: 'DeepCogito Cogito 671B v2.1 FP8 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  // baidu (4)
  { id: 'baidu/ERNIE-4.5-21B-A3B-PT', provider: 'huggingface', displayName: 'ERNIE-4.5-21B-A3B-PT (HF)', description: 'Baidu ERNIE 4.5 21B A3B PT via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'baidu/ERNIE-4.5-300B-A47B-Base-PT', provider: 'huggingface', displayName: 'ERNIE-4.5-300B-A47B-Base-PT (HF)', description: 'Baidu ERNIE 4.5 300B A47B Base PT via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'baidu/ERNIE-4.5-VL-28B-A3B-PT', provider: 'huggingface', displayName: 'ERNIE-4.5-VL-28B-A3B-PT (HF)', description: 'Baidu ERNIE 4.5 VL 28B A3B PT via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'baidu/ERNIE-4.5-VL-424B-A47B-Base-PT', provider: 'huggingface', displayName: 'ERNIE-4.5-VL-424B-A47B-Base-PT (HF)', description: 'Baidu ERNIE 4.5 VL 424B A47B Base PT via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true }, contextWindow: 131072, selectable: true, tier: 'free' },
  // allenai (3)
  { id: 'allenai/Olmo-3-7B-Instruct', provider: 'huggingface', displayName: 'Olmo-3-7B-Instruct (HF)', description: 'AllenAI Olmo 3 7B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'allenai/Olmo-3.1-32B-Instruct', provider: 'huggingface', displayName: 'Olmo-3.1-32B-Instruct (HF)', description: 'AllenAI Olmo 3.1 32B Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'allenai/Olmo-3.1-32B-Think', provider: 'huggingface', displayName: 'Olmo-3.1-32B-Think (HF)', description: 'AllenAI Olmo 3.1 32B Think via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  // Others (15)
  { id: 'EssentialAI/rnj-1-instruct', provider: 'huggingface', displayName: 'rnj-1-instruct (HF)', description: 'EssentialAI RNJ-1 Instruct via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'NousResearch/Hermes-2-Pro-Llama-3-8B', provider: 'huggingface', displayName: 'Hermes-2-Pro-Llama-3-8B (HF)', description: 'NousResearch Hermes 2 Pro Llama 3 8B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Sao10K/L3-70B-Euryale-v2.1', provider: 'huggingface', displayName: 'L3-70B-Euryale-v2.1 (HF)', description: 'Sao10K L3 70B Euryale v2.1 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Sao10K/L3-8B-Lunaris-v1', provider: 'huggingface', displayName: 'L3-8B-Lunaris-v1 (HF)', description: 'Sao10K L3 8B Lunaris v1 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'Sao10K/L3-8B-Stheno-v3.2', provider: 'huggingface', displayName: 'L3-8B-Stheno-v3.2 (HF)', description: 'Sao10K L3 8B Stheno v3.2 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'ServiceNow-AI/Apriel-1.6-15b-Thinker', provider: 'huggingface', displayName: 'Apriel-1.6-15b-Thinker (HF)', description: 'ServiceNow Apriel 1.6 15B Thinker via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'aisingapore/Gemma-SEA-LION-v4-27B-IT', provider: 'huggingface', displayName: 'Gemma-SEA-LION-v4-27B-IT (HF)', description: 'AI Singapore Gemma SEA-LION v4 27B IT via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'aisingapore/Qwen-SEA-LION-v4-32B-IT', provider: 'huggingface', displayName: 'Qwen-SEA-LION-v4-32B-IT (HF)', description: 'AI Singapore Qwen SEA-LION v4 32B IT via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'alpindale/WizardLM-2-8x22B', provider: 'huggingface', displayName: 'WizardLM-2-8x22B (HF)', description: 'Alpindale WizardLM 2 8x22B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'dicta-il/DictaLM-3.0-24B-Thinking', provider: 'huggingface', displayName: 'DictaLM-3.0-24B-Thinking (HF)', description: 'Dicta-IL DictaLM 3.0 24B Thinking via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'katanemo/Arch-Router-1.5B', provider: 'huggingface', displayName: 'Arch-Router-1.5B (HF)', description: 'Katanemo Arch Router 1.5B via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'swiss-ai/Apertus-70B-Instruct-2509', provider: 'huggingface', displayName: 'Apertus-70B-Instruct-2509 (HF)', description: 'Swiss AI Apertus 70B Instruct 2509 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'swiss-ai/Apertus-8B-Instruct-2509', provider: 'huggingface', displayName: 'Apertus-8B-Instruct-2509 (HF)', description: 'Swiss AI Apertus 8B Instruct 2509 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'tokyotech-llm/Llama-3.3-Swallow-70B-Instruct-v0.4', provider: 'huggingface', displayName: 'Llama-3.3-Swallow-70B-Instruct-v0.4 (HF)', description: 'TokyoTech Llama 3.3 Swallow 70B Instruct v0.4 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },
  { id: 'utter-project/EuroLLM-22B-Instruct-2512', provider: 'huggingface', displayName: 'EuroLLM-22B-Instruct-2512 (HF)', description: 'Utter Project EuroLLM 22B Instruct 2512 via HuggingFace.', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 131072, selectable: true, tier: 'free' },

  // --- Anthropic ---
  {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    displayName: 'Claude Opus 4.6',
    description: 'Anthropic most powerful model.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'premium',
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    displayName: 'Claude Sonnet 4.6',
    description: 'Anthropic balanced model — fast and capable.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    reasoningEffort: ['low', 'medium', 'high'],
    tier: 'premium',
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    displayName: 'Claude Haiku 4.5',
    description: 'Anthropic lightweight fast model.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
    contextWindow: 200000,
    selectable: true,
    tier: 'standard',
  },
];

/** Mutable array of custom-loaded model definitions. */
let customModels: ModelDefinition[] = [];

/** Mutable array of discovered (scanned) model definitions — lowest priority. */
let discoveredModels: ModelDefinition[] = [];

/**
 * Returns the combined model registry: custom models take precedence over built-ins
 * when a custom model has the same ID as a built-in.
 */
export function getModelRegistry(): ModelDefinition[] {
  const builtinFiltered = BUILTIN_MODEL_REGISTRY.filter(
    (b) => !customModels.some((c) => c.id === b.id),
  );
  const discoveredFiltered = discoveredModels.filter(
    (d) =>
      !BUILTIN_MODEL_REGISTRY.some((b) => b.id === d.id) &&
      !customModels.some((c) => c.id === d.id),
  );
  return [...customModels, ...builtinFiltered, ...discoveredFiltered];
}

/**
 * Backward-compatible export. Prefer getModelRegistry() for live model lists.
 * This refers to the built-in models only and does NOT include custom providers.
 * @deprecated Use getModelRegistry() to include custom providers.
 */
export const MODEL_REGISTRY: ModelDefinition[] = BUILTIN_MODEL_REGISTRY;

/**
 * ProviderRegistry — manages LLM provider instances and model selection.
 * Lazily instantiates providers on first use.
 */
export class ProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map();
  private currentModelId: string;
  private discoveredProviderNames: Set<string> = new Set();

  constructor() {
    this.currentModelId = config.model ?? 'openrouter/free';
    this.registerBuiltins();
  }

  private registerBuiltins(): void {
    const apiKey = (name: string): string => {
      const key = config.apiKeys[name] ?? '';
      if (!key) {
        // Silently skip — console.warn corrupts TUI display. Missing keys are handled at request time.
      }
      return key;
    };

    this.register(
      new OpenAICompatProvider({
        name: 'inceptionlabs',
        baseURL: 'https://api.inceptionlabs.ai/v1',
        apiKey: apiKey('inceptionlabs'),
        defaultModel: 'mercury-2',
        models: ['mercury-2', 'mercury-edit'],
        reasoningFormat: 'mercury',
      }),
    );

    this.register(
      new OpenAICompatProvider({
        name: 'openrouter',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: apiKey('openrouter'),
        defaultModel: 'openrouter/free',
        models: [
          'openrouter/free',
          'arcee-ai/trinity-mini:free',
          'minimax/minimax-m2.5:free',
          'nvidia/nemotron-3-super-120b-a12b:free',
          'nvidia/nemotron-3-nano-30b-a3b:free',
          'nvidia/nemotron-nano-12b-v2-vl:free',
          'nvidia/nemotron-nano-9b-v2:free',
          'openai/gpt-oss-120b:free',
          'openai/gpt-oss-20b:free',
          'stepfun/step-3.5-flash:free',
          'z-ai/glm-4.5-air:free',
        ],
        reasoningFormat: 'openrouter',
      }),
    );

    this.register(new OpenAIProvider(apiKey('openai')));
    this.register(new AnthropicProvider(apiKey('anthropic')));
    this.register(new GeminiProvider(apiKey('gemini')));

    this.register(
      new OpenAICompatProvider({
        name: 'huggingface',
        baseURL: 'https://router.huggingface.co/v1',
        apiKey: apiKey('huggingface'),
        defaultModel: 'deepseek-ai/DeepSeek-V3.2',
        models: [
          'Qwen/QwQ-32B',
          'Qwen/Qwen2.5-72B-Instruct',
          'Qwen/Qwen2.5-7B-Instruct',
          'Qwen/Qwen2.5-Coder-32B-Instruct',
          'Qwen/Qwen2.5-Coder-3B-Instruct',
          'Qwen/Qwen2.5-Coder-7B-Instruct',
          'Qwen/Qwen2.5-VL-72B-Instruct',
          'Qwen/Qwen2.5-VL-7B-Instruct',
          'Qwen/Qwen3-14B',
          'Qwen/Qwen3-235B-A22B',
          'Qwen/Qwen3-235B-A22B-Instruct-2507',
          'Qwen/Qwen3-235B-A22B-Thinking-2507',
          'Qwen/Qwen3-30B-A3B',
          'Qwen/Qwen3-32B',
          'Qwen/Qwen3-4B-Instruct-2507',
          'Qwen/Qwen3-4B-Thinking-2507',
          'Qwen/Qwen3-8B',
          'Qwen/Qwen3-Coder-30B-A3B-Instruct',
          'Qwen/Qwen3-Coder-480B-A35B-Instruct',
          'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8',
          'Qwen/Qwen3-Coder-Next',
          'Qwen/Qwen3-Coder-Next-FP8',
          'Qwen/Qwen3-Next-80B-A3B-Instruct',
          'Qwen/Qwen3-Next-80B-A3B-Thinking',
          'Qwen/Qwen3-VL-235B-A22B-Instruct',
          'Qwen/Qwen3-VL-235B-A22B-Thinking',
          'Qwen/Qwen3-VL-30B-A3B-Instruct',
          'Qwen/Qwen3-VL-30B-A3B-Thinking',
          'Qwen/Qwen3-VL-8B-Instruct',
          'Qwen/Qwen3.5-122B-A10B',
          'Qwen/Qwen3.5-27B',
          'Qwen/Qwen3.5-35B-A3B',
          'Qwen/Qwen3.5-397B-A17B',
          'Qwen/Qwen3.5-9B',
          'deepseek-ai/DeepSeek-Prover-V2-671B',
          'deepseek-ai/DeepSeek-R1',
          'deepseek-ai/DeepSeek-R1-0528',
          'deepseek-ai/DeepSeek-R1-Distill-Llama-70B',
          'deepseek-ai/DeepSeek-R1-Distill-Llama-8B',
          'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B',
          'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B',
          'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
          'deepseek-ai/DeepSeek-V3',
          'deepseek-ai/DeepSeek-V3-0324',
          'deepseek-ai/DeepSeek-V3.1',
          'deepseek-ai/DeepSeek-V3.1-Terminus',
          'deepseek-ai/DeepSeek-V3.2',
          'deepseek-ai/DeepSeek-V3.2-Exp',
          'zai-org/AutoGLM-Phone-9B-Multilingual',
          'zai-org/GLM-4-32B-0414',
          'zai-org/GLM-4.5',
          'zai-org/GLM-4.5-Air',
          'zai-org/GLM-4.5-Air-FP8',
          'zai-org/GLM-4.5V',
          'zai-org/GLM-4.5V-FP8',
          'zai-org/GLM-4.6',
          'zai-org/GLM-4.6-FP8',
          'zai-org/GLM-4.6V',
          'zai-org/GLM-4.6V-FP8',
          'zai-org/GLM-4.6V-Flash',
          'zai-org/GLM-4.7',
          'zai-org/GLM-4.7-FP8',
          'zai-org/GLM-4.7-Flash',
          'zai-org/GLM-5',
          'meta-llama/Llama-3.1-70B-Instruct',
          'meta-llama/Llama-3.1-8B-Instruct',
          'meta-llama/Llama-3.2-1B-Instruct',
          'meta-llama/Llama-3.3-70B-Instruct',
          'meta-llama/Llama-4-Maverick-17B-128E-Instruct',
          'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
          'meta-llama/Llama-4-Scout-17B-16E-Instruct',
          'meta-llama/Meta-Llama-3-70B-Instruct',
          'meta-llama/Meta-Llama-3-8B-Instruct',
          'CohereLabs/aya-expanse-32b',
          'CohereLabs/aya-vision-32b',
          'CohereLabs/c4ai-command-a-03-2025',
          'CohereLabs/c4ai-command-r-08-2024',
          'CohereLabs/c4ai-command-r7b-12-2024',
          'CohereLabs/c4ai-command-r7b-arabic-02-2025',
          'CohereLabs/command-a-reasoning-08-2025',
          'CohereLabs/command-a-translate-08-2025',
          'CohereLabs/command-a-vision-07-2025',
          'CohereLabs/tiny-aya-earth',
          'CohereLabs/tiny-aya-fire',
          'CohereLabs/tiny-aya-global',
          'CohereLabs/tiny-aya-water',
          'moonshotai/Kimi-K2-Instruct',
          'moonshotai/Kimi-K2-Instruct-0905',
          'moonshotai/Kimi-K2-Thinking',
          'moonshotai/Kimi-K2.5',
          'MiniMaxAI/MiniMax-M1-80k',
          'MiniMaxAI/MiniMax-M2',
          'MiniMaxAI/MiniMax-M2.1',
          'MiniMaxAI/MiniMax-M2.5',
          'google/gemma-3-27b-it',
          'google/gemma-3n-E4B-it',
          'openai/gpt-oss-120b',
          'openai/gpt-oss-20b',
          'openai/gpt-oss-safeguard-20b',
          'XiaomiMiMo/MiMo-V2-Flash',
          'deepcogito/cogito-671b-v2.1',
          'deepcogito/cogito-671b-v2.1-FP8',
          'baidu/ERNIE-4.5-21B-A3B-PT',
          'baidu/ERNIE-4.5-300B-A47B-Base-PT',
          'baidu/ERNIE-4.5-VL-28B-A3B-PT',
          'baidu/ERNIE-4.5-VL-424B-A47B-Base-PT',
          'allenai/Olmo-3-7B-Instruct',
          'allenai/Olmo-3.1-32B-Instruct',
          'allenai/Olmo-3.1-32B-Think',
          'EssentialAI/rnj-1-instruct',
          'NousResearch/Hermes-2-Pro-Llama-3-8B',
          'Sao10K/L3-70B-Euryale-v2.1',
          'Sao10K/L3-8B-Lunaris-v1',
          'Sao10K/L3-8B-Stheno-v3.2',
          'ServiceNow-AI/Apriel-1.6-15b-Thinker',
          'aisingapore/Gemma-SEA-LION-v4-27B-IT',
          'aisingapore/Qwen-SEA-LION-v4-32B-IT',
          'alpindale/WizardLM-2-8x22B',
          'dicta-il/DictaLM-3.0-24B-Thinking',
          'katanemo/Arch-Router-1.5B',
          'swiss-ai/Apertus-70B-Instruct-2509',
          'swiss-ai/Apertus-8B-Instruct-2509',
          'tokyotech-llm/Llama-3.3-Swallow-70B-Instruct-v0.4',
          'utter-project/EuroLLM-22B-Instruct-2512',
        ],
        reasoningFormat: 'none',
      }),
    );
  }

  /** Register a provider. Overwrites any existing entry with the same name. */
  register(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Register providers discovered by the local LLM scanner.
   * Clears previously discovered providers before re-registering.
   * Does not overwrite built-in or custom-loaded providers/models.
   */
  registerDiscoveredProviders(servers: DiscoveredServer[]): void {
    // Unregister previously discovered providers
    for (const name of this.discoveredProviderNames) {
      this.providers.delete(name);
    }
    this.discoveredProviderNames.clear();
    discoveredModels = [];

    for (const server of servers) {
      // Skip if a non-discovered provider already holds this name
      if (this.providers.has(server.name)) continue;
      // Skip servers with no models — defaultModel would be undefined
      if (server.models.length === 0) continue;

      // Map serverType to reasoningFormat so discovered providers send correct params
      const reasoningFormat = 
        server.serverType === 'llamacpp' ? 'llamacpp' as const :
        server.serverType === 'ollama' ? 'llamacpp' as const : // Ollama uses same enable_thinking param
        'none' as const;

      const provider = new OpenAICompatProvider({
        name: server.name,
        baseURL: server.baseURL,
        apiKey: '',
        defaultModel: server.models[0],
        models: server.models,
        reasoningFormat,
      });

      this.providers.set(server.name, provider);
      this.discoveredProviderNames.add(server.name);

      for (const modelId of server.models) {
        discoveredModels.push({
          id: modelId,
          provider: server.name,
          displayName: modelId,
          description: `Discovered local model on ${server.baseURL}`,
          capabilities: {
            toolCalling: true,
            codeEditing: true,
            reasoning: reasoningFormat !== 'none',
            multimodal: false,
          },
          ...(reasoningFormat !== 'none' ? { reasoningEffort: ['low', 'medium', 'high'] } : {}),
          contextWindow: 8192,
          selectable: true,
          tier: 'standard',
        });
      }
    }
  }

  /** Retrieve a provider by name. Throws if not found. */
  get(name: string): LLMProvider {
    const p = this.providers.get(name);
    if (!p) throw new Error(`Provider '${name}' is not registered.`);
    return p;
  }

  /** Return the provider responsible for a given model ID. */
  getForModel(modelId: string): LLMProvider {
    const def = getModelRegistry().find((m) => m.id === modelId);
    if (!def) throw new Error(`No model '${modelId}' in registry.`);
    return this.get(def.provider);
  }

  /** All registered model definitions. */
  listModels(): ModelDefinition[] {
    return getModelRegistry();
  }

  /** Only the models the user can switch to. */
  getSelectableModels(): ModelDefinition[] {
    return getModelRegistry().filter((m) => m.selectable);
  }

  /** Currently active model definition. */
  getCurrentModel(): ModelDefinition {
    const def = getModelRegistry().find((m) => m.id === this.currentModelId);
    if (!def) {
      // Check if this is a discovered/custom model that hasn't loaded yet.
      // Don't clobber currentModelId — return a placeholder so the saved ID is preserved
      // until the discovered provider registers later.
      const isBuiltin = BUILTIN_MODEL_REGISTRY.some((m) => m.id === this.currentModelId);
      if (!isBuiltin && this.currentModelId) {
        return {
          id: this.currentModelId,
          provider: config.provider ?? 'unknown',
          displayName: this.currentModelId,
          description: 'Waiting for provider discovery...',
          capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
          contextWindow: 0, // Unknown until provider discovery completes; 0 = no progress bar
          selectable: true,
          tier: 'standard' as ModelTier,
        };
      }
      // Builtin model not found — genuinely broken, fall back to first selectable
      const fallback = getModelRegistry().find((m) => m.selectable);
      if (fallback) {
        this.currentModelId = fallback.id;
        return fallback;
      }
      throw new Error(`Current model '${this.currentModelId}' not in registry.`);
    }
    return def;
  }

  /** Switch to a different model. Throws if the model is not selectable. */
  setCurrentModel(modelId: string): void {
    const def = getModelRegistry().find((m) => m.id === modelId);
    if (!def) throw new Error(`Model '${modelId}' not found.`);
    if (!def.selectable) throw new Error(`Model '${modelId}' is not selectable.`);
    this.currentModelId = modelId;
  }

  /**
   * Load custom providers from ~/.goodvibes/tui/providers/ and merge them
   * into the live model registry. Returns any warnings collected during loading.
   * Call this after construction to populate custom providers.
   */
  async loadCustomProviders(): Promise<{ warnings: string[]; added: string[]; removed: string[]; updated: string[] }> {
    const result = await loadCustomProviders();
    const previousIds = new Set(customModels.map((m) => m.id));
    const newIds = new Set(result.models.map((m) => m.id));

    const added: string[] = [];
    const removed: string[] = [];
    const updated: string[] = [];

    for (const id of newIds) {
      if (!previousIds.has(id)) {
        added.push(id);
      } else {
        // Only mark as updated if the model definition actually changed
        const oldModel = customModels.find((m) => m.id === id);
        const newModel = result.models.find((m) => m.id === id);
        if (stableStringify(oldModel) !== stableStringify(newModel)) {
          updated.push(id);
        }
      }
    }
    for (const id of previousIds) {
      if (!newIds.has(id)) removed.push(id);
    }

    // Warn about collisions with built-in models
    for (const model of result.models) {
      const isBuiltin = BUILTIN_MODEL_REGISTRY.some((b) => b.id === model.id);
      if (isBuiltin) {
        const msg = `[registry] Custom model '${model.id}' from provider '${model.provider}' overrides built-in model.`;
        result.warnings.push(msg);
        // Warning already added to result.warnings — don't console.warn (corrupts TUI)
      }
    }

    // Register provider instances
    for (const { provider } of result.providers) {
      this.register(provider);
    }

    // Swap custom models
    customModels = result.models;

    return { warnings: result.warnings, added, removed, updated };
  }

  /**
   * Start watching ~/.goodvibes/tui/providers/ for file changes.
   * On change, reloads custom providers and emits 'providers:changed' on the bus.
   * Safe to call multiple times — stops the previous watcher first.
   */
  startWatching(bus: EventBus): void {
    this.stopWatching();
    this._watcher = watchCustomProviders(bus, async () => {
      const result = await this.loadCustomProviders();
      for (const msg of result.warnings) {
        bus.emit('providers:warning', { message: msg });
      }
      bus.emit('providers:changed', {
        added: result.added,
        removed: result.removed,
        updated: result.updated,
      });
    });
  }

  /** Stop the file watcher started by startWatching(). */
  stopWatching(): void {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = undefined;
    }
  }

  private _watcher: { close: () => void } | undefined;

  /**
   * Returns a promise that resolves when the initial custom provider load
   * completes. Callers can await this before calling getForModel() with a
   * custom model ID to avoid a "model not found" race window.
   */
  ready(): Promise<void> {
    return this._readyPromise ?? Promise.resolve();
  }

  private _readyPromise: Promise<void> | null = null;

  /** Kick off async custom provider loading. Called once from singleton factory. */
  initCustomProviders(): void {
    this._readyPromise = this.loadCustomProviders()
      .then((result) => {
        // Warnings captured in result.warnings — don't console.warn (corrupts TUI)
        this._readyPromise = null;
      })
      .catch((err) => {
        // Non-fatal — don't console.warn (corrupts TUI display)
        this._readyPromise = null;
      });
  }
}

/**
 * Key-order-independent JSON serialisation used for model diff comparisons.
 * Recursively sorts object keys so that { a: 1, b: 2 } and { b: 2, a: 1 }
 * produce the same string.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  return '{' + sorted.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}

/** Lazy singleton — instantiated on first access. */
let _providerRegistry: ProviderRegistry | undefined;
export function getProviderRegistry(): ProviderRegistry {
  if (!_providerRegistry) {
    _providerRegistry = new ProviderRegistry();
    // Kick off custom provider loading asynchronously.
    // The registry is immediately usable with built-in providers; custom
    // providers will be available shortly after the first access.
    // Callers can await providerRegistry.ready() to wait for completion.
    _providerRegistry.initCustomProviders();
  }
  return _providerRegistry;
}
/** Reset singleton — for testing only. */
export function _resetProviderRegistryForTesting(): void {
  _providerRegistry = undefined;
  customModels = [];
  discoveredModels = [];
}

// Note: this Proxy only traps `get` and `has`. Direct property assignments
// and other traps (set, deleteProperty, etc.) are not forwarded — treat the
// providerRegistry export as read-only and call methods via the returned instance.
export const providerRegistry: ProviderRegistry = new Proxy({} as ProviderRegistry, {
  get(_target, prop: string | symbol) {
    const registry = getProviderRegistry();
    const value = (registry as unknown as Record<string | symbol, unknown>)[prop];
    // Bind methods to the singleton so `this` is correct when called via the proxy.
    if (typeof value === 'function') {
      return (value as Function).bind(registry);
    }
    return value;
  },
  has(_target, prop: string | symbol) {
    return prop in (getProviderRegistry() as unknown as Record<string | symbol, unknown>);
  },
});
