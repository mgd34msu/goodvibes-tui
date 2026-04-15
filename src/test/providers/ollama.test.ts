import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ChatResponse, LLMProvider } from '../../providers/interface.ts';
import { OllamaProvider } from '../../providers/ollama.ts';
import { ProviderError } from '@pellux/goodvibes-sdk/platform/types/errors';

function ndjson(lines: Record<string, unknown>[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n');
}

describe('OllamaProvider', () => {
  beforeEach(() => {
    mock.restore();
  });

  test('uses native /api/chat for plain chat and streams content plus thinking', async () => {
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new OllamaProvider({
      name: 'Ollama',
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      defaultModel: 'qwen3',
      models: ['qwen3'],
      nativeFetch: async (input, init) => {
        fetchCalls.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(ndjson([
          { message: { role: 'assistant', thinking: 'plan' }, done: false },
          { message: { role: 'assistant', content: 'Hello' }, done: false },
          { message: { role: 'assistant', content: ' world' }, done: true, done_reason: 'stop', prompt_eval_count: 9, eval_count: 4 },
        ]), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
      },
    });

    const deltas: Array<{ content?: string; reasoning?: string }> = [];
    const response = await provider.chat({
      messages: [{ role: 'user', content: 'Hi' }],
      model: 'qwen3',
      reasoningEffort: 'medium',
      onDelta: (delta) => { deltas.push({ content: delta.content, reasoning: delta.reasoning }); },
    });

    expect(response.content).toBe('Hello world');
    expect(response.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
    expect(fetchCalls[0]?.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(fetchCalls[0]?.body).toMatchObject({
      model: 'qwen3',
      stream: true,
      think: 'medium',
    });
    expect(deltas).toEqual([
      { reasoning: 'plan' },
      { content: 'Hello' },
      { content: ' world' },
    ]);
  });

  test('returns tool calls from native /api/chat when present', async () => {
    const provider = new OllamaProvider({
      name: 'Ollama',
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      defaultModel: 'qwen3',
      models: ['qwen3'],
      nativeFetch: async () => new Response(ndjson([
        {
          message: {
            role: 'assistant',
            tool_calls: [
              { function: { name: 'read', arguments: { path: 'README.md' } } },
            ],
          },
          done: true,
          done_reason: 'tool_calls',
          prompt_eval_count: 12,
          eval_count: 0,
        },
      ]), { status: 200, headers: { 'content-type': 'application/x-ndjson' } }),
    });

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'Read the readme' }],
      model: 'qwen3',
      tools: [{
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }],
    });

    expect(response.stopReason).toBe('tool_use');
    expect(response.toolCalls).toEqual([
      { id: 'ollama_call_0', name: 'read', arguments: { path: 'README.md' } },
    ]);
  });

  test('falls back to compat provider when native Ollama chat is unavailable', async () => {
    const fallbackCalls: ChatResponse[] = [];
    const fallbackProvider: LLMProvider = {
      name: 'fallback',
      models: ['qwen3'],
      chat: async () => {
        const result: ChatResponse = {
          content: 'compat fallback',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'end',
        };
        fallbackCalls.push(result);
        return result;
      },
    };

    const provider = new OllamaProvider({
      name: 'Ollama',
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      defaultModel: 'qwen3',
      models: ['qwen3'],
      fallbackProvider,
      nativeFetch: async () => {
        throw new ProviderError('Ollama native chat error 404: not found', 404);
      },
    });

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'Hi' }],
      model: 'qwen3',
    });

    expect(response.content).toBe('compat fallback');
    expect(fallbackCalls).toHaveLength(1);
  });

  test('uses compat fallback when the transcript includes tool result messages', async () => {
    let nativeCalled = false;
    const fallbackProvider: LLMProvider = {
      name: 'fallback',
      models: ['qwen3'],
      chat: async () => ({
        content: 'continued via compat',
        toolCalls: [],
        usage: { inputTokens: 2, outputTokens: 2 },
        stopReason: 'end',
      }),
    };

    const provider = new OllamaProvider({
      name: 'Ollama',
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      defaultModel: 'qwen3',
      models: ['qwen3'],
      fallbackProvider,
      nativeFetch: async () => {
        nativeCalled = true;
        throw new Error('native path should not be used');
      },
    });

    const response = await provider.chat({
      messages: [
        { role: 'user', content: 'Read the file' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read', arguments: { path: 'README.md' } }] },
        { role: 'tool', callId: 'call-1', content: '{"ok":true}' },
      ],
      model: 'qwen3',
    });

    expect(nativeCalled).toBe(false);
    expect(response.content).toBe('continued via compat');
  });
});
