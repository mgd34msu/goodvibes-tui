import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
  resolveGithubToken,
  GistUploadTarget,
  NO_TOKEN_GUIDANCE,
} from '../../export/gist-uploader.ts';

// ---------------------------------------------------------------------------
// Mock-fetch install helper
//
// bun:test's `Mock<T>` wraps a plain function with call-history bookkeeping,
// so it never structurally overlaps with the overloaded `typeof fetch` type
// (TS2352). This is the one narrow spot where a cast through `unknown` is
// the correct, TS-suggested conversion, the mock genuinely stands in for
// the global, and factoring it here keeps that cast in a single place
// instead of repeating it at every call site.
// ---------------------------------------------------------------------------
type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function installMockFetch(impl: FetchImpl): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(impl) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

// ---------------------------------------------------------------------------
// resolveGithubToken
// ---------------------------------------------------------------------------

describe('resolveGithubToken', () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env['GITHUB_TOKEN'];
    delete process.env['GITHUB_TOKEN'];
  });

  afterEach(() => {
    if (originalToken !== undefined) {
      process.env['GITHUB_TOKEN'] = originalToken;
    } else {
      delete process.env['GITHUB_TOKEN'];
    }
  });

  test('extracts token from Bearer Authorization header', () => {
    const headers = { Authorization: 'Bearer ghp_test12345' };
    expect(resolveGithubToken(headers)).toBe('ghp_test12345');
  });

  test('extracts token from lowercase authorization header', () => {
    const headers = { authorization: 'Bearer ghp_lower' };
    expect(resolveGithubToken(headers)).toBe('ghp_lower');
  });

  test('falls back to GITHUB_TOKEN env var when headers are null', () => {
    process.env['GITHUB_TOKEN'] = 'ghp_env_token';
    expect(resolveGithubToken(null)).toBe('ghp_env_token');
  });

  test('falls back to GITHUB_TOKEN env var when headers have no token', () => {
    process.env['GITHUB_TOKEN'] = 'ghp_fallback';
    expect(resolveGithubToken({})).toBe('ghp_fallback');
  });

  test('returns undefined when no header and no env var', () => {
    expect(resolveGithubToken(null)).toBeUndefined();
  });

  test('returns undefined when env var is empty string', () => {
    process.env['GITHUB_TOKEN'] = '';
    expect(resolveGithubToken(null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GistUploadTarget (mocked fetch)
// ---------------------------------------------------------------------------

describe('GistUploadTarget', () => {
  const MOCK_URL = 'https://gist.github.com/abc123';
  const MOCK_TOKEN = 'ghp_testtoken';

  test('returns ok:true with html_url on success', async () => {
    const mockResponse = new Response(
      JSON.stringify({ html_url: MOCK_URL }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
    const restoreFetch = installMockFetch(() => Promise.resolve(mockResponse));
    try {
      const uploader = new GistUploadTarget(MOCK_TOKEN);
      const result = await uploader.upload('# Hello\ncontent', 'session.md');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.url).toBe(MOCK_URL);
    } finally {
      restoreFetch();
    }
  });

  test('sends correct request shape (secret gist)', async () => {
    let capturedBody: unknown;
    const mockResponse = new Response(
      JSON.stringify({ html_url: MOCK_URL }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
    const restoreFetch = installMockFetch((_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return Promise.resolve(mockResponse);
    });
    try {
      const uploader = new GistUploadTarget(MOCK_TOKEN, 'test desc');
      await uploader.upload('content', 'export.html');
      const body = capturedBody as Record<string, unknown>;
      expect(body['public']).toBe(false);
      expect(body['description']).toBe('test desc');
      expect((body['files'] as Record<string, unknown>)['export.html']).toBeDefined();
    } finally {
      restoreFetch();
    }
  });

  test('returns ok:false on HTTP error response', async () => {
    const mockResponse = new Response('Unauthorized', { status: 401 });
    const restoreFetch = installMockFetch(() => Promise.resolve(mockResponse));
    try {
      const uploader = new GistUploadTarget(MOCK_TOKEN);
      const result = await uploader.upload('content', 'test.html');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('401');
    } finally {
      restoreFetch();
    }
  });

  test('returns ok:false on network error', async () => {
    const restoreFetch = installMockFetch(() => Promise.reject(new Error('Network failure')));
    try {
      const uploader = new GistUploadTarget(MOCK_TOKEN);
      const result = await uploader.upload('content', 'test.html');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Network failure');
    } finally {
      restoreFetch();
    }
  });

  test('NO_TOKEN_GUIDANCE contains actionable instructions', () => {
    expect(NO_TOKEN_GUIDANCE).toContain('GITHUB_TOKEN');
    expect(NO_TOKEN_GUIDANCE).toContain('gist');
    expect(NO_TOKEN_GUIDANCE).toContain('secret');
  });
});
