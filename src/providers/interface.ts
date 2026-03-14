import type { ToolDefinition, ToolCall } from '../types/tools.ts';

/** Contract all LLM providers must implement. */
export interface LLMProvider {
  readonly name: string;
  readonly models: string[];
  chat(params: ChatRequest): Promise<ChatResponse>;
}

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
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'error';
  /** Mercury-2 specific: condensed chain-of-thought, if requested. */
  reasoningSummary?: string;
}

export type ProviderMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; callId: string; content: string };
