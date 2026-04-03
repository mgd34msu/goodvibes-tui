import { logger } from '../../utils/logger.ts';
import type { Tool, ToolDefinition } from '../../types/tools.ts';
import { FETCH_TOOL_SCHEMA } from './schema.ts';
import type { FetchInput, FetchUrlInput, FetchAuthInput, FetchExtractMode, FetchVerbosity, FetchSanitizeMode } from './schema.ts';
import { resolveServiceAuth } from '../../config/service-registry.ts';
import { applySanitizer, resolveSanitizeMode } from './sanitizer.ts';
import {
  classifyHostTrustTier,
  emitSsrfDeny,
  emitHostTrustTier,
  extractHostname,
  type TrustTierConfig,
} from './trust-tiers.ts';

// ── Feature flag integration ──────────────────────────────────────────────────

/**
 * Thin adapter: checks the runtime feature flag manager if available.
 * Falls back to `false` (disabled) when the manager is not initialised.
 *
 * We import lazily to avoid circular dependency between tools and runtime.
 */
function isFetchSanitizationEnabled(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { FeatureFlagManager } = require('../../runtime/feature-flags/manager.ts') as {
      FeatureFlagManager: { getInstance?: () => { isEnabled(id: string): boolean } };
    };
    const manager = FeatureFlagManager.getInstance?.();
    return manager?.isEnabled('fetch-sanitization') ?? false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Module-level response cache (feature: cache_ttl_seconds)
// ---------------------------------------------------------------------------

interface CacheEntry {
  data: FetchUrlResult;
  timestamp: number;
  /** TTL in seconds for this entry (used during expiry purge). */
  ttl: number;
}

const responseCache = new Map<string, CacheEntry>();
const MAX_CACHE_SIZE = 500;
let cacheWriteCount = 0;

/**
 * Write a cache entry with LRU eviction and periodic expiry purge.
 */
function cacheSet(key: string, entry: CacheEntry): void {
  cacheWriteCount++;
  // Periodically purge expired entries (every 50 writes)
  if (cacheWriteCount % 50 === 0) {
    const now = Date.now();
    for (const [k, v] of responseCache) {
      if (now - v.timestamp > v.ttl * 1000) responseCache.delete(k);
    }
  }
  // LRU eviction: delete oldest entry when at capacity
  if (responseCache.size >= MAX_CACHE_SIZE) {
    const oldest = responseCache.keys().next().value;
    if (oldest !== undefined) responseCache.delete(oldest);
  }
  responseCache.set(key, entry);
}

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
  /** True when the response body was truncated to max_content_length. */
  truncated?: boolean;
  /** True when the result was served from the response cache. */
  from_cache?: boolean;
  /** Whether the request was redirected. */
  redirected?: boolean;
  /** Final URL after any redirects. */
  final_url?: string;
  // redirect_chain reserved for future manual redirect following
  /** Time taken to complete the request in milliseconds. */
  duration_ms?: number;
  /** Estimated token count for the content (Math.ceil(content.length / 4)). */
  tokens_used?: number;
  /**
   * Sanitization mode applied to this response (GC-FETCH-006).
   * Always present unless the request was blocked pre-flight.
   */
  sanitization_tier?: FetchSanitizeMode | 'skipped';
  /**
   * Host trust tier classification for this response (GC-FETCH-006).
   * `trusted` | `unknown` | `blocked`.
   */
  host_trust_tier?: string;
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
    /** Total wall-clock time for all requests in milliseconds. */
    total_ms?: number;
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

/**
 * Extractive summary: return the first heading + first paragraph of text content.
 * Works on HTML (extracts headings and first <p>) or plain text (first two lines).
 */
function extractSummary(body: string, contentType: string): string {
  const isHtml = /text\/html/i.test(contentType);
  if (!isHtml) {
    // For plain text: return the first non-empty paragraph (double newline separated)
    const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    return paragraphs.slice(0, 2).join('\n\n');
  }

  const parts: string[] = [];

  // First heading (h1..h3)
  const headingM = body.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  if (headingM) {
    parts.push(stripHtml(headingM[1]).trim());
  }

  // First paragraph
  const paraM = body.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (paraM) {
    const text = stripHtml(paraM[1]).trim();
    if (text) parts.push(text);
  }

  // Collect remaining headings for outline
  const headingRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let hm: RegExpExecArray | null;
  const headings: string[] = [];
  while ((hm = headingRe.exec(body)) !== null) {
    const level = parseInt(hm[1], 10);
    const text = stripHtml(hm[2]).trim();
    if (text && !parts.includes(text)) {
      headings.push(`${'#'.repeat(level)} ${text}`);
    }
  }

  if (headings.length > 0) {
    parts.push('\nHeadings:\n' + headings.join('\n'));
  }

  return parts.join('\n\n') || extractReadable(body).slice(0, 500);
}

// ---------------------------------------------------------------------------
// Content type sniffing (feature: content type sniffing)
// ---------------------------------------------------------------------------

/**
 * Sniff content type from first 512 bytes when Content-Type is missing or
 * is 'application/octet-stream'. Returns the detected MIME type or the
 * original contentType if nothing is detected.
 */
function sniffContentType(contentType: string, body: string): string {
  const isMissing = !contentType || /application\/octet-stream/i.test(contentType);
  if (!isMissing) return contentType;

  const sample = body.slice(0, 512).trimStart();
  if (/^<!DOCTYPE\s+html/i.test(sample) || /^<html/i.test(sample)) {
    return 'text/html';
  }
  if (/^<\?xml/i.test(sample)) {
    return 'application/xml';
  }
  if (/^[{[]/.test(sample)) {
    return 'application/json';
  }
  return contentType;
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
  const effectiveContentType = sniffContentType(contentType, body);
  const isHtml = /text\/html/i.test(effectiveContentType);

  switch (mode) {
    case 'raw':
      return body;

    case 'text':
      return isHtml ? stripHtml(body) : body;

    case 'json': {
      try {
        return JSON.stringify(JSON.parse(body), null, 2);
      } catch { /* JSON parse fallback — non-JSON content returns as-is */
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
      const isPdf = /application\/pdf/i.test(effectiveContentType);
      return isPdf ? extractPdf(body) : JSON.stringify({
        note: 'PDF extraction only applies to application/pdf responses.',
      });
    }

    case 'summary':
      return extractSummary(body, effectiveContentType);

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

/**
 * Build the effective URL with query params appended.
 */
function buildUrl(base: string, params?: Record<string, string>): string {
  if (!params || Object.keys(params).length === 0) return base;
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new Error(`Invalid URL: ${base}`);
  }
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}

/**
 * Return a cache key string for a URL + params + extract mode + verbosity.
 * Including extract and verbosity prevents poisoning across different output formats.
 */
function cacheKey(
  url: string,
  params: Record<string, string> | undefined,
  extract: FetchExtractMode,
  verbosity: FetchVerbosity,
): string {
  const base = params && Object.keys(params).length > 0
    ? `${url}?${new URLSearchParams(params).toString()}`
    : url;
  return `${base}|${extract}|${verbosity}`;
}

/**
 * Delay execution for the given number of milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface FetchOneOptions {
  globalExtract: FetchExtractMode;
  verbosity: FetchVerbosity;
  cacheTtlSeconds: number;
  maxContentLength?: number;
  /** Sanitization mode to apply to response content (GC-FETCH-006). */
  sanitizeMode: FetchSanitizeMode;
  /** Trust tier configuration (GC-FETCH-006). */
  trustTierConfig: TrustTierConfig;
}

async function fetchOneRaw(
  urlInput: FetchUrlInput,
  headers: Record<string, string>,
  method: string,
  body: string | FormData | undefined,
  effectiveUrl: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), urlInput.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(effectiveUrl, {
      method,
      headers: Object.keys(headers).length > 0 ? (headers as HeadersInit) : undefined,
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchOne(
  urlInput: FetchUrlInput,
  opts: FetchOneOptions,
): Promise<FetchUrlResult> {
  const { globalExtract, verbosity, cacheTtlSeconds, maxContentLength, sanitizeMode, trustTierConfig } = opts;
  const extractMode: FetchExtractMode = urlInput.extract ?? globalExtract;
  const method = urlInput.method ?? 'GET';
  const effectiveMaxContent = urlInput.max_content_length ?? maxContentLength;

  // Build URL with query params
  const effectiveUrl = buildUrl(urlInput.url, urlInput.params);

  // --- Trust tier classification (GC-FETCH-006) ---
  // When the feature flag is disabled, skip SSRF blocking and sanitization.
  const sanitizationEnabled = isFetchSanitizationEnabled();
  const effectiveSanitizeModeForBlocked = sanitizationEnabled ? sanitizeMode : 'none';

  // Block requests to internal/metadata/SSRF-vector hosts pre-request.
  const hostname = extractHostname(urlInput.url);
  // Store result to avoid a second classifyHostTrustTier call below.
  let initialTrustResult: ReturnType<typeof classifyHostTrustTier> | null = null;
  if (hostname !== null) {
    initialTrustResult = classifyHostTrustTier(hostname, trustTierConfig);
    emitHostTrustTier(hostname, urlInput.url, initialTrustResult);

    if (sanitizationEnabled && initialTrustResult.tier === 'blocked') {
      if (initialTrustResult.isSsrf) {
        emitSsrfDeny(hostname, urlInput.url, initialTrustResult.reason);
      }
      return {
        url: urlInput.url,
        error: `Request blocked: ${initialTrustResult.reason}`,
        host_trust_tier: 'blocked',
        sanitization_tier: effectiveSanitizeModeForBlocked,
      };
    }
  }

  // --- Cache check (GET only) ---
  if (cacheTtlSeconds > 0 && method === 'GET') {
    const key = cacheKey(urlInput.url, urlInput.params, extractMode, verbosity);
    const entry = responseCache.get(key);
    if (entry && (Date.now() - entry.timestamp) / 1000 < cacheTtlSeconds) {
      return { ...entry.data, from_cache: true };
    }
  }

  // Build headers
  const headers: Record<string, string> = { ...(urlInput.headers ?? {}) };

  // Apply inline auth
  if (urlInput.auth) {
    applyAuthHeaders(headers, urlInput.auth);
  } else if (urlInput.service) {
    const serviceHeaders = await resolveServiceAuth(urlInput.service);
    if (serviceHeaders) {
      Object.assign(headers, serviceHeaders);
    }
  }

  // JSON auto-negotiation: add Accept: application/json for API-like URLs
  try {
    if (/\/api\/|\/v\d+\/|\/graphql/i.test(effectiveUrl)) {
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'accept')) {
        headers['Accept'] = 'application/json';
      }
    }
  } catch { /* malformed URL, skip auto-negotiation */ }

  // Build body
  let requestBody: string | FormData | undefined;
  const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');

  if (urlInput.body_type === 'multipart' && urlInput.body_data) {
    // Multipart: use FormData
    const form = new FormData();
    for (const [k, v] of Object.entries(urlInput.body_data)) {
      form.append(k, v);
    }
    requestBody = form;
    // Do NOT set Content-Type — fetch sets it automatically with the boundary
  } else if (urlInput.body_base64 !== undefined) {
    // body_base64 takes precedence over body
    requestBody = Buffer.from(urlInput.body_base64, 'base64').toString();
    if (!hasContentType) {
      if (urlInput.body_type === 'json') {
        headers['Content-Type'] = 'application/json';
      } else if (urlInput.body_type === 'form') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }
  } else if (urlInput.body !== undefined) {
    requestBody = urlInput.body;
    if (!hasContentType) {
      if (urlInput.body_type === 'json') {
        headers['Content-Type'] = 'application/json';
      } else if (urlInput.body_type === 'form') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }
  }

  const startTime = performance.now();

  try {
    let response = await fetchOneRaw(urlInput, headers, method, requestBody, effectiveUrl);

    // --- Auth refresh on 401 (feature 3) ---
    // Skip retry for FormData bodies — they cannot be replayed after consumption.
    const retryOnAuth = urlInput.retry_on_auth ?? (urlInput.service !== undefined);
    if (response.status === 401 && retryOnAuth && urlInput.service && !(requestBody instanceof FormData)) {
      // Re-resolve service auth (registry may refresh)
      const refreshedHeaders = await resolveServiceAuth(urlInput.service);
      if (refreshedHeaders) {
        const retryHeaders = { ...headers };
        Object.assign(retryHeaders, refreshedHeaders);
        response = await fetchOneRaw(urlInput, retryHeaders, method, requestBody, effectiveUrl);
      }
    }

    const durationMs = Math.round(performance.now() - startTime);

    let contentType = response.headers.get('content-type') ?? '';
    let rawBody = await response.text();

    // Sniff content type if missing/octet-stream
    contentType = sniffContentType(contentType, rawBody);

    // --- Max content length truncation (feature 6) ---
    let truncated = false;
    if (effectiveMaxContent !== undefined) {
      const buf = Buffer.from(rawBody, 'utf-8');
      if (buf.length > effectiveMaxContent) {
        rawBody = buf.subarray(0, effectiveMaxContent).toString('utf-8');
        truncated = true;
      }
    }

    const byteSize = Buffer.byteLength(rawBody, 'utf-8');

    const result: FetchUrlResult = {
      url: urlInput.url,
      status: response.status,
      statusText: response.statusText,
      duration_ms: durationMs,
    };

    if (verbosity === 'count_only') {
      // Cache result for GET requests
      if (cacheTtlSeconds > 0 && method === 'GET') {
        cacheSet(cacheKey(urlInput.url, urlInput.params, extractMode, verbosity), { data: result, timestamp: Date.now(), ttl: cacheTtlSeconds });
      }
      return result;
    }

    result.contentType = contentType;
    result.byteSize = byteSize;
    if (truncated) result.truncated = true;

    // Redirect tracking (feature 7)
    result.redirected = response.redirected;
    result.final_url = response.url !== effectiveUrl ? response.url : undefined;

    // Determine effective sanitize mode for this URL
    // Trusted hosts keep the caller-specified mode; unknown hosts are forced to at least safe-text
    // When sanitization is disabled via feature flag, bypass entirely.
    let effectiveSanitizeMode = sanitizationEnabled ? sanitizeMode : 'none' as const;
    if (sanitizationEnabled && hostname !== null) {
      // Reuse the trust result stored from the pre-request classification above.
      // Defensive fallback — initialTrustResult is always set when hostname is non-null
      const hostTrustResult = initialTrustResult ?? classifyHostTrustTier(hostname, trustTierConfig);
      result.host_trust_tier = hostTrustResult.tier;
      if (hostTrustResult.tier === 'unknown' && effectiveSanitizeMode === 'none') {
        // Upgrade unknown hosts from none to safe-text for safety
        effectiveSanitizeMode = 'safe-text';
      }
    } else if (hostname !== null && initialTrustResult !== null) {
      result.host_trust_tier = initialTrustResult.tier;
    }

    if (verbosity === 'minimal') {
      // Content is not included in minimal output — sanitization was not applied.
      result.sanitization_tier = 'skipped';
    } else {
      result.sanitization_tier = effectiveSanitizeMode;
    }

    if (verbosity !== 'minimal') {
      const extracted = applyExtract(rawBody, contentType, extractMode, { selectors: urlInput.selectors });
      // Apply sanitization to extracted content
      const sanitized = applySanitizer(extracted, effectiveSanitizeMode);
      logger.debug('SANITIZE_MODE_APPLIED', {
        event: 'SANITIZE_MODE_APPLIED',
        url: urlInput.url,
        mode: effectiveSanitizeMode,
        modified: sanitized.modified,
      });
      result.content = sanitized.content;
      // Token estimation (feature 10)
      result.tokens_used = Math.ceil(sanitized.content.length / 4);
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

    // Cache result for GET requests
    if (cacheTtlSeconds > 0 && method === 'GET') {
      cacheSet(cacheKey(urlInput.url, urlInput.params, extractMode, verbosity), { data: result, timestamp: Date.now(), ttl: cacheTtlSeconds });
    }

    return result;
  } catch (err) {
    const durationMs = Math.round(performance.now() - startTime);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const message = isTimeout
      ? `Timeout after ${urlInput.timeout_ms ?? DEFAULT_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    logger.debug('fetch tool: request failed', { url: urlInput.url, error: message });
    return { url: urlInput.url, error: message, duration_ms: durationMs };
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
      + ' per-URL method/headers/body/params, extraction modes (raw, text, json, markdown,'
      + ' readable, code_blocks, links, metadata, structured, tables, pdf, summary),'
      + ' per-URL timeouts, caching, rate limiting, auth refresh, content-length limits,'
      + ' redirect tracking, timing metrics, token estimation, and verbosity control.',
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
      const cacheTtlSeconds = input.cache_ttl_seconds ?? 0;
      const rateLimitMs = input.rate_limit_ms ?? 0;
      const maxContentLength = input.max_content_length;

      const sanitizeMode = resolveSanitizeMode(input.sanitize_mode);
      const trustTierConfig: TrustTierConfig = {
        trustedHosts: input.trusted_hosts,
        blockedHosts: input.blocked_hosts,
      };

      const fetchOpts: FetchOneOptions = {
        globalExtract,
        verbosity,
        cacheTtlSeconds,
        maxContentLength,
        sanitizeMode,
        trustTierConfig,
      };

      const wallStart = performance.now();
      let results: FetchUrlResult[];

      if (parallel) {
        if (rateLimitMs > 0) {
          logger.debug('fetch tool: rate_limit_ms is ignored in parallel mode; set parallel: false to enforce rate limiting');
        }
        results = await Promise.all(
          input.urls.map((u) => fetchOne(u, fetchOpts)),
        );
      } else {
        results = [];
        for (let i = 0; i < input.urls.length; i++) {
          if (i > 0 && rateLimitMs > 0) {
            await delay(rateLimitMs);
          }
          results.push(await fetchOne(input.urls[i], fetchOpts));
        }
      }

      const totalMs = Math.round(performance.now() - wallStart);
      const succeeded = results.filter((r) => r.error === undefined).length;
      const failed = results.filter((r) => r.error !== undefined).length;

      const output: FetchOutput = {
        success: true,
        summary: {
          total: results.length,
          succeeded,
          failed,
          total_ms: totalMs,
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
