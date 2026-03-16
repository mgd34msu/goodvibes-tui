import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { fetchTool } from '../../tools/fetch/index.ts';

// ---------------------------------------------------------------------------
// Local test server
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0, // random port
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/json') {
        return Response.json({ hello: 'world' });
      }

      if (url.pathname === '/html') {
        return new Response(
          '<html><head><title>Test Page</title><meta name="description" content="A test"><meta property="og:title" content="OG Test"></head>'
          + '<body><nav>Nav</nav><h1>Hello</h1><p>World</p><a href="/link1">Link 1</a><a href="/link2">Link 2</a>'
          + '<pre>code here</pre><code>inline code</code></body></html>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }

      if (url.pathname === '/text') {
        return new Response('plain text content', { headers: { 'content-type': 'text/plain' } });
      }

      if (url.pathname === '/slow') {
        await new Promise<void>((r) => setTimeout(r, 5000));
        return new Response('done');
      }

      if (url.pathname === '/post' && req.method === 'POST') {
        const body = await req.text();
        return Response.json({ received: body });
      }

      return new Response('Not Found', { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
});

// ---------------------------------------------------------------------------
// Basic requests
// ---------------------------------------------------------------------------

describe('fetch tool - basic requests', () => {
  test('GET plain text content', async () => {
    const result = await fetchTool.execute({ urls: [{ url: `${base}/text` }] });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    expect(out.results[0].status).toBe(200);
    expect(out.results[0].content).toBe('plain text content');
  });

  test('GET JSON and extract json mode', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/json`, extract: 'json' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const parsed = JSON.parse(out.results[0].content);
    expect(parsed).toEqual({ hello: 'world' });
  });

  test('GET HTML and extract text (strips tags)', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/html`, extract: 'text' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const content: string = out.results[0].content;
    expect(content).not.toContain('<');
    expect(content).not.toContain('>');
    expect(content).toContain('Hello');
  });

  test('GET HTML and extract markdown', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/html`, extract: 'markdown' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const content: string = out.results[0].content;
    expect(content).toContain('# Hello');
    expect(content).toContain('World');
  });

  test('GET HTML and extract links', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/html`, extract: 'links' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const content: string = out.results[0].content;
    expect(content).toContain('/link1');
    expect(content).toContain('/link2');
  });

  test('GET HTML and extract metadata (title)', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/html`, extract: 'metadata' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const meta = JSON.parse(out.results[0].content);
    expect(meta.title).toBe('Test Page');
    expect(meta.description).toBe('A test');
    expect(meta['og:title']).toBe('OG Test');
  });

  test('GET HTML and extract code_blocks', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/html`, extract: 'code_blocks' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const content: string = out.results[0].content;
    expect(content).toContain('code here');
  });

  test('GET HTML and extract readable (strips nav)', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/html`, extract: 'readable' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const content: string = out.results[0].content;
    // Nav should be stripped
    expect(content).not.toContain('Nav');
    expect(content).toContain('Hello');
  });
});

// ---------------------------------------------------------------------------
// POST with body
// ---------------------------------------------------------------------------

describe('fetch tool - POST requests', () => {
  test('POST with JSON body', async () => {
    const result = await fetchTool.execute({
      urls: [
        {
          url: `${base}/post`,
          method: 'POST',
          body: JSON.stringify({ key: 'value' }),
          body_type: 'json',
          extract: 'json',
        },
      ],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    expect(out.results[0].status).toBe(200);
    const content = JSON.parse(out.results[0].content);
    expect(content.received).toBe(JSON.stringify({ key: 'value' }));
  });

  test('POST with raw body', async () => {
    const result = await fetchTool.execute({
      urls: [
        {
          url: `${base}/post`,
          method: 'POST',
          body: 'hello=world',
          body_type: 'raw',
          extract: 'json',
        },
      ],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const content = JSON.parse(out.results[0].content);
    expect(content.received).toBe('hello=world');
  });
});

// ---------------------------------------------------------------------------
// Batch fetching
// ---------------------------------------------------------------------------

describe('fetch tool - batch fetching', () => {
  test('batch parallel fetch returns results for all URLs', async () => {
    const result = await fetchTool.execute({
      urls: [
        { url: `${base}/text` },
        { url: `${base}/json`, extract: 'json' },
      ],
      parallel: true,
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    expect(out.results).toHaveLength(2);
    expect(out.summary.total).toBe(2);
    expect(out.summary.succeeded).toBe(2);
    expect(out.summary.failed).toBe(0);
  });

  test('batch sequential fetch returns results for all URLs', async () => {
    const result = await fetchTool.execute({
      urls: [
        { url: `${base}/text` },
        { url: `${base}/json`, extract: 'json' },
      ],
      parallel: false,
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    expect(out.results).toHaveLength(2);
    expect(out.summary.total).toBe(2);
  });

  test('global extract applies to all URLs', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/json` }, { url: `${base}/json` }],
      extract: 'json',
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    for (const r of out.results) {
      expect(() => JSON.parse(r.content)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('fetch tool - error handling', () => {
  test('404 error is captured per-URL without failing batch', async () => {
    const result = await fetchTool.execute({
      urls: [
        { url: `${base}/text` },
        { url: `${base}/notfound` },
      ],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    expect(out.summary.succeeded).toBe(2); // 404 is a valid response, not a fetch error
    const notFound = out.results.find((r: { url: string }) => r.url.includes('/notfound'));
    expect(notFound.status).toBe(404);
  });

  test('invalid URL error is captured per-URL without failing batch', async () => {
    const result = await fetchTool.execute({
      urls: [
        { url: `${base}/text` },
        { url: 'http://localhost:1' }, // nothing listening on port 1
      ],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    expect(out.summary.failed).toBeGreaterThanOrEqual(1);
    const errored = out.results.find((r: { error?: string }) => r.error !== undefined);
    expect(errored).toBeDefined();
    expect(typeof errored.error).toBe('string');
  });

  test('timeout is enforced per-URL', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/slow`, timeout_ms: 100 }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    expect(out.results[0].error).toContain('Timeout');
    expect(out.summary.failed).toBe(1);
  }, 5000);

  test('missing urls array returns error', async () => {
    const result = await fetchTool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('urls');
  });

  test('empty urls array returns error', async () => {
    const result = await fetchTool.execute({ urls: [] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('urls');
  });
});

// ---------------------------------------------------------------------------
// Verbosity
// ---------------------------------------------------------------------------

describe('fetch tool - verbosity', () => {
  test('count_only returns summary without results array', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/text` }, { url: `${base}/json` }],
      verbosity: 'count_only',
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    expect(out.summary.total).toBe(2);
    expect(out.results).toBeUndefined();
  });

  test('minimal returns results without content', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/text` }],
      verbosity: 'minimal',
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    expect(out.results[0].status).toBe(200);
    expect(out.results[0].content).toBeUndefined();
    expect(out.results[0].byteSize).toBeGreaterThan(0);
  });

  test('verbose returns metadata with headers', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/text` }],
      verbosity: 'verbose',
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    expect(out.results[0].metadata).toBeDefined();
    expect(typeof out.results[0].metadata.headers).toBe('object');
  });

  test('standard returns content and status', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/text` }],
      verbosity: 'standard',
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    expect(out.results[0].status).toBe(200);
    expect(typeof out.results[0].content).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

describe('fetch tool - definition', () => {
  test('has name fetch', () => {
    expect(fetchTool.definition.name).toBe('fetch');
  });

  test('has non-empty description', () => {
    expect(fetchTool.definition.description.length).toBeGreaterThan(0);
  });

  test('has parameters object', () => {
    expect(typeof fetchTool.definition.parameters).toBe('object');
  });
});
