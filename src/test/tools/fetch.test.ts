import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createFetchTool } from '@pellux/goodvibes-sdk/platform/tools';

// ---------------------------------------------------------------------------
// Local test server
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>;
let base: string;
let fetchTool: ReturnType<typeof createFetchTool>;

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

      if (url.pathname === '/structured') {
        return new Response(
          '<html><body>'
          + '<h1 class="title">Main Title</h1>'
          + '<h2>Sub Heading</h2>'
          + '<p class="intro">Intro paragraph</p>'
          + '<p>Other paragraph</p>'
          + '<span id="note">A note</span>'
          + '</body></html>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }

      if (url.pathname === '/tables') {
        return new Response(
          '<html><body>'
          + '<table>'
          + '<tr><th>Name</th><th>Age</th></tr>'
          + '<tr><td>Alice</td><td>30</td></tr>'
          + '<tr><td>Bob</td><td>25</td></tr>'
          + '</table>'
          + '<table>'
          + '<tr><th>City</th><th>Country</th></tr>'
          + '<tr><td>Paris</td><td>France</td></tr>'
          + '</table>'
          + '</body></html>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }

      if (url.pathname === '/pdf') {
        // Minimal synthetic PDF with a text stream
        const pdfBody = '%PDF-1.4\nstream\n(Hello PDF World) Tj\n(Second line) Tj\nendstream\n%%EOF';
        return new Response(pdfBody, { headers: { 'content-type': 'application/pdf' } });
      }

      if (url.pathname === '/post' && req.method === 'POST') {
        const body = await req.text();
        return Response.json({ received: body });
      }

      if (url.pathname === '/echo') {
        const body = await req.text();
        return Response.json({
          method: req.method,
          body,
          headers: Object.fromEntries(req.headers),
        });
      }

      return new Response('Not Found', { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

beforeAll(() => {
  // Test servers bind loopback; approve localhost up front (the per-project
  // dev-server approval) so the suite exercises fetch behavior, not the ask.
  fetchTool = createFetchTool({ isLocalhostAllowed: () => true });
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
// Structured extraction
// ---------------------------------------------------------------------------

describe('fetch tool - structured extraction', () => {
  test('extracts elements by tag name', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/structured`, extract: 'structured', selectors: ['h1'] }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const items: string[] = JSON.parse(out.results[0].content);
    expect(items).toContain('Main Title');
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  test('extracts elements by class selector', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/structured`, extract: 'structured', selectors: ['.intro'] }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const items: string[] = JSON.parse(out.results[0].content);
    expect(items).toContain('Intro paragraph');
  });

  test('extracts elements by id selector', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/structured`, extract: 'structured', selectors: ['#note'] }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const items: string[] = JSON.parse(out.results[0].content);
    expect(items).toContain('A note');
  });

  test('extracts multiple selectors combined', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/structured`, extract: 'structured', selectors: ['h1', 'h2'] }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const items: string[] = JSON.parse(out.results[0].content);
    expect(items).toContain('Main Title');
    expect(items).toContain('Sub Heading');
  });

  test('returns empty array when no selectors provided', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/structured`, extract: 'structured' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const items: string[] = JSON.parse(out.results[0].content);
    expect(items).toEqual([]);
  });

  test('returns empty array for non-HTML content', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/text`, extract: 'structured', selectors: ['p'] }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const items: string[] = JSON.parse(out.results[0].content);
    expect(items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tables extraction
// ---------------------------------------------------------------------------

describe('fetch tool - tables extraction', () => {
  test('parses table headers and rows', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/tables`, extract: 'tables' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const tables: Array<{ headers: string[]; rows: string[][] }> = JSON.parse(out.results[0].content);
    expect(tables.length).toBe(2);
    expect(tables[0].headers).toEqual(['Name', 'Age']);
    expect(tables[0].rows).toEqual([['Alice', '30'], ['Bob', '25']]);
  });

  test('parses multiple tables', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/tables`, extract: 'tables' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const tables: Array<{ headers: string[]; rows: string[][] }> = JSON.parse(out.results[0].content);
    expect(tables.length).toBe(2);
    expect(tables[1].headers).toEqual(['City', 'Country']);
    expect(tables[1].rows).toEqual([['Paris', 'France']]);
  });

  test('returns empty array for non-HTML content', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/text`, extract: 'tables' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const tables: unknown[] = JSON.parse(out.results[0].content);
    expect(tables).toEqual([]);
  });

  test('returns empty array for HTML with no tables', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/html`, extract: 'tables' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const tables: unknown[] = JSON.parse(out.results[0].content);
    expect(tables).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PDF extraction
// ---------------------------------------------------------------------------

describe('fetch tool - pdf extraction', () => {
  test('extracts text from PDF content streams', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/pdf`, extract: 'pdf' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const content: string = out.results[0].content;
    expect(content).toContain('Hello PDF World');
    expect(content).toContain('Second line');
  });

  test('returns limitation note for non-PDF content-type', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/html`, extract: 'pdf' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const note = JSON.parse(out.results[0].content);
    expect(note.note).toContain('PDF extraction only applies');
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
    expect(out.results[0].error?.toLowerCase()).toContain('timed out');
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
// HTTP methods
// ---------------------------------------------------------------------------

describe('fetch tool - HTTP methods', () => {
  test('PUT method is sent correctly', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/echo`, method: 'PUT', body: 'put-body', extract: 'json' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const echo = JSON.parse(out.results[0].content);
    expect(echo.method).toBe('PUT');
    expect(echo.body).toBe('put-body');
  });

  test('DELETE method is sent correctly', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/echo`, method: 'DELETE', extract: 'json' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const echo = JSON.parse(out.results[0].content);
    expect(echo.method).toBe('DELETE');
  });

  test('PATCH method is sent correctly', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/echo`, method: 'PATCH', body: 'patch-data', extract: 'json' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const echo = JSON.parse(out.results[0].content);
    expect(echo.method).toBe('PATCH');
    expect(echo.body).toBe('patch-data');
  });

  test('HEAD method returns empty body and 200 status', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/text`, method: 'HEAD' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    expect(out.results[0].status).toBe(200);
    // HEAD responses have no body
    const content: string = out.results[0].content ?? '';
    expect(content).toBe('');
  });

  test('OPTIONS method is sent correctly', async () => {
    const result = await fetchTool.execute({
      urls: [{ url: `${base}/echo`, method: 'OPTIONS', extract: 'json' }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const echo = JSON.parse(out.results[0].content);
    expect(echo.method).toBe('OPTIONS');
  });
});

// ---------------------------------------------------------------------------
// Body types and custom headers
// ---------------------------------------------------------------------------

describe('fetch tool - body_type and headers', () => {
  test('body_type form sets Content-Type application/x-www-form-urlencoded', async () => {
    const result = await fetchTool.execute({
      urls: [{
        url: `${base}/echo`,
        method: 'POST',
        body: 'key=value&other=123',
        body_type: 'form',
        extract: 'json',
      }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const echo = JSON.parse(out.results[0].content);
    expect(echo.headers['content-type']).toContain('application/x-www-form-urlencoded');
    expect(echo.body).toBe('key=value&other=123');
  });

  test('custom request headers are sent to server', async () => {
    const result = await fetchTool.execute({
      urls: [{
        url: `${base}/echo`,
        method: 'GET',
        headers: { 'x-custom-header': 'my-value', 'x-another': 'test' },
        extract: 'json',
      }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const echo = JSON.parse(out.results[0].content);
    expect(echo.headers['x-custom-header']).toBe('my-value');
    expect(echo.headers['x-another']).toBe('test');
  });

  test('body_type json sets Content-Type application/json', async () => {
    const result = await fetchTool.execute({
      urls: [{
        url: `${base}/echo`,
        method: 'POST',
        body: JSON.stringify({ test: true }),
        body_type: 'json',
        extract: 'json',
      }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const echo = JSON.parse(out.results[0].content);
    expect(echo.headers['content-type']).toContain('application/json');
  });

  test('body_data + body_type form URL-encodes form fields', async () => {
    const result = await fetchTool.execute({
      urls: [{
        url: `${base}/echo`,
        method: 'POST',
        body_type: 'form',
        body_data: {
          q: 'duck duck go',
          region: 'us-en',
          safe: '-1',
        },
        extract: 'json',
      }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const echo = JSON.parse(out.results[0].content);
    expect(echo.headers['content-type']).toContain('application/x-www-form-urlencoded');
    expect(echo.body).toContain('q=duck+duck+go');
    expect(echo.body).toContain('region=us-en');
    expect(echo.body).toContain('safe=-1');
  });

  test('explicit Content-Type header is not overridden by body_type', async () => {
    const result = await fetchTool.execute({
      urls: [{
        url: `${base}/echo`,
        method: 'POST',
        body: 'custom',
        body_type: 'json',
        headers: { 'Content-Type': 'text/plain' },
        extract: 'json',
      }],
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!);
    const echo = JSON.parse(out.results[0].content);
    expect(echo.headers['content-type']).toContain('text/plain');
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
