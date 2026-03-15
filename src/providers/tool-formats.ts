import type { ToolDefinition, ToolCall } from '../types/tools.ts';
import type { ProviderMessage, ContentPart } from './interface.ts';

// ---------------------------------------------------------------------------
// OpenAI wire format
// ---------------------------------------------------------------------------

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

/** Convert internal ToolDefinitions to OpenAI tools array. */
export function toOpenAITools(tools: ToolDefinition[]): OpenAITool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** Parse OpenAI tool_calls from a response into internal ToolCall[]. */
export function fromOpenAIToolCalls(calls: OpenAIToolCall[]): ToolCall[] {
  return calls.map((c) => ({
    id: c.id,
    name: c.function.name,
    arguments: parseJson(c.function.arguments),
  }));
}

/** Convert internal ProviderMessages to OpenAI message array. */
export function toOpenAIMessages(
  messages: ProviderMessage[],
  systemPrompt?: string,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (Array.isArray(msg.content)) {
        // ContentPart[] — convert to OpenAI multimodal parts
        const parts: OpenAIContentPart[] = msg.content.map((part: ContentPart) => {
          if (part.type === 'text') return { type: 'text', text: part.text };
          return { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } };
        });
        result.push({ role: 'user', content: parts });
      } else {
        result.push({ role: 'user', content: msg.content });
      }
    } else if (msg.role === 'assistant') {
      const m: OpenAIMessage = { role: 'assistant', content: msg.content || null };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        m.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      result.push(m);
    } else if (msg.role === 'tool') {
      result.push({
        role: 'tool',
        content: msg.content,
        tool_call_id: msg.callId,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Anthropic wire format
// ---------------------------------------------------------------------------

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

/** Convert internal ToolDefinitions to Anthropic tools array. */
export function toAnthropicTools(tools: ToolDefinition[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

/** Parse Anthropic response content blocks into text + ToolCall[]. */
export function fromAnthropicContent(content: AnthropicContentBlock[]): {
  text: string;
  toolCalls: ToolCall[];
} {
  let text = '';
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
    }
  }

  return { text, toolCalls };
}

/** Convert internal ProviderMessages to Anthropic message array. */
export function toAnthropicMessages(messages: ProviderMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  // Collect consecutive tool results to merge into one user message
  let pendingToolResults: AnthropicContentBlock[] = [];

  function flushToolResults(): void {
    if (pendingToolResults.length > 0) {
      result.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      flushToolResults();
      if (Array.isArray(msg.content)) {
        // ContentPart[] — convert to Anthropic content blocks
        const blocks: AnthropicContentBlock[] = msg.content.map((part: ContentPart) => {
          if (part.type === 'text') return { type: 'text' as const, text: part.text };
          return {
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: part.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: part.data },
          };
        });
        result.push({ role: 'user', content: blocks });
      } else {
        result.push({ role: 'user', content: msg.content });
      }
    } else if (msg.role === 'assistant') {
      flushToolResults();
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const blocks: AnthropicContentBlock[] = [];
        if (msg.content) blocks.push({ type: 'text', text: msg.content });
        for (const tc of msg.toolCalls) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
        }
        result.push({ role: 'assistant', content: blocks });
      } else {
        result.push({ role: 'assistant', content: msg.content });
      }
    } else if (msg.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: msg.callId,
        content: msg.content,
      });
    }
  }

  flushToolResults();
  return result;
}

// ---------------------------------------------------------------------------
// Gemini wire format
// ---------------------------------------------------------------------------

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content: string } };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/** Convert internal ToolDefinitions to Gemini functionDeclarations. */
export function toGeminiFunctionDeclarations(
  tools: ToolDefinition[],
): GeminiFunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/** Parse Gemini response parts into text + ToolCall[]. */
export function fromGeminiParts(parts: GeminiPart[]): {
  text: string;
  toolCalls: ToolCall[];
} {
  let text = '';
  const toolCalls: ToolCall[] = [];

  for (const part of parts) {
    if (part.text) {
      text += part.text;
    } else if (part.functionCall) {
      toolCalls.push({
        id: crypto.randomUUID(),
        name: part.functionCall.name,
        arguments: part.functionCall.args,
      });
    }
  }

  return { text, toolCalls };
}

/** Convert internal ProviderMessages to Gemini contents array. */
export function toGeminiContents(
  messages: ProviderMessage[],
  systemPrompt?: string,
): { contents: GeminiContent[]; systemInstruction?: { parts: GeminiPart[] } } {
  const contents: GeminiContent[] = [];
  const systemInstruction = systemPrompt
    ? { parts: [{ text: systemPrompt }] }
    : undefined;

  let pendingFunctionResponses: GeminiPart[] = [];

  function flushFunctionResponses(): void {
    if (pendingFunctionResponses.length > 0) {
      contents.push({ role: 'user', parts: pendingFunctionResponses });
      pendingFunctionResponses = [];
    }
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      flushFunctionResponses();
      if (Array.isArray(msg.content)) {
        // ContentPart[] — convert to Gemini parts
        const parts: GeminiPart[] = msg.content.map((part: ContentPart) => {
          if (part.type === 'text') return { text: part.text };
          return { inlineData: { mimeType: part.mediaType, data: part.data } };
        });
        contents.push({ role: 'user', parts });
      } else {
        contents.push({ role: 'user', parts: [{ text: msg.content }] });
      }
    } else if (msg.role === 'assistant') {
      flushFunctionResponses();
      const parts: GeminiPart[] = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
        }
      }
      contents.push({ role: 'model', parts });
    } else if (msg.role === 'tool') {
      pendingFunctionResponses.push({
        functionResponse: {
          name: msg.name ?? msg.callId,
          response: { content: msg.content },
        },
      });
    }
  }

  flushFunctionResponses();
  return { contents, systemInstruction };
}

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

function parseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    // Logger import would create circular dep; use console for this low-level utility
    console.warn('[tool-formats] Failed to parse tool argument JSON:', raw.slice(0, 200));
    return {};
  }
}
