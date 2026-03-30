import { describe, test, expect } from 'bun:test';
import {
  toOpenAITools,
  fromOpenAIToolCalls,
  toOpenAIMessages,
  toAnthropicTools,
  fromAnthropicContent,
  toAnthropicMessages,
  toGeminiFunctionDeclarations,
  fromGeminiParts,
  toGeminiContents,
  extractTextToolCalls,
} from '../../providers/tool-formats.ts';
import type { ToolDefinition, ToolCall } from '../../types/tools.ts';
import type { ProviderMessage } from '../../providers/interface.ts';

const sampleTool: ToolDefinition = {
  name: 'file_read',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

const sampleToolCall: ToolCall = {
  id: 'call-1',
  name: 'file_read',
  arguments: { path: 'src/main.ts' },
};

// ---------------------------------------------------------------------------
// OpenAI format
// ---------------------------------------------------------------------------
describe('toOpenAITools', () => {
  test('converts tool definition to OpenAI tool format', () => {
    const [result] = toOpenAITools([sampleTool]);
    expect(result.type).toBe('function');
    expect(result.function.name).toBe('file_read');
    expect(result.function.description).toBe('Read a file');
    expect(result.function.parameters).toBe(sampleTool.parameters);
  });

  test('handles empty tools array', () => {
    expect(toOpenAITools([])).toEqual([]);
  });

  test('converts multiple tools', () => {
    const tools = [
      sampleTool,
      { name: 'file_write', description: 'Write a file', parameters: {} },
    ];
    const result = toOpenAITools(tools);
    expect(result).toHaveLength(2);
    expect(result[1].function.name).toBe('file_write');
  });
});

describe('fromOpenAIToolCalls', () => {
  test('parses OpenAI tool calls into internal ToolCall format', () => {
    const openAICalls = [
      { id: 'c1', type: 'function' as const, function: { name: 'file_read', arguments: '{"path":"foo.ts"}' } },
    ];
    const [result] = fromOpenAIToolCalls(openAICalls);
    expect(result.id).toBe('c1');
    expect(result.name).toBe('file_read');
    expect(result.arguments).toEqual({ path: 'foo.ts' });
  });

  test('handles malformed JSON arguments gracefully', () => {
    const openAICalls = [
      { id: 'c2', type: 'function' as const, function: { name: 'tool', arguments: 'not-json' } },
    ];
    const [result] = fromOpenAIToolCalls(openAICalls);
    expect(result.arguments).toEqual({});
  });
});

describe('toOpenAIMessages', () => {
  test('converts user message', () => {
    const msgs: ProviderMessage[] = [{ role: 'user', content: 'hello' }];
    const [result] = toOpenAIMessages(msgs);
    expect(result.role).toBe('user');
    expect(result.content).toBe('hello');
  });

  test('injects system prompt at start when provided', () => {
    const msgs: ProviderMessage[] = [{ role: 'user', content: 'hi' }];
    const result = toOpenAIMessages(msgs, 'Be helpful.');
    expect(result[0].role).toBe('system');
    expect(result[0].content).toBe('Be helpful.');
    expect(result[1].role).toBe('user');
  });

  test('converts assistant message with tool calls', () => {
    const msgs: ProviderMessage[] = [{
      role: 'assistant',
      content: 'calling tool',
      toolCalls: [sampleToolCall],
    }];
    const [result] = toOpenAIMessages(msgs);
    expect(result.role).toBe('assistant');
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls![0].function.name).toBe('file_read');
  });

  test('converts tool result messages', () => {
    const msgs: ProviderMessage[] = [
      { role: 'tool', callId: 'c1', content: 'file content' },
    ];
    const [result] = toOpenAIMessages(msgs);
    expect(result.role).toBe('tool');
    expect(result.tool_call_id).toBe('c1');
    expect(result.content).toBe('file content');
  });

  test('assistant with no tool calls has null tool_calls', () => {
    const msgs: ProviderMessage[] = [{ role: 'assistant', content: 'done' }];
    const [result] = toOpenAIMessages(msgs);
    expect(result.tool_calls).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Anthropic format
// ---------------------------------------------------------------------------
describe('toAnthropicTools', () => {
  test('converts tool to Anthropic format with input_schema', () => {
    const [result] = toAnthropicTools([sampleTool]);
    expect(result.name).toBe('file_read');
    expect(result.description).toBe('Read a file');
    expect(result.input_schema).toBe(sampleTool.parameters);
  });
});

describe('fromAnthropicContent', () => {
  test('extracts text from text blocks', () => {
    const content = [{ type: 'text' as const, text: 'hello world' }];
    const { text, toolCalls } = fromAnthropicContent(content);
    expect(text).toBe('hello world');
    expect(toolCalls).toHaveLength(0);
  });

  test('extracts tool_use blocks as ToolCalls', () => {
    const content = [{
      type: 'tool_use' as const,
      id: 'tu-1',
      name: 'file_read',
      input: { path: 'src/main.ts' },
    }];
    const { text, toolCalls } = fromAnthropicContent(content);
    expect(text).toBe('');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({ id: 'tu-1', name: 'file_read', arguments: { path: 'src/main.ts' } });
  });

  test('handles mixed text and tool_use blocks', () => {
    const content = [
      { type: 'text' as const, text: 'I will read the file.' },
      { type: 'tool_use' as const, id: 'tu-2', name: 'file_read', input: {} },
    ];
    const { text, toolCalls } = fromAnthropicContent(content);
    expect(text).toBe('I will read the file.');
    expect(toolCalls).toHaveLength(1);
  });
});

describe('toAnthropicMessages', () => {
  test('converts user message to string content', () => {
    const msgs: ProviderMessage[] = [{ role: 'user', content: 'hi' }];
    const [result] = toAnthropicMessages(msgs);
    expect(result.role).toBe('user');
    expect(result.content).toBe('hi');
  });

  test('merges consecutive tool results into one user message', () => {
    const msgs: ProviderMessage[] = [
      { role: 'assistant', content: '', toolCalls: [sampleToolCall] },
      { role: 'tool', callId: 'call-1', content: 'file content' },
      { role: 'tool', callId: 'call-2', content: 'other content' },
    ];
    const result = toAnthropicMessages(msgs);
    // Last message should be a user message with two tool_result blocks
    const last = result[result.length - 1];
    expect(last.role).toBe('user');
    expect(Array.isArray(last.content)).toBe(true);
    const blocks = last.content as Array<{ type: string }>;
    expect(blocks.filter((b) => b.type === 'tool_result')).toHaveLength(2);
  });

  test('assistant with tool calls becomes content blocks', () => {
    const msgs: ProviderMessage[] = [{
      role: 'assistant',
      content: 'calling tool',
      toolCalls: [sampleToolCall],
    }];
    const [result] = toAnthropicMessages(msgs);
    expect(result.role).toBe('assistant');
    expect(Array.isArray(result.content)).toBe(true);
    const blocks = result.content as Array<{ type: string }>;
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gemini format
// ---------------------------------------------------------------------------
describe('toGeminiFunctionDeclarations', () => {
  test('converts tool to Gemini function declaration', () => {
    const [result] = toGeminiFunctionDeclarations([sampleTool]);
    expect(result.name).toBe('file_read');
    expect(result.description).toBe('Read a file');
    expect(result.parameters).toEqual(sampleTool.parameters);
  });
});

describe('fromGeminiParts', () => {
  test('extracts text from text parts', () => {
    const parts = [{ text: 'response text' }];
    const { text, toolCalls } = fromGeminiParts(parts);
    expect(text).toBe('response text');
    expect(toolCalls).toHaveLength(0);
  });

  test('extracts functionCall parts as ToolCalls', () => {
    const parts = [{ functionCall: { name: 'file_read', args: { path: 'main.ts' } } }];
    const { text, toolCalls } = fromGeminiParts(parts);
    expect(text).toBe('');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('file_read');
    expect(toolCalls[0].arguments).toEqual({ path: 'main.ts' });
  });

  test('assigns a UUID to each tool call', () => {
    const parts = [{ functionCall: { name: 'tool', args: {} } }];
    const { toolCalls } = fromGeminiParts(parts);
    expect(typeof toolCalls[0].id).toBe('string');
    expect(toolCalls[0].id.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// extractTextToolCalls
// ---------------------------------------------------------------------------
describe('extractTextToolCalls', () => {
  // Without-underscore format (original)
  const sentinel = '<|toolcallbegin|>';
  const argBegin = '<|toolcallargumentbegin|>';
  const end = '<|toolcallend|>';

  // With-underscore format (actual kimi output)
  const sentinelU = '<|tool_call_begin|>';
  const argBeginU = '<|tool_call_argument_begin|>';
  const endU = '<|tool_call_end|>';
  const sectionEndU = '<|tool_calls_section_end|>';

  function makeCall(name: string, index: number, args: string): string {
    return `${sentinel}functions.${name}:${index}${argBegin}${args}${end}`;
  }

  function makeCallU(name: string, index: number, args: string): string {
    return `${sentinelU}functions.${name}:${index}${argBeginU}${args}${endU}`;
  }

  test('fast path: returns empty array and unchanged content when sentinel absent', () => {
    const content = 'Hello, world!';
    const { toolCalls, cleanedContent } = extractTextToolCalls(content);
    expect(toolCalls).toEqual([]);
    expect(cleanedContent).toBe(content);
  });

  test('extracts a single tool call with name, parsed args, and generated id', () => {
    const content = makeCall('file_read', 0, '{"path":"src/main.ts"}');
    const { toolCalls, cleanedContent } = extractTextToolCalls(content);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('file_read');
    expect(toolCalls[0].arguments).toEqual({ path: 'src/main.ts' });
    expect(toolCalls[0].id).toBe('text-call-0');
    expect(cleanedContent).toBe('');
  });

  test('extracts multiple tool calls in one response', () => {
    const content = [
      makeCall('file_read', 0, '{"path":"a.ts"}'),
      makeCall('file_write', 1, '{"path":"b.ts","content":"x"}'),
    ].join(' ');
    const { toolCalls, cleanedContent } = extractTextToolCalls(content);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].name).toBe('file_read');
    expect(toolCalls[0].id).toBe('text-call-0');
    expect(toolCalls[1].name).toBe('file_write');
    expect(toolCalls[1].id).toBe('text-call-1');
    expect(cleanedContent).toBe('');
  });

  test('returns {} arguments for malformed JSON', () => {
    const content = makeCall('bad_tool', 0, 'not-valid-json');
    const { toolCalls } = extractTextToolCalls(content);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].arguments).toEqual({});
  });

  test('removes tool-call tokens and trims surrounding content', () => {
    const content = `Thinking... ${makeCall('file_read', 0, '{"path":"x"}')} Done.`;
    const { cleanedContent } = extractTextToolCalls(content);
    expect(cleanedContent).toBe('Thinking...  Done.');
  });

  test('handles empty string input', () => {
    const { toolCalls, cleanedContent } = extractTextToolCalls('');
    expect(toolCalls).toEqual([]);
    expect(cleanedContent).toBe('');
  });

  test('partial delimiter: sentinel present but no full match returns empty array', () => {
    const content = `${sentinel}functions.incomplete_call`;
    const { toolCalls, cleanedContent } = extractTextToolCalls(content);
    expect(toolCalls).toEqual([]);
    // Content is not cleaned since no full match was found
    expect(cleanedContent).toBe(content.trim());
  });

  // ---------------------------------------------------------------------------
  // Underscore-format variants (actual kimi output)
  // ---------------------------------------------------------------------------

  test('underscore format: extracts a single tool call', () => {
    const content = makeCallU('delegate', 0, '{"task":"do something"}');
    const { toolCalls, cleanedContent } = extractTextToolCalls(content);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('delegate');
    expect(toolCalls[0].arguments).toEqual({ task: 'do something' });
    expect(toolCalls[0].id).toBe('text-call-0');
    expect(cleanedContent).toBe('');
  });

  test('underscore format: strips trailing <|tool_calls_section_end|>', () => {
    const content = `${makeCallU('file_read', 0, '{"path":"x"}')}${sectionEndU}`;
    const { toolCalls, cleanedContent } = extractTextToolCalls(content);
    expect(toolCalls).toHaveLength(1);
    expect(cleanedContent).toBe('');
  });

  test('underscore format: strips section-end and surrounding text', () => {
    const content = `Thinking... ${makeCallU('file_read', 0, '{"path":"y"}')}${sectionEndU} Done.`;
    const { toolCalls, cleanedContent } = extractTextToolCalls(content);
    expect(toolCalls).toHaveLength(1);
    expect(cleanedContent).toBe('Thinking...  Done.');
  });

  test('underscore format: extracts multiple tool calls', () => {
    const content = [
      makeCallU('file_read', 0, '{"path":"a.ts"}'),
      makeCallU('file_write', 1, '{"path":"b.ts","content":"x"}'),
    ].join(' ') + sectionEndU;
    const { toolCalls, cleanedContent } = extractTextToolCalls(content);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].name).toBe('file_read');
    expect(toolCalls[1].name).toBe('file_write');
    expect(cleanedContent).toBe('');
  });

  test('underscore format: fast path returns empty when neither sentinel present', () => {
    const { toolCalls, cleanedContent } = extractTextToolCalls('no delimiters here');
    expect(toolCalls).toEqual([]);
    expect(cleanedContent).toBe('no delimiters here');
  });
});

describe('toGeminiContents', () => {
  test('converts user message to user content with text part', () => {
    const msgs: ProviderMessage[] = [{ role: 'user', content: 'hello' }];
    const { contents } = toGeminiContents(msgs);
    expect(contents[0].role).toBe('user');
    expect(contents[0].parts[0].text).toBe('hello');
  });

  test('injects system instruction when systemPrompt provided', () => {
    const { systemInstruction } = toGeminiContents([], 'Be helpful.');
    expect(systemInstruction).toBeDefined();
    expect(systemInstruction!.parts[0].text).toBe('Be helpful.');
  });

  test('converts assistant message to model role', () => {
    const msgs: ProviderMessage[] = [{ role: 'assistant', content: 'response' }];
    const { contents } = toGeminiContents(msgs);
    expect(contents[0].role).toBe('model');
  });

  test('merges tool results into user functionResponse parts', () => {
    const msgs: ProviderMessage[] = [
      { role: 'assistant', content: '', toolCalls: [sampleToolCall] },
      { role: 'tool', callId: 'call-1', content: 'result', name: 'file_read' },
    ];
    const { contents } = toGeminiContents(msgs);
    const last = contents[contents.length - 1];
    expect(last.role).toBe('user');
    expect(last.parts.some((p) => p.functionResponse !== undefined)).toBe(true);
  });
});
