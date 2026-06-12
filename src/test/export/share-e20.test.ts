import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { calcSessionCost, getPricing } from '../../export/cost-utils.ts';
import {
  resolveGithubToken,
  GistUploadTarget,
  NO_TOKEN_GUIDANCE,
} from '../../export/gist-uploader.ts';
import { exportToMarkdownExtended } from '@pellux/goodvibes-sdk/platform/export';
import type { ExportMessage, ExportMetadata } from '@pellux/goodvibes-sdk/platform/export';

// ---------------------------------------------------------------------------
// cost-utils
// ---------------------------------------------------------------------------

describe('getPricing', () => {
  test('returns known pricing for exact model ID', () => {
    const p = getPricing('claude-sonnet-4-6');
    expect(p.input).toBe(3);
    expect(p.output).toBe(15);
  });

  test('returns zero pricing for unknown model', () => {
    const p = getPricing('unknown-model-xyz');
    expect(p.input).toBe(0);
    expect(p.output).toBe(0);
  });

  test('returns zero pricing for :free suffix model', () => {
    const p = getPricing('openrouter/my-model:free');
    expect(p.input).toBe(0);
    expect(p.output).toBe(0);
  });

  test('returns pricing for substring match', () => {
    // 'gpt-5.4' is in the table; a model like 'openrouter/gpt-5.4' should match
    const p = getPricing('openrouter/gpt-5.4');
    expect(p.input).toBe(5);
    expect(p.output).toBe(15);
  });
});

describe('calcSessionCost', () => {
  test('computes zero cost for all-zero inputs', () => {
    expect(calcSessionCost(0, 0, 0, 0, 'unknown-xyz')).toBe(0);
  });

  test('computes correct cost for claude-sonnet-4-6', () => {
    // 1M input = $3, 1M output = $15
    const cost = calcSessionCost(1_000_000, 1_000_000, 0, 0, 'claude-sonnet-4-6');
    expect(cost).toBeCloseTo(18, 2); // $3 + $15
  });

  test('includes cacheRead and cacheWrite in billable input', () => {
    // 0 base input, 1M cacheRead + 1M cacheWrite = 2M billable input
    // claude-sonnet-4-6: $3/1M input
    const cost = calcSessionCost(0, 0, 1_000_000, 1_000_000, 'claude-sonnet-4-6');
    expect(cost).toBeCloseTo(6, 2); // 2M * $3
  });

  test('returns non-negative cost', () => {
    const cost = calcSessionCost(100, 50, 10, 5, 'gpt-5-mini');
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  test('returns zero cost for zero-priced free model', () => {
    const cost = calcSessionCost(999_999, 999_999, 0, 0, 'model-x:free');
    expect(cost).toBe(0);
  });
});

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
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => Promise.resolve(mockResponse)) as typeof fetch;
    try {
      const uploader = new GistUploadTarget(MOCK_TOKEN);
      const result = await uploader.upload('# Hello\ncontent', 'session.md');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.url).toBe(MOCK_URL);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('sends correct request shape (secret gist)', async () => {
    let capturedBody: unknown;
    const mockResponse = new Response(
      JSON.stringify({ html_url: MOCK_URL }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return Promise.resolve(mockResponse);
    }) as typeof fetch;
    try {
      const uploader = new GistUploadTarget(MOCK_TOKEN, 'test desc');
      await uploader.upload('content', 'export.html');
      const body = capturedBody as Record<string, unknown>;
      expect(body['public']).toBe(false);
      expect(body['description']).toBe('test desc');
      expect((body['files'] as Record<string, unknown>)['export.html']).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns ok:false on HTTP error response', async () => {
    const mockResponse = new Response('Unauthorized', { status: 401 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => Promise.resolve(mockResponse)) as typeof fetch;
    try {
      const uploader = new GistUploadTarget(MOCK_TOKEN);
      const result = await uploader.upload('content', 'test.html');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('401');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns ok:false on network error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => Promise.reject(new Error('Network failure'))) as typeof fetch;
    try {
      const uploader = new GistUploadTarget(MOCK_TOKEN);
      const result = await uploader.upload('content', 'test.html');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Network failure');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('NO_TOKEN_GUIDANCE contains actionable instructions', () => {
    expect(NO_TOKEN_GUIDANCE).toContain('GITHUB_TOKEN');
    expect(NO_TOKEN_GUIDANCE).toContain('gist');
    expect(NO_TOKEN_GUIDANCE).toContain('secret');
  });
});

// ---------------------------------------------------------------------------
// share-runtime flag parsing (unit-level)
// ---------------------------------------------------------------------------

describe('share-runtime flag parsing', () => {
  // These test the internal logic independently of the full CommandContext.

  test('parses --redact flag from remaining args', () => {
    const args = ['html', '--redact'];
    const remaining = args.slice(1);
    expect(remaining.includes('--redact')).toBe(true);
    expect(remaining.filter((a) => a !== '--redact')).toHaveLength(0);
  });

  test('parses --upload flag without affecting path args', () => {
    const args = ['json', '/tmp/out.json', '--upload'];
    const remaining = args.slice(1);
    const flags = ['--redact', '--upload', '--copy', '--open'];
    const pathArgs = remaining.filter((a) => !flags.includes(a));
    expect(remaining.includes('--upload')).toBe(true);
    expect(pathArgs).toEqual(['/tmp/out.json']);
  });

  test('parses --copy and --open without path contamination', () => {
    const args = ['html', '--copy', '--open'];
    const remaining = args.slice(1);
    const flags = ['--redact', '--upload', '--copy', '--open'];
    const pathArgs = remaining.filter((a) => !flags.includes(a));
    expect(remaining.includes('--copy')).toBe(true);
    expect(remaining.includes('--open')).toBe(true);
    expect(pathArgs).toHaveLength(0);
  });

  test('all four flags can coexist', () => {
    const args = ['html', '--redact', '--upload', '--copy', '--open'];
    const remaining = args.slice(1);
    const flags = ['--redact', '--upload', '--copy', '--open'];
    const pathArgs = remaining.filter((a) => !flags.includes(a));
    expect(remaining.includes('--redact')).toBe(true);
    expect(remaining.includes('--upload')).toBe(true);
    expect(remaining.includes('--copy')).toBe(true);
    expect(remaining.includes('--open')).toBe(true);
    expect(pathArgs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Redaction + upload integration
// ---------------------------------------------------------------------------

describe('redaction before upload: secret absent from uploaded body', () => {
  const MOCK_URL = 'https://gist.github.com/redact-test';
  const MOCK_TOKEN = 'ghp_redacttest';
  // A realistic sk-style API key that should be redacted by the export layer.
  const SECRET = 'sk-abc1234567890abcdefgh';

  test('uploaded gist body does not contain sk-style secret when redact:true', async () => {
    const messages: ExportMessage[] = [
      { role: 'user', content: `My key is ${SECRET} please use it` },
      { role: 'assistant', content: 'Got it, I will use your key.' },
    ];
    const metadata: ExportMetadata = {
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      sessionId: 'sess-redact-test',
    };

    // Simulate the share command: export with redact:true, then upload.
    const redactedContent = exportToMarkdownExtended(messages, metadata, { redact: true });

    let capturedBody: string | undefined;
    const mockResponse = new Response(
      JSON.stringify({ html_url: MOCK_URL }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(mockResponse);
    }) as typeof fetch;

    try {
      const uploader = new GistUploadTarget(MOCK_TOKEN, 'redact test');
      const result = await uploader.upload(redactedContent, 'session.md');
      expect(result.ok).toBe(true);

      // The content that reached the network must not contain the raw secret.
      expect(capturedBody).toBeDefined();
      const parsedBody = JSON.parse(capturedBody!) as Record<string, unknown>;
      const files = parsedBody['files'] as Record<string, { content: string }>;
      const uploadedContent = files['session.md']?.content ?? '';
      expect(uploadedContent).not.toContain(SECRET);
      // The redacted content should contain a redaction placeholder token.
      expect(uploadedContent).toContain('[REDACTED_API_KEY]');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('uploaded gist body contains secret when redact:false', async () => {
    const messages: ExportMessage[] = [
      { role: 'user', content: `My key is ${SECRET}` },
    ];
    const metadata: ExportMetadata = {
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      sessionId: 'sess-no-redact',
    };

    const plainContent = exportToMarkdownExtended(messages, metadata, { redact: false });

    let capturedBody: string | undefined;
    const mockResponse = new Response(
      JSON.stringify({ html_url: MOCK_URL }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(mockResponse);
    }) as typeof fetch;

    try {
      const uploader = new GistUploadTarget(MOCK_TOKEN);
      await uploader.upload(plainContent, 'session.md');

      const parsedBody = JSON.parse(capturedBody!) as Record<string, unknown>;
      const files = parsedBody['files'] as Record<string, { content: string }>;
      const uploadedContent = files['session.md']?.content ?? '';
      // Without redaction the raw content passes through unchanged.
      expect(uploadedContent).toContain(SECRET);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// plugin-runtime module sanity checks
// ---------------------------------------------------------------------------

describe('plugin-runtime: registerPluginRuntimeCommands is exported and integration-runtime is gone', () => {
  test('registerPluginRuntimeCommands is exported from plugin-runtime.ts', async () => {
    const mod = await import('../../input/commands/plugin-runtime.ts');
    expect(typeof mod.registerPluginRuntimeCommands).toBe('function');
  });

  test('integration-runtime.ts module does not exist', async () => {
    await expect(
      import('../../input/commands/integration-runtime.ts'),
    ).rejects.toThrow();
  });
});
