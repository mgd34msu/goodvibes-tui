/**
 * JSON Schema definition for the `fetch` tool.
 *
 * The fetch tool performs HTTP requests in batch, with per-URL extract modes,
 * timeout support, and token-efficient verbosity output.
 */
export const FETCH_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    urls: {
      type: 'array',
      description: 'URLs to fetch. Processed as a batch in one call.',
      items: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch.',
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
            description: 'HTTP method. Defaults to GET.',
          },
          headers: {
            type: 'object',
            description: 'HTTP headers to include in the request.',
            additionalProperties: { type: 'string' },
          },
          body: {
            type: 'string',
            description: 'Request body string.',
          },
          body_type: {
            type: 'string',
            enum: ['json', 'form', 'raw'],
            description:
              'How to encode the body. json: sets Content-Type application/json;'
              + ' form: sets Content-Type application/x-www-form-urlencoded;'
              + ' raw: sends as-is.',
          },
          extract: {
            type: 'string',
            enum: ['raw', 'text', 'json', 'markdown', 'readable', 'code_blocks', 'links', 'metadata'],
            description:
              'Extraction mode for this URL. Overrides the global extract.'
              + ' raw: raw response body; text: plain text, strips HTML tags;'
              + ' json: parse and format JSON; markdown: convert HTML to markdown;'
              + ' readable: extract main content, strip nav/sidebar/footer;'
              + ' code_blocks: extract <pre>/<code> blocks;'
              + ' links: extract all URLs; metadata: extract title/og-tags.',
          },
          timeout_ms: {
            type: 'integer',
            minimum: 1,
            description: 'Per-URL timeout in milliseconds. Default 30000.',
          },
        },
        required: ['url'],
      },
      minItems: 1,
    },
    extract: {
      type: 'string',
      enum: ['raw', 'text', 'json', 'markdown', 'readable', 'code_blocks', 'links', 'metadata'],
      description: 'Global extraction mode applied to all URLs unless overridden per-URL. Defaults to raw.',
    },
    parallel: {
      type: 'boolean',
      description: 'Fetch URLs in parallel using Promise.all. Default true.',
    },
    verbosity: {
      type: 'string',
      enum: ['count_only', 'minimal', 'standard', 'verbose'],
      description:
        'count_only: totals only; minimal: URL + status + byte size;'
        + ' standard: URL + status + content (default); verbose: all metadata.',
    },
  },
  required: ['urls'],
} as const;

/** Extraction mode for a single URL or globally. */
export type FetchExtractMode =
  | 'raw'
  | 'text'
  | 'json'
  | 'markdown'
  | 'readable'
  | 'code_blocks'
  | 'links'
  | 'metadata';

/** Output verbosity format. */
export type FetchVerbosity = 'count_only' | 'minimal' | 'standard' | 'verbose';

/** Input shape for a single URL entry. */
export interface FetchUrlInput {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: string;
  body_type?: 'json' | 'form' | 'raw';
  extract?: FetchExtractMode;
  timeout_ms?: number;
}

/** Full input shape for the fetch tool. */
export interface FetchInput {
  urls: FetchUrlInput[];
  extract?: FetchExtractMode;
  parallel?: boolean;
  verbosity?: FetchVerbosity;
}
