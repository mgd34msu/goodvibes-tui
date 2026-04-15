import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatResponse, LLMProvider } from '../../providers/interface.ts';
import { LMStudioProvider } from '../../providers/lm-studio.ts';
import { ProviderError } from '@pellux/goodvibes-sdk/platform/types/errors';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '../../config/service-registry.ts';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';

function sse(events: Array<{ event: string; data: Record<string, unknown> }>): string {
  return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function jsonStream(events: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> & { finalResponse(): Promise<Record<string, unknown>> } {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    async finalResponse() {
      return { type: 'response', status: 'completed' };
    },
  };
}

function makeRuntimeMetadataDeps() {
  const root = join(tmpdir(), `gv-lmstudio-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const secretsManager = new SecretsManager({ projectRoot: root, globalHome: root });
  const subscriptionManager = new SubscriptionManager(join(root, '.goodvibes', 'tui', 'subscriptions.json'));
  const serviceRegistry = new ServiceRegistry(join(root, '.goodvibes', 'tui', 'services.json'), {
    secretsManager,
    subscriptionManager,
  });
  return { secretsManager, subscriptionManager, serviceRegistry };
}

describe('LMStudioProvider', () => {
  beforeEach(() => {
    mock.restore();
  });

  test('uses native LM Studio chat for plain conversations and preserves response ids across turns', async () => {
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const responses = [
      new Response(sse([
        { event: 'chat.start', data: { type: 'chat.start', model_instance_id: 'm1' } },
        { event: 'reasoning.delta', data: { type: 'reasoning.delta', content: 'plan' } },
        { event: 'message.delta', data: { type: 'message.delta', content: 'Hello there' } },
        {
          event: 'chat.end',
          data: {
            type: 'chat.end',
            result: {
              output: [{ type: 'message', content: 'Hello there' }],
              stats: { input_tokens: 11, total_output_tokens: 7 },
              response_id: 'resp_1',
            },
          },
        },
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      new Response(sse([
        { event: 'message.delta', data: { type: 'message.delta', content: 'Second reply' } },
        {
          event: 'chat.end',
          data: {
            type: 'chat.end',
            result: {
              output: [{ type: 'message', content: 'Second reply' }],
              stats: { input_tokens: 9, total_output_tokens: 5 },
              response_id: 'resp_2',
            },
          },
        },
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    ];

    const provider = new LMStudioProvider({
      name: 'LM Studio',
      baseURL: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      defaultModel: 'model-a',
      models: ['model-a'],
      nativeFetch: async (input, init) => {
        fetchCalls.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return responses.shift()!;
      },
      responsesClient: {
        create: async () => {
          throw new Error('responses path should not be used');
        },
      },
    });

    const deltas: Array<{ content?: string; reasoning?: string }> = [];
    const first = await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'model-a',
      reasoningEffort: 'low',
      onDelta: (delta) => { deltas.push({ content: delta.content, reasoning: delta.reasoning }); },
    });

    expect(first.content).toBe('Hello there');
    expect(first.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(deltas).toEqual([
      { reasoning: 'plan' },
      { content: 'Hello there' },
    ]);
    expect(fetchCalls[0]?.url).toBe('http://127.0.0.1:1234/api/v1/chat');
    expect(fetchCalls[0]?.body).toMatchObject({
      model: 'model-a',
      input: 'Hello',
      stream: true,
      store: true,
      reasoning: 'low',
    });

    const second = await provider.chat({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hello there' },
        { role: 'user', content: 'And again' },
      ],
      model: 'model-a',
    });

    expect(second.content).toBe('Second reply');
    expect(fetchCalls[1]?.body).toMatchObject({
      input: 'And again',
      previous_response_id: 'resp_1',
    });
  });

  test('uses LM Studio responses for tool-enabled turns', async () => {
    const provider = new LMStudioProvider({
      name: 'LM Studio',
      baseURL: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      defaultModel: 'model-a',
      models: ['model-a'],
      nativeFetch: async () => {
        throw new Error('native path should not be used for tool turns');
      },
      responsesClient: {
        create: async (params) => {
          expect(params['tools']).toBeDefined();
          return jsonStream([
            { type: 'response.created', response: { id: 'resp_1', output: [] } },
            {
              type: 'response.output_item.added',
              item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'read' },
            },
            { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '{"path":"' },
            { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: 'README.md"}' },
            {
              type: 'response.output_item.done',
              item: { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"README.md"}' },
            },
            {
              type: 'response.completed',
              response: { status: 'completed', usage: { input_tokens: 20, output_tokens: 4 } },
            },
          ]);
        },
      },
    });

    const deltas: Array<{ toolCalls?: unknown[] }> = [];
    const response = await provider.chat({
      messages: [{ role: 'user', content: 'Read the file' }],
      tools: [{
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }],
      model: 'model-a',
      onDelta: (delta) => {
        if (delta.toolCalls) deltas.push({ toolCalls: delta.toolCalls });
      },
    });

    expect(response.stopReason).toBe('tool_use');
    expect(response.toolCalls).toEqual([
      { id: 'call_1', name: 'read', arguments: { path: 'README.md' } },
    ]);
    expect(deltas.length).toBeGreaterThan(0);
  });

  test('falls back to the compat provider when LM Studio responses are unavailable', async () => {
    const fallbackCalls: ChatResponse[] = [];
    const fallbackProvider: LLMProvider = {
      name: 'fallback',
      models: ['model-a'],
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

    const provider = new LMStudioProvider({
      name: 'LM Studio',
      baseURL: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      defaultModel: 'model-a',
      models: ['model-a'],
      fallbackProvider,
      nativeFetch: async () => {
        throw new Error('native path should not be used');
      },
      responsesClient: {
        create: async () => {
          throw new ProviderError('LM Studio Responses error 404: not found', 404);
        },
      },
    });

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [{
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: {}, required: [] },
      }],
      model: 'model-a',
    });

    expect(response.content).toBe('compat fallback');
    expect(fallbackCalls).toHaveLength(1);
  });

  test('delegates embeddings to the fallback provider and surfaces runtime metadata', async () => {
    const fallbackProvider: LLMProvider = {
      name: 'fallback',
      models: ['model-a'],
      chat: async () => ({
        content: 'ok',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end',
      }),
      embed: async () => ({
        vector: Float32Array.from([0.1, 0.2, 0.3]),
        dimensions: 3,
        modelId: 'text-embedding',
      }),
    };

    const provider = new LMStudioProvider({
      name: 'LM Studio',
      baseURL: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      defaultModel: 'model-a',
      models: ['model-a'],
      fallbackProvider,
    });

    const embedding = await provider.embed({
      text: 'hello',
      dimensions: 3,
      usage: 'query',
    });
    expect(Array.from(embedding.vector as Float32Array).map((value) => Number(value.toFixed(1)))).toEqual([0.1, 0.2, 0.3]);

    const runtime = await provider.describeRuntime(makeRuntimeMetadataDeps());
    expect(runtime.policy?.streamProtocol).toBe('lmstudio-native-or-responses');
    expect(runtime.auth?.routes?.some((route) => route.route === 'anonymous')).toBe(true);
  });

  test('uses responses path when native chat cannot continue prior history safely', async () => {
    let nativeCalled = false;
    const provider = new LMStudioProvider({
      name: 'LM Studio',
      baseURL: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      defaultModel: 'model-a',
      models: ['model-a'],
      nativeFetch: async () => {
        nativeCalled = true;
        throw new Error('native path should not be used');
      },
      responsesClient: {
        create: async () => jsonStream([
          { type: 'response.created', response: { id: 'resp_1', output: [] } },
          { type: 'response.output_text.delta', delta: 'Recovered via responses' },
          {
            type: 'response.completed',
            response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 3 } },
          },
        ]),
      },
    });

    const response = await provider.chat({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'Continue' },
      ],
      model: 'model-a',
    });

    expect(nativeCalled).toBe(false);
    expect(response.content).toBe('Recovered via responses');
  });
});
