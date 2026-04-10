import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ChatResponse, LLMProvider } from '../../providers/interface.ts';
import { LlamaCppProvider } from '../../providers/llama-cpp.ts';

describe('LlamaCppProvider', () => {
  beforeEach(() => {
    mock.restore();
  });

  test('uses non-streaming chat completions for tool-enabled turns', async () => {
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new LlamaCppProvider({
      name: 'llama.cpp',
      baseURL: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      defaultModel: 'qwen',
      models: ['qwen'],
      reasoningFormat: 'llamacpp',
      nativeFetch: async (input, init) => {
        fetchCalls.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({
          choices: [{
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [{
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'analyze',
                  arguments: '{"mode":"impact","securityScope":"all"}',
                },
              }],
            },
          }],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 2,
          },
        });
      },
    });

    const deltas: Array<{ content?: string; toolCalls?: unknown }> = [];
    const response = await provider.chat({
      messages: [{ role: 'user', content: 'Analyze the repo' }],
      model: 'qwen',
      reasoningEffort: 'medium',
      tools: [{
        name: 'analyze',
        description: 'Analyze code',
        parameters: { type: 'object', properties: { mode: { type: 'string' } } },
      }],
      onDelta: (delta) => {
        deltas.push({ content: delta.content, toolCalls: delta.toolCalls });
      },
    });

    expect(fetchCalls[0]?.url).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect(fetchCalls[0]?.body).toMatchObject({
      model: 'qwen',
      stream: false,
      enable_thinking: true,
    });
    expect(response.stopReason).toBe('tool_use');
    expect(response.toolCalls).toEqual([
      {
        id: 'call-1',
        name: 'analyze',
        arguments: { mode: 'impact', securityScope: 'all' },
      },
    ]);
    expect(response.usage).toEqual({ inputTokens: 11, outputTokens: 2 });
    expect(deltas).toEqual([
      {
        toolCalls: [{
          index: 0,
          id: 'call-1',
          name: 'analyze',
          arguments: '{"mode":"impact","securityScope":"all"}',
        }],
      },
    ]);
  });

  test('keeps compat streaming for plain llama.cpp chat turns', async () => {
    let fallbackCalls = 0;
    const fallbackProvider: LLMProvider = {
      name: 'compat',
      models: ['qwen'],
      chat: async () => {
        fallbackCalls += 1;
        const result: ChatResponse = {
          content: 'streamed compat',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'end',
        };
        return result;
      },
    };
    const provider = new LlamaCppProvider({
      name: 'llama.cpp',
      baseURL: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      defaultModel: 'qwen',
      models: ['qwen'],
      fallbackProvider,
      nativeFetch: async () => {
        throw new Error('native non-stream path should not be used');
      },
    });

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'qwen',
    });

    expect(response.content).toBe('streamed compat');
    expect(fallbackCalls).toBe(1);
  });

  test('uses non-streaming chat completions for transcripts that already contain tool messages', async () => {
    let fallbackCalls = 0;
    const provider = new LlamaCppProvider({
      name: 'llama.cpp',
      baseURL: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      defaultModel: 'qwen',
      models: ['qwen'],
      fallbackProvider: {
        name: 'compat',
        models: ['qwen'],
        chat: async () => {
          fallbackCalls += 1;
          return {
            content: 'should not happen',
            toolCalls: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: 'end',
          };
        },
      },
      nativeFetch: async () => Response.json({
        choices: [{
          finish_reason: 'stop',
          message: {
            content: 'Final answer',
          },
        }],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 3,
        },
      }),
    });

    const response = await provider.chat({
      messages: [
        { role: 'user', content: 'Analyze the repo' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'analyze', arguments: { mode: 'impact' } }] },
        { role: 'tool', callId: 'call-1', content: '{"summary":"ok"}' },
      ],
      model: 'qwen',
    });

    expect(response.content).toBe('Final answer');
    expect(fallbackCalls).toBe(0);
  });
});
