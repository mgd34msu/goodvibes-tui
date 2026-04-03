import type { ToolDefinition, ToolCall } from '../types/tools.ts';
import type { ProviderCapability } from './capabilities.ts';

/** Shared budget token map for reasoning effort levels. */
export const REASONING_BUDGET_MAP: Record<string, number> = {
  instant: 0,
  low: 2048,
  medium: 8192,
  high: 32768,
};

/** Contract all LLM providers must implement. */
export interface LLMProvider {
  readonly name: string;
  readonly models: string[];
  /**
   * Optional self-declared capability overrides for this provider instance.
   * When present, these take precedence over the built-in `PROVIDER_DEFAULTS`
   * table in `capabilities.ts` but are overridden by per-model `MODEL_OVERRIDES`.
   *
   * @remarks Useful for custom / dynamically-discovered providers that know
   * their own capabilities and want to participate in explainable routing.
   */
  readonly capabilities?: Partial<ProviderCapability>;
  chat(params: ChatRequest): Promise<ChatResponse>;
}

/** Incremental tool call data received during streaming. */
export interface PartialToolCall {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;  // Partial JSON string
}

/** A single streaming delta from the provider. */
export interface StreamDelta {
  content?: string;           // Text content delta
  toolCalls?: PartialToolCall[];  // Incremental tool call data
  reasoning?: string;         // Reasoning/thinking delta
}

/** Content part for multimodal messages. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mediaType: string };

export interface ChatRequest {
  messages: ProviderMessage[];
  tools?: ToolDefinition[];
  model: string;
  maxTokens?: number;
  signal?: AbortSignal;
  systemPrompt?: string;
  /** Controls reasoning depth for models that support it. Format varies by provider. */
  reasoningEffort?: 'instant' | 'low' | 'medium' | 'high';
  /** Mercury-2 specific: whether to include a reasoning summary in the response. */
  reasoningSummary?: boolean;
  /** Called per-chunk during streaming when streaming is enabled. */
  onDelta?: (delta: StreamDelta) => void;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: {
    inputTokens: number;       // Billed input tokens (excludes cache tokens on Anthropic)
    outputTokens: number;
    cacheReadTokens?: number;  // Anthropic: tokens read from prompt cache
    cacheWriteTokens?: number; // Anthropic: tokens written to prompt cache
  };
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'error';
  /** Mercury-2 specific: condensed chain-of-thought, if requested. */
  reasoningSummary?: string;
  /**
   * Cache metrics for this response.
   * @remarks Currently only populated by the Anthropic provider. Other providers return `undefined`.
   */
  cacheMetrics?: {
    strategy: string;           // e.g. 'explicit-4bp', 'automatic', 'implicit', 'none'
    breakpointsPlaced: number;
    hitRate?: number;           // Computed from this response's usage
  };
}

export type ProviderMessage =
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; callId: string; content: string; name?: string };
