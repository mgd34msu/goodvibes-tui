import { describe, expect, test } from 'bun:test';
import { jsonErrorResponse } from '@pellux/goodvibes-sdk/platform/daemon';
import { ProviderError } from '@pellux/goodvibes-sdk/platform/types';

describe('jsonErrorResponse', () => {
  test('keeps error string compatibility while exposing structured metadata', async () => {
    const response = jsonErrorResponse(new ProviderError('inceptionlabs chat request failed 401: token rejected', {
      statusCode: 401,
      provider: 'inceptionlabs',
      operation: 'chat',
      phase: 'request',
      requestId: 'req-401',
      providerCode: 'invalid_api_key',
    }), { status: 400 });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'inceptionlabs chat request failed 401: token rejected (code=invalid_api_key, request_id=req-401)',
      hint: 'The provider rejected authentication. Possible causes include invalid or expired credentials, missing account/session state, account restrictions, or the wrong provider/endpoint receiving the request.',
      code: 'PROVIDER_ERROR',
      category: 'authentication',
      source: 'provider',
      recoverable: false,
      status: 400,
      requestId: 'req-401',
    });
  });
});
