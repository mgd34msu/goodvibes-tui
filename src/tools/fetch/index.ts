import { logger } from '../../utils/logger.ts';
import type { Tool, ToolDefinition } from '../../types/tools.ts';
import { FETCH_TOOL_SCHEMA } from './schema.ts';
import type { FetchInput, FetchUrlInput, FetchAuthInput, FetchExtractMode, FetchVerbosity } from './schema.ts';
import { resolveServiceAuth } from '../../config/service-registry.ts';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface FetchUrlResult {
  url: string;
  status?: number;
  statusText?: string;
  contentType?: string;
  byteSize?: number;
  content?: string;
  error?: string;
  /** Additional metadata included in verbose format. */
  metadata?: {
    headers: Record<string, string>;
    redirected: boolean;
    finalUrl: string;
  };
}

export interface FetchOutput {
  success: boolean;
  error?: string;
  results?: FetchUrlResult[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
  };
}

// ---------------------------------------------------------------------------
// HTML extraction helpers
// ---------------------------------------------------------------------------

/** Strip all HTML tags and decode common entities. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Convert simple HTML to markdown using regex. */
function htmlToMarkdown(html: string): string {
  return html
    // Remove script and style
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Headings
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '### $1\n')
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '#### $1\n')
    .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '##### $1\n')
    .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '###### $1\n')
    // Bold / italic
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/(strong|b)>/gi, '**$2**')
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/(em|i)>/gi, '_$2_')
    // Links
    .replace(/<a[^>]+href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    // Images (handle any attribute order for src/alt)
    .replace(/<img[^>]*>/gi, (match) => {
      const alt = match.match(/\balt=["']([^"']*)["']/i)?.[1] ?? '';
      const src = match.match(/\bsrc=["']([^"']*)["']/i)?.[1] ?? '';
      return alt ? `![${alt}](${src})` : `![](${src})`;
    })
    // Lists
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1')
    .replace(/<ul[^>]*>/gi, '\n').replace(/<\/ul>/gi, '\n')
    .replace(/<ol[^>]*>/gi, '\n').replace(/<\/ol>/gi, '\n')
    // Paragraphs and line breaks
    .replace(/<p[^>]*>/gi, '\n').replace(/<\/p>/gi, '\n')
    .replace(/<br[^>]*>/gi, '\n')
    // Code
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '```\n$1\n```')
    // Horizontal rule
    .replace(/<hr[^>]*>/gi, '\n---\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Clean up excessive blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Simplified readability: strip nav, aside, header, footer, ads, then return
 * the text of the remaining body content.
 */
function extractReadable(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '');
  return stripHtml(stripped);
}

/** Extract text content from <pre> and <code> blocks. */
function extractCodeBlocks(html: string): string {
  const blocks: string[] = [];
  const preRe = /<pre[^>]*>([\s\S]*?)<\/pre>/gi;
  let m: RegExpExecArray | null;
  while ((m = preRe.exec(html)) !== null) {
    blocks.push(stripHtml(m[1]));
  }
  // Strip <pre> blocks before scanning for standalone <code> to avoid duplication
  const withoutPre = html.replace(/<pre[\s\S]*?<\/pre>/gi, '');
  const codeRe = /<code[^>]*>([\s\S]*?)<\/code>/gi;
  while ((m = codeRe.exec(withoutPre)) !== null) {
    const code = stripHtml(m[1]);
    if (code.trim()) blocks.push(code);
  }
  return blocks.join('\n\n');
}

/** Extract all href and src URLs from an HTML page. */
function extractLinks(html: string): string {
  const links: string[] = [];
  const re = /(?:href|src)=["']([^"'#][^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    links.push(m[1]);
  }
  return links.join('\n');
}

/**
 * Extract text content from HTML elements matching simplified CSS selectors.
 * Supports: tag names (e.g. 'h1'), class selectors ('.classname'),
 * id selectors ('#id'), and tag+class combos ('tag.class').
 */
function extractStructured(html: string, selectors: string[]): string {
  const results: string[] = [];

  for (const selector of selectors) {
    const trimmed = selector.trim();
    let tagPattern: string | null = null;
    let classFilter: string | null = null;
    let idFilter: string | null = null;

    if (trimmed.startsWith('#')) {
      // id selector: #foo
      idFilter = trimmed.slice(1);
      tagPattern = '[a-z][a-z0-9]*';
    } else if (trimmed.startsWith('.')) {
      // class selector: .foo
      classFilter = trimmed.slice(1);
      tagPattern = '[a-z][a-z0-9]*';
    } else if (trimmed.includes('.')) {
      // tag.class selector: div.foo
      const [tag, cls] = trimmed.split('.');
      tagPattern = tag || '[a-z][a-z0-9]*';
      classFilter = cls;
    } else {
      // plain tag selector: h1, p, div, etc.
      tagPattern = trimmed || '[a-z][a-z0-9]*';
    }

    let attrClause = '';
    if (idFilter) {
      attrClause = `(?=[^>]*\\bid=["']${idFilter}["'])`;
    } else if (classFilter) {
      attrClause = `(?=[^>]*\\bclass=["'][^"']*\\b${classFilter}\\b[^"']*["'])`;
    }

    const re = new RegExp(
      `<(${tagPattern})${attrClause}[^>]*>([\\s\\S]*?)<\/\\1>`,
      'gi',
    );

    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const text = stripHtml(m[2]).trim();
      if (text) results.push(text);
    }
  }

  return JSON.stringify(results);
}

/**
 * Parse HTML <table> elements and return as JSON array.
 * Each table becomes { headers: string[], rows: string[][] }.
 */
function extractTables(html: string): string {
  const tables: Array<{ headers: string[]; rows: string[][] }> = [];

  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableM: RegExpExecArray | null;

  while ((tableM = tableRe.exec(html)) !== null) {
    const tableHtml = tableM[1];
    const headers: string[] = [];
    const rows: string[][] = [];

    // Extract header cells from <thead> or first <tr> with <th>
    const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    let thM: RegExpExecArray | null;
    while ((thM = thRe.exec(tableHtml)) !== null) {
      headers.push(stripHtml(thM[1]).trim());
    }

    // Extract data rows — skip rows that only contain th
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trM: RegExpExecArray | null;
    while ((trM = trRe.exec(tableHtml)) !== null) {
      const rowHtml = trM[1];
      // Skip header rows (those with <th> elements)
      if (/<th[^>]*>/i.test(rowHtml)) continue;
      const cells: string[] = [];
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let tdM: RegExpExecArray | null;
      while ((tdM = tdRe.exec(rowHtml)) !== null) {
        cells.push(stripHtml(tdM[1]).trim());
      }
      if (cells.length > 0) rows.push(cells);
    }

    tables.push({ headers, rows });
  }

  return JSON.stringify(tables);
}

/**
 * Extract text from a PDF response body.
 * Attempts to extract readable text between stream/endstream markers.
 * Falls back to a limitation notice if no text streams found.
 */
function extractPdf(body: string): string {
  const texts: string[] = [];

  // Extract content between stream and endstream markers
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(body)) !== null) {
    const chunk = m[1];
    // Extract parenthesised text strings: (Hello World)
    const parenRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
    let pm: RegExpExecArray | null;
    while ((pm = parenRe.exec(chunk)) !== null) {
      const text = pm[1]
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\')
        .replace(/\\\(/g, '(')
        .replace(/\\\)/g, ')')
        .trim();
      if (text.length > 1) texts.push(text);
    }
  }

  if (texts.length === 0) {
    return JSON.stringify({
      note: 'PDF text extraction requires a dedicated library for complex PDFs. No readable text streams found.',
      byteSize: Buffer.byteLength(body, 'utf-8'),
    });
  }

  return texts.join(' ');
}

/** Extract title, meta description, and og: tags from HTML <head>. */
function extractMetadata(html: string): string {
  const result: Record<string, string> = {};

  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleM) result['title'] = stripHtml(titleM[1]);

  const metaRe = /<meta[^>]+>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    // name="description"
    const nameM = tag.match(/name=["'](\w[^"']*)["']/i);
    const contentM = tag.match(/content=["']([^"']*)["']/i);
    if (nameM && contentM) {
      result[nameM[1]] = contentM[1];
    }
    // property="og:..."
    const propM = tag.match(/property=["'](og:[^"']*)["']/i);
    if (propM && contentM) {
      result[propM[1]] = contentM[1];
    }
  }

  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Apply extract mode to raw response text
// ---------------------------------------------------------------------------

function applyExtract(
  body: string,
  contentType: string,
  mode: FetchExtractMode,
  opts?: { selectors?: string[] },
): string {
  const isHtml = /text\/html/i.test(contentType);

  switch (mode) {
    case 'raw':
      return body;

    case 'text':
      return isHtml ? stripHtml(body) : body;

    case 'json': {
      try {
        return JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        return body;
      }
    }

    case 'markdown':
      return isHtml ? htmlToMarkdown(body) : body;

    case 'readable':
      return isHtml ? extractReadable(body) : body;

    case 'code_blocks':
      return isHtml ? extractCodeBlocks(body) : body;

    case 'links':
      return isHtml ? extractLinks(body) : '';

    case 'metadata':
      return isHtml ? extractMetadata(body) : '{}';

    case 'structured': {
      const selectors = opts?.selectors ?? [];
      if (selectors.length === 0) return JSON.stringify([]);
      return isHtml ? extractStructured(body, selectors) : JSON.stringify([]);
    }

    case 'tables':
      return isHtml ? extractTables(body) : JSON.stringify([]);

    case 'pdf': {
      const isPdf = /application\/pdf/i.test(contentType);
      return isPdf ? extractPdf(body) : JSON.stringify({
        note: 'PDF extraction only applies to application/pdf responses.',
      });
    }

    default:
      return body;
  }
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Apply auth headers to the mutable headers map based on an inline FetchAuthInput.
 * Mutates headers in place.
 */
function applyAuthHeaders(headers: Record<string, string>, auth: FetchAuthInput): void {
  switch (auth.type) {
    case 'bearer':
      if (auth.token) {
        headers['Authorization'] = `Bearer ${auth.token}`;
      }
      break;

    case 'basic': {
      const user = auth.username ?? '';
      const pass = auth.password ?? '';
      const encoded = Buffer.from(`${user}:${pass}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
      break;
    }

    case 'api-key': {
      const headerName = auth.header ?? 'X-API-Key';
      if (auth.key) {
        headers[headerName] = auth.key;
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Per-URL fetch
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

async function fetchOne(
  urlInput: FetchUrlInput,
  globalExtract: FetchExtractMode,
  verbosity: FetchVerbosity,
): Promise<FetchUrlResult> {
  const extractMode: FetchExtractMode = urlInput.extract ?? globalExtract;
  const timeoutMs = urlInput.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const method = urlInput.method ?? 'GET';

  // Build headers
  const headers: Record<string, string> = { ...urlInput.headers };

  // Apply inline auth
  if (urlInput.auth) {
    applyAuthHeaders(headers, urlInput.auth);
  } else if (urlInput.service) {
    // Service registry auth — looked up from secrets
    const serviceHeaders = await resolveServiceAuth(urlInput.service);
    if (serviceHeaders) {
      Object.assign(headers, serviceHeaders);
    }
  }

  // Build body
  let body: string | undefined;
  if (urlInput.body !== undefined) {
    body = urlInput.body;
    const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
    if (!hasContentType) {
      if (urlInput.body_type === 'json') {
        headers['Content-Type'] = 'application/json';
      } else if (urlInput.body_type === 'form') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(urlInput.url, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body,
      signal: controller.signal,
    });

    clearTimeout(timer);

    const contentType = response.headers.get('content-type') ?? '';
    const rawBody = await response.text();
    const byteSize = Buffer.byteLength(rawBody, 'utf-8');

    const result: FetchUrlResult = {
      url: urlInput.url,
      status: response.status,
      statusText: response.statusText,
    };

    if (verbosity === 'count_only') {
      return result;
    }

    result.contentType = contentType;
    result.byteSize = byteSize;

    if (verbosity !== 'minimal') {
      result.content = applyExtract(rawBody, contentType, extractMode, { selectors: urlInput.selectors });
    }

    if (verbosity === 'verbose') {
      const respHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        respHeaders[key] = value;
      });
      result.metadata = {
        headers: respHeaders,
        redirected: response.redirected,
        finalUrl: response.url,
      };
    }

    return result;
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const message = isTimeout
      ? `Timeout after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    logger.debug('fetch tool: request failed', { url: urlInput.url, error: message });
    return { url: urlInput.url, error: message };
  }
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

/**
 * FetchTool — implements the `fetch` tool for the ToolRegistry.
 *
 * Fetches one or more URLs in batch with configurable extract modes,
 * timeout per URL, and token-efficient verbosity output.
 * Never throws from execute().
 */
export const fetchTool: Tool = {
  definition: {
    name: 'fetch',
    description:
      'Fetch one or more URLs via HTTP. Supports batch parallel/sequential requests,'
      + ' per-URL method/headers/body, extraction modes (raw, text, json, markdown,'
      + ' readable, code_blocks, links, metadata, structured, tables, pdf),'
      + ' per-URL timeouts, and verbosity control.',
    parameters: FETCH_TOOL_SCHEMA as unknown as Record<string, unknown>,
  },

  async execute(
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    if (!Array.isArray(args.urls) || args.urls.length === 0) {
      return { success: false, error: 'Missing or empty "urls" array' };
    }

    try {
      const input = args as unknown as FetchInput;
      const globalExtract: FetchExtractMode = input.extract ?? 'raw';
      const parallel: boolean = input.parallel !== false; // default true
      const verbosity: FetchVerbosity = input.verbosity ?? 'standard';

      let results: FetchUrlResult[];

      if (parallel) {
        results = await Promise.all(
          input.urls.map((u) => fetchOne(u, globalExtract, verbosity)),
        );
      } else {
        results = [];
        for (const u of input.urls) {
          results.push(await fetchOne(u, globalExtract, verbosity));
        }
      }

      const succeeded = results.filter((r) => r.error === undefined).length;
      const failed = results.filter((r) => r.error !== undefined).length;

      const output: FetchOutput = {
        success: true,
        summary: {
          total: results.length,
          succeeded,
          failed,
        },
      };

      if (verbosity !== 'count_only') {
        output.results = results;
      }

      return { success: true, output: JSON.stringify(output) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('fetch tool: unexpected error', { error: message });
      return { success: false, error: `Unexpected error: ${message}` };
    }
  },
};
