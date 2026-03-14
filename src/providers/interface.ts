import type { ToolDefinition, ToolCall } from '../types/tools.ts';

/** Contract all LLM providers must implement. */
export interface LLMProvider {
  readonly name: string;
  readonly models: string[];
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

/** A content part for multimodal messages (future Phase C). */
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
  /** Mercury-2 specific: controls reasoning depth. */
  reasoningEffort?: 'instant' | 'low' | 'medium' | 'high';
  /** Mercury-2 specific: whether to include a reasoning summary in the response. */
  reasoningSummary?: boolean;
  /** Called per-chunk during streaming when streaming is enabled. */
  onDelta?: (delta: StreamDelta) => void;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'error';
  /** Mercury-2 specific: condensed chain-of-thought, if requested. */
  reasoningSummary?: string;
}

export type ProviderMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; callId: string; content: string; name?: string };
