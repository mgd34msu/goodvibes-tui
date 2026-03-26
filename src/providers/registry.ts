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
  // --- AIHubMix (Free) ---
  // All models below are confirmed free ($0/M tokens) with rate limits:
  // 5 req/min, 250-500 req/day, 500K-1M tokens/day
  {
    id: 'gpt-4.1-free',
    provider: 'aihubmix',
    displayName: 'GPT-4.1 (Free)',
    description: 'Free GPT-4.1 via Azure. Content filter enforced.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'gpt-4.1-mini-free',
    provider: 'aihubmix',
    displayName: 'GPT-4.1 Mini (Free)',
    description: 'Free GPT-4.1 Mini via Azure. Content filter enforced.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'gpt-4.1-nano-free',
    provider: 'aihubmix',
    displayName: 'GPT-4.1 Nano (Free)',
    description: 'Free GPT-4.1 Nano via Azure. Content filter enforced.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 1000000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'gpt-4o-free',
    provider: 'aihubmix',
    displayName: 'GPT-4o (Free)',
    description: 'Free GPT-4o via Azure. Content filter enforced.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'gemini-2.0-flash-free',
    provider: 'aihubmix',
    displayName: 'Gemini 2.0 Flash (Free)',
    description: 'Free Gemini 2.0 Flash. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'gemini-3-flash-preview-free',
    provider: 'aihubmix',
    displayName: 'Gemini 3 Flash Preview (Free)',
    description: 'Free Gemini 3 Flash preview. 5 req/min, 250 req/day, 500K tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'gemini-3.1-flash-image-preview-free',
    provider: 'aihubmix',
    displayName: 'Gemini 3.1 Flash Image (Free)',
    description: 'Free Gemini 3.1 Flash image generation preview.',
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'glm-4.7-flash-free',
    provider: 'aihubmix',
    displayName: 'GLM-4.7 Flash (Free)',
    description: 'Free GLM-4.7 Flash. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 128000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'coding-glm-4.6-free',
    provider: 'aihubmix',
    displayName: 'Coding GLM-4.6 (Free)',
    description: 'Free coding-optimised GLM-4.6. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 200000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'coding-glm-4.7-free',
    provider: 'aihubmix',
    displayName: 'Coding GLM-4.7 (Free)',
    description: 'Free coding-optimised GLM-4.7. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 128000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'coding-glm-5-free',
    provider: 'aihubmix',
    displayName: 'Coding GLM-5 (Free)',
    description: 'Free coding-optimised GLM-5. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 128000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'coding-glm-5-turbo-free',
    provider: 'aihubmix',
    displayName: 'Coding GLM-5 Turbo (Free)',
    description: 'Free fast coding-optimised GLM-5. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 128000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'coding-minimax-m2-free',
    provider: 'aihubmix',
    displayName: 'Coding MiniMax M2 (Free)',
    description: 'Free coding-optimised MiniMax M2. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 204000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'coding-minimax-m2.1-free',
    provider: 'aihubmix',
    displayName: 'Coding MiniMax M2.1 (Free)',
    description: 'Free coding-optimised MiniMax M2.1. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 204000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'coding-minimax-m2.5-free',
    provider: 'aihubmix',
    displayName: 'Coding MiniMax M2.5 (Free)',
    description: 'Free coding-optimised MiniMax M2.5. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 204000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'coding-minimax-m2.7-free',
    provider: 'aihubmix',
    displayName: 'Coding MiniMax M2.7 (Free)',
    description: 'Free coding-optimised MiniMax M2.7. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 204000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'kimi-for-coding-free',
    provider: 'aihubmix',
    displayName: 'Kimi for Coding (Free)',
    description: 'Free Kimi coding model by Moonshot AI. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 256000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'mimo-v2-flash-free',
    provider: 'aihubmix',
    displayName: 'MiMo V2 Flash (Free)',
    description: 'Free Xiaomi MiMo V2 Flash. MoE 309B/15B active, 256K context, #1 open-source on SWE-bench.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 256000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'minimax-m2.5-free',
    provider: 'aihubmix',
    displayName: 'MiniMax M2.5 (Free)',
    description: 'Free MiniMax M2.5 via DaoCloud. 5 req/min, 500 req/day, 1M tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 204000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'step-3.5-flash-free',
    provider: 'aihubmix',
    displayName: 'Step 3.5 Flash (Free)',
    description: 'Free StepFun Step 3.5 Flash. 5 req/min, 250 req/day, 500K tokens/day.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 256000,
    selectable: true,
    tier: 'free',
  },

  // --- Groq ---
  // All models free (Groq LPU inference). Rate limits apply.
  {
    id: 'qwen/qwen3-32b',
    provider: 'groq',
    displayName: 'Qwen3 32B (Groq)',
    description: 'Alibaba Qwen3 32B on Groq LPU inference.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'openai/gpt-oss-120b',
    provider: 'groq',
    displayName: 'GPT-OSS 120B (Groq)',
    description: 'OpenAI open-source 120B model on Groq LPU inference.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'openai/gpt-oss-20b',
    provider: 'groq',
    displayName: 'GPT-OSS 20B (Groq)',
    description: 'OpenAI open-source 20B model on Groq LPU inference.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'moonshotai/kimi-k2-instruct',
    provider: 'groq',
    displayName: 'Kimi K2 Instruct (Groq)',
    description: 'Moonshot AI Kimi K2 on Groq LPU inference.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'moonshotai/kimi-k2-instruct-0905',
    provider: 'groq',
    displayName: 'Kimi K2 Instruct 0905 (Groq)',
    description: 'Moonshot AI Kimi K2 (Sept 2025) on Groq LPU inference. 262K context.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 262144,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'llama-3.3-70b-versatile',
    provider: 'groq',
    displayName: 'Llama 3.3 70B (Groq)',
    description: 'Meta Llama 3.3 70B on Groq LPU inference.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'llama-3.1-8b-instant',
    provider: 'groq',
    displayName: 'Llama 3.1 8B Instant (Groq)',
    description: 'Meta Llama 3.1 8B on Groq LPU inference. Ultra-fast.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'meta-llama/llama-4-scout-17b-16e-instruct',
    provider: 'groq',
    displayName: 'Llama 4 Scout 17B (Groq)',
    description: 'Meta Llama 4 Scout 17B MoE on Groq LPU inference.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'groq/compound',
    provider: 'groq',
    displayName: 'Compound (Groq)',
    description: 'Groq Compound agentic model with tool use and web search.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'groq/compound-mini',
    provider: 'groq',
    displayName: 'Compound Mini (Groq)',
    description: 'Groq Compound Mini — lightweight agentic model.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },

  // --- Cerebras ---
  // Free inference on Cerebras wafer-scale hardware. Rate limits apply.
  {
    id: 'llama3.1-8b',
    provider: 'cerebras',
    displayName: 'Llama 3.1 8B (Cerebras)',
    description: 'Meta Llama 3.1 8B on Cerebras wafer-scale inference. Ultra-fast.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'qwen-3-235b-a22b-instruct-2507',
    provider: 'cerebras',
    displayName: 'Qwen3 235B A22B (Cerebras)',
    description: 'Alibaba Qwen3 235B MoE (22B active) on Cerebras wafer-scale inference.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },

  // --- Mistral ---
  {
    id: 'mistral-large-latest',
    provider: 'mistral',
    displayName: 'Mistral Large',
    description: 'Mistral flagship model. 262K context, vision, tool use.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
    contextWindow: 262144,
    selectable: true,
    tier: 'premium',
  },
  {
    id: 'mistral-medium-latest',
    provider: 'mistral',
    displayName: 'Mistral Medium',
    description: 'Mistral frontier-class multimodal model with tool use.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
    contextWindow: 131072,
    selectable: true,
    tier: 'standard',
  },
  {
    id: 'mistral-small-latest',
    provider: 'mistral',
    displayName: 'Mistral Small 4',
    description: 'Mistral Small 4 with reasoning, vision, and tool use.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 262144,
    selectable: true,
    tier: 'standard',
  },
  {
    id: 'codestral-latest',
    provider: 'mistral',
    displayName: 'Codestral',
    description: 'Mistral cutting-edge code model. 256K context, FIM support.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 256000,
    selectable: true,
    tier: 'standard',
  },
  {
    id: 'devstral-latest',
    provider: 'mistral',
    displayName: 'Devstral',
    description: 'Mistral code-agentic model. 262K context.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 262144,
    selectable: true,
    tier: 'standard',
  },
  {
    id: 'devstral-medium-latest',
    provider: 'mistral',
    displayName: 'Devstral Medium',
    description: 'Mistral medium code-agentic model.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 262144,
    selectable: true,
    tier: 'standard',
  },
  {
    id: 'devstral-small-latest',
    provider: 'mistral',
    displayName: 'Devstral Small',
    description: 'Mistral small open-source code-agentic model with vision.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
    contextWindow: 262144,
    selectable: true,
    tier: 'standard',
  },
  {
    id: 'magistral-medium-latest',
    provider: 'mistral',
    displayName: 'Magistral Medium',
    description: 'Mistral frontier-class reasoning model with vision.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 131072,
    selectable: true,
    tier: 'premium',
  },
  {
    id: 'magistral-small-latest',
    provider: 'mistral',
    displayName: 'Magistral Small',
    description: 'Mistral efficient reasoning model with vision.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 131072,
    selectable: true,
    tier: 'standard',
  },
  {
    id: 'ministral-14b-latest',
    provider: 'mistral',
    displayName: 'Ministral 14B',
    description: 'Mistral Tinystral 14B with vision and tool use.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: true },
    contextWindow: 262144,
    selectable: true,
    tier: 'standard',
  },
  {
    id: 'ministral-8b-latest',
    provider: 'mistral',
    displayName: 'Ministral 8B',
    description: 'Mistral Tinystral 8B with vision and tool use.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: true },
    contextWindow: 262144,
    selectable: true,
    tier: 'standard',
  },
  {
    id: 'ministral-3b-latest',
    provider: 'mistral',
    displayName: 'Ministral 3B',
    description: 'Mistral Tinystral 3B — ultra-lightweight with vision.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: true },
    contextWindow: 131072,
    selectable: true,
    tier: 'standard',
  },
  {
    id: 'pixtral-large-latest',
    provider: 'mistral',
    displayName: 'Pixtral Large',
    description: 'Mistral large vision-language model with tool use.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
    contextWindow: 131072,
    selectable: true,
    tier: 'premium',
  },
  {
    id: 'open-mistral-nemo',
    provider: 'mistral',
    displayName: 'Mistral Nemo',
    description: 'Mistral open-source multilingual model. 131K context.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'standard',
  },

  // --- Ollama Cloud ---
  // Free hosted inference via ollama.com. All models free with rate limits.
  {
    id: 'deepseek-v3.2',
    provider: 'ollama-cloud',
    displayName: 'DeepSeek V3.2 (Ollama)',
    description: 'DeepSeek V3.2 on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'deepseek-v3.1:671b',
    provider: 'ollama-cloud',
    displayName: 'DeepSeek V3.1 671B (Ollama)',
    description: 'DeepSeek V3.1 MoE 671B on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'cogito-2.1:671b',
    provider: 'ollama-cloud',
    displayName: 'Cogito 2.1 671B (Ollama)',
    description: 'Deep Cogito 2.1 reasoning model, 671B on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'qwen3.5:397b',
    provider: 'ollama-cloud',
    displayName: 'Qwen 3.5 397B (Ollama)',
    description: 'Alibaba Qwen 3.5 397B MoE on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'qwen3-coder:480b',
    provider: 'ollama-cloud',
    displayName: 'Qwen3 Coder 480B (Ollama)',
    description: 'Alibaba Qwen3 Coder 480B MoE on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'qwen3-coder-next',
    provider: 'ollama-cloud',
    displayName: 'Qwen3 Coder Next (Ollama)',
    description: 'Alibaba Qwen3 Coder Next on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'qwen3-next:80b',
    provider: 'ollama-cloud',
    displayName: 'Qwen3 Next 80B (Ollama)',
    description: 'Alibaba Qwen3 Next 80B MoE on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'qwen3-vl:235b',
    provider: 'ollama-cloud',
    displayName: 'Qwen3 VL 235B (Ollama)',
    description: 'Alibaba Qwen3 Vision-Language 235B MoE on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'qwen3-vl:235b-instruct',
    provider: 'ollama-cloud',
    displayName: 'Qwen3 VL 235B Instruct (Ollama)',
    description: 'Alibaba Qwen3 VL 235B Instruct on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'kimi-k2:1t',
    provider: 'ollama-cloud',
    displayName: 'Kimi K2 1T (Ollama)',
    description: 'Moonshot AI Kimi K2 1T MoE on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'kimi-k2-thinking',
    provider: 'ollama-cloud',
    displayName: 'Kimi K2 Thinking (Ollama)',
    description: 'Moonshot AI Kimi K2 with extended reasoning on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'kimi-k2.5',
    provider: 'ollama-cloud',
    displayName: 'Kimi K2.5 (Ollama)',
    description: 'Moonshot AI Kimi K2.5 on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'mistral-large-3:675b',
    provider: 'ollama-cloud',
    displayName: 'Mistral Large 3 675B (Ollama)',
    description: 'Mistral Large 3 675B on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'devstral-2:123b',
    provider: 'ollama-cloud',
    displayName: 'Devstral 2 123B (Ollama)',
    description: 'Mistral Devstral 2 123B code-agentic model on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'devstral-small-2:24b',
    provider: 'ollama-cloud',
    displayName: 'Devstral Small 2 24B (Ollama)',
    description: 'Mistral Devstral Small 2 24B on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'ministral-3:14b',
    provider: 'ollama-cloud',
    displayName: 'Ministral 3 14B (Ollama)',
    description: 'Mistral Ministral 3 14B on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'ministral-3:8b',
    provider: 'ollama-cloud',
    displayName: 'Ministral 3 8B (Ollama)',
    description: 'Mistral Ministral 3 8B on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'ministral-3:3b',
    provider: 'ollama-cloud',
    displayName: 'Ministral 3 3B (Ollama)',
    description: 'Mistral Ministral 3 3B on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'gemini-3-flash-preview',
    provider: 'ollama-cloud',
    displayName: 'Gemini 3 Flash Preview (Ollama)',
    description: 'Google Gemini 3 Flash Preview on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 1000000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'gemma3:27b',
    provider: 'ollama-cloud',
    displayName: 'Gemma 3 27B (Ollama)',
    description: 'Google Gemma 3 27B on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: true },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'gemma3:12b',
    provider: 'ollama-cloud',
    displayName: 'Gemma 3 12B (Ollama)',
    description: 'Google Gemma 3 12B on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: true },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'gemma3:4b',
    provider: 'ollama-cloud',
    displayName: 'Gemma 3 4B (Ollama)',
    description: 'Google Gemma 3 4B on Ollama Cloud.',
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: true },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'glm-4.6',
    provider: 'ollama-cloud',
    displayName: 'GLM-4.6 (Ollama)',
    description: 'Zhipu GLM-4.6 on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'glm-4.7',
    provider: 'ollama-cloud',
    displayName: 'GLM-4.7 (Ollama)',
    description: 'Zhipu GLM-4.7 on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'glm-5',
    provider: 'ollama-cloud',
    displayName: 'GLM-5 (Ollama)',
    description: 'Zhipu GLM-5 on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'gpt-oss:120b',
    provider: 'ollama-cloud',
    displayName: 'GPT-OSS 120B (Ollama)',
    description: 'OpenAI open-source 120B on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'gpt-oss:20b',
    provider: 'ollama-cloud',
    displayName: 'GPT-OSS 20B (Ollama)',
    description: 'OpenAI open-source 20B on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'minimax-m2',
    provider: 'ollama-cloud',
    displayName: 'MiniMax M2 (Ollama)',
    description: 'MiniMax M2 on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 204000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'minimax-m2.1',
    provider: 'ollama-cloud',
    displayName: 'MiniMax M2.1 (Ollama)',
    description: 'MiniMax M2.1 on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 204000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'minimax-m2.5',
    provider: 'ollama-cloud',
    displayName: 'MiniMax M2.5 (Ollama)',
    description: 'MiniMax M2.5 on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 204000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'minimax-m2.7',
    provider: 'ollama-cloud',
    displayName: 'MiniMax M2.7 (Ollama)',
    description: 'MiniMax M2.7 on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 204000,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'nemotron-3-super',
    provider: 'ollama-cloud',
    displayName: 'Nemotron 3 Super (Ollama)',
    description: 'NVIDIA Nemotron 3 Super on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'nemotron-3-nano:30b',
    provider: 'ollama-cloud',
    displayName: 'Nemotron 3 Nano 30B (Ollama)',
    description: 'NVIDIA Nemotron 3 Nano 30B on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
  },
  {
    id: 'rnj-1:8b',
    provider: 'ollama-cloud',
    displayName: 'RNJ-1 8B (Ollama)',
    description: 'RNJ-1 8B model on Ollama Cloud.',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 131072,
    selectable: true,
    tier: 'free',
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

    this.register(
      new OpenAICompatProvider({
        name: 'aihubmix',
        baseURL: 'https://aihubmix.com/v1',
        apiKey: apiKey('aihubmix'),
        defaultModel: 'gpt-4.1-free',
        models: [
          'gpt-4.1-free', 'gpt-4.1-mini-free', 'gpt-4.1-nano-free', 'gpt-4o-free',
          'gemini-2.0-flash-free', 'gemini-3-flash-preview-free', 'gemini-3.1-flash-image-preview-free',
          'glm-4.7-flash-free',
          'coding-glm-4.6-free', 'coding-glm-4.7-free', 'coding-glm-5-free', 'coding-glm-5-turbo-free',
          'coding-minimax-m2-free', 'coding-minimax-m2.1-free', 'coding-minimax-m2.5-free', 'coding-minimax-m2.7-free',
          'kimi-for-coding-free', 'mimo-v2-flash-free', 'minimax-m2.5-free', 'step-3.5-flash-free',
        ],
        reasoningFormat: 'none',
      }),
    );

    this.register(
      new OpenAICompatProvider({
        name: 'groq',
        baseURL: 'https://api.groq.com/openai/v1',
        apiKey: apiKey('groq'),
        defaultModel: 'qwen/qwen3-32b',
        models: [
          'qwen/qwen3-32b',
          'openai/gpt-oss-120b', 'openai/gpt-oss-20b',
          'moonshotai/kimi-k2-instruct', 'moonshotai/kimi-k2-instruct-0905',
          'llama-3.3-70b-versatile', 'llama-3.1-8b-instant',
          'meta-llama/llama-4-scout-17b-16e-instruct',
          'groq/compound', 'groq/compound-mini',
        ],
        reasoningFormat: 'none',
      }),
    );

    this.register(
      new OpenAICompatProvider({
        name: 'cerebras',
        baseURL: 'https://api.cerebras.ai/v1',
        apiKey: apiKey('cerebras'),
        defaultModel: 'qwen-3-235b-a22b-instruct-2507',
        models: ['llama3.1-8b', 'qwen-3-235b-a22b-instruct-2507'],
        reasoningFormat: 'none',
      }),
    );

    this.register(
      new OpenAICompatProvider({
        name: 'mistral',
        baseURL: 'https://api.mistral.ai/v1',
        apiKey: apiKey('mistral'),
        defaultModel: 'mistral-large-latest',
        models: [
          'mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest',
          'codestral-latest', 'devstral-latest', 'devstral-medium-latest', 'devstral-small-latest',
          'magistral-medium-latest', 'magistral-small-latest',
          'ministral-14b-latest', 'ministral-8b-latest', 'ministral-3b-latest',
          'pixtral-large-latest', 'open-mistral-nemo',
        ],
        reasoningFormat: 'none',
      }),
    );

    this.register(
      new OpenAICompatProvider({
        name: 'ollama-cloud',
        baseURL: 'https://ollama.com/v1',
        apiKey: apiKey('ollama-cloud'),
        defaultModel: 'deepseek-v3.2',
        models: [
          'deepseek-v3.2', 'deepseek-v3.1:671b', 'cogito-2.1:671b',
          'qwen3.5:397b', 'qwen3-coder:480b', 'qwen3-coder-next', 'qwen3-next:80b',
          'qwen3-vl:235b', 'qwen3-vl:235b-instruct',
          'kimi-k2:1t', 'kimi-k2-thinking', 'kimi-k2.5',
          'mistral-large-3:675b', 'devstral-2:123b', 'devstral-small-2:24b',
          'ministral-3:14b', 'ministral-3:8b', 'ministral-3:3b',
          'gemini-3-flash-preview', 'gemma3:27b', 'gemma3:12b', 'gemma3:4b',
          'glm-4.6', 'glm-4.7', 'glm-5',
          'gpt-oss:120b', 'gpt-oss:20b',
          'minimax-m2', 'minimax-m2.1', 'minimax-m2.5', 'minimax-m2.7',
          'nemotron-3-super', 'nemotron-3-nano:30b',
          'rnj-1:8b',
        ],
        reasoningFormat: 'none',
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
          contextWindow: server.modelContextWindows?.[modelId] ?? 8192,
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
