export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface SendMessageParams {
  messages: { role: string; content: string }[];
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface StreamingResponse {
  content: string;
  usage: TokenUsage;
}

/**
 * LLMProvider - Interface for AI backends.
 */
export interface LLMProvider {
  sendMessage(params: SendMessageParams): Promise<StreamingResponse>;
}
