import { describe, expect, mock, spyOn, test } from 'bun:test';
import { OpenAICompatProvider } from '../../providers/openai-compat.ts';
import { ProviderError } from '@pellux/goodvibes-sdk/platform/types/errors';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';

function makeProvider(): OpenAICompatProvider {
  return new OpenAICompatProvider({
    name: 'inceptionlabs',
    baseURL: 'https://api.inceptionlabs.ai/v1',
    apiKey: 'test-key',
    defaultModel: 'mercury-2',
    models: ['mercury-2'],
    reasoningFormat: 'mercury',
  });
}

function setChatCreate(provider: OpenAICompatProvider, create: (...args: unknown[]) => Promise<unknown>): void {
  (provider as unknown as {
    client: {
      chat: { completions: { create: (...args: unknown[]) => Promise<unknown> } };
    };
  }).client = {
    chat: { completions: { create } },
  };
}

describe('OpenAICompatProvider diagnostics', () => {
  test('preserves upstream request details for request-phase failures', async () => {
    const provider = makeProvider();
    const errorSpy = spyOn(logger, 'error');
    setChatCreate(provider, mock(async () => {
      throw {
        status: 401,
        requestID: 'req-review-1',
        code: 'invalid_api_key',
        type: 'authentication_error',
        error: {
          message: 'token rejected by upstream',
          code: 'invalid_api_key',
          type: 'authentication_error',
        },
        message: '401 Unauthorized',
      };
    }));

    try {
      let thrown: unknown;
      try {
        await provider.chat({
          model: 'mercury-2',
          messages: [{ role: 'user', content: 'review the WRFC result' }],
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ProviderError);
      expect((thrown as ProviderError).message).toContain('inceptionlabs chat request failed 401');
      expect((thrown as ProviderError).message).toContain('token rejected by upstream');
      expect((thrown as ProviderError).message).toContain('request_id=req-review-1');
      expect(errorSpy.mock.calls[0]?.[1]).toMatchObject({
        phase: 'request',
        requestAccepted: false,
        status: 401,
        requestId: 'req-review-1',
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('marks stream failures as post-request errors', async () => {
    const provider = makeProvider();
    const errorSpy = spyOn(logger, 'error');
    setChatCreate(provider, mock(async () => ({
      async *[Symbol.asyncIterator]() {
        throw {
          status: 401,
          requestID: 'req-stream-1',
          error: { message: 'stream authorization expired' },
          message: 'stream closed',
        };
      },
    })));

    try {
      let thrown: unknown;
      try {
        await provider.chat({
          model: 'mercury-2',
          messages: [{ role: 'user', content: 'run the reviewer' }],
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ProviderError);
      expect((thrown as ProviderError).message).toContain('inceptionlabs chat stream failed 401');
      expect((thrown as ProviderError).message).toContain('request_id=req-stream-1');
      expect(errorSpy.mock.calls[0]?.[1]).toMatchObject({
        phase: 'stream',
        requestAccepted: true,
        status: 401,
        requestId: 'req-stream-1',
      });
    } finally {
      errorSpy.mockRestore();
    }
  });
});
