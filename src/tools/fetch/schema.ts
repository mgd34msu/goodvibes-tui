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
            enum: ['raw', 'text', 'json', 'markdown', 'readable', 'code_blocks', 'links', 'metadata', 'structured', 'tables', 'pdf'],
            description:
              'Extraction mode for this URL. Overrides the global extract.'
              + ' raw: raw response body; text: plain text, strips HTML tags;'
              + ' json: parse and format JSON; markdown: convert HTML to markdown;'
              + ' readable: extract main content, strip nav/sidebar/footer;'
              + ' code_blocks: extract <pre>/<code> blocks;'
              + ' links: extract all URLs; metadata: extract title/og-tags;'
              + ' structured: extract text of elements matching CSS selectors (requires selectors field);'
              + ' tables: parse <table> elements into JSON arrays;'
              + ' pdf: extract text from PDF responses.',
          },
          selectors: {
            type: 'array',
            items: { type: 'string' },
            description: 'CSS selectors for structured extraction mode. Each matched element text is returned as an array item.',
          },
          timeout_ms: {
            type: 'integer',
            minimum: 1,
            description: 'Per-URL timeout in milliseconds. Default 30000.',
          },
          service: {
            type: 'string',
            description: 'Named service for automatic credential lookup from the service registry.',
          },
          auth: {
            type: 'object',
            description: 'Inline auth configuration. Applied directly without registry lookup.',
            properties: {
              type: {
                type: 'string',
                enum: ['bearer', 'basic', 'api-key'],
                description: 'Auth type.',
              },
              token: { type: 'string', description: 'Bearer token (for type bearer).' },
              username: { type: 'string', description: 'Username (for type basic).' },
              password: { type: 'string', description: 'Password (for type basic).' },
              header: { type: 'string', description: 'Header name (for type api-key). Defaults to X-API-Key.' },
              key: { type: 'string', description: 'API key value (for type api-key).' },
            },
            required: ['type'],
          },
        },
        required: ['url'],
      },
      minItems: 1,
    },
    extract: {
      type: 'string',
      enum: ['raw', 'text', 'json', 'markdown', 'readable', 'code_blocks', 'links', 'metadata', 'structured', 'tables', 'pdf'],
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
  | 'metadata'
  | 'structured'
  | 'tables'
  | 'pdf';

/** Output verbosity format. */
export type FetchVerbosity = 'count_only' | 'minimal' | 'standard' | 'verbose';

/** Auth config for a single URL. */
export interface FetchAuthInput {
  type: 'bearer' | 'basic' | 'api-key';
  /** Bearer token (used with type 'bearer'). */
  token?: string;
  /** Username for basic auth (used with type 'basic'). */
  username?: string;
  /** Password for basic auth (used with type 'basic'). */
  password?: string;
  /** Header name for API key auth (used with type 'api-key'). Defaults to X-API-Key. */
  header?: string;
  /** API key value (used with type 'api-key'). */
  key?: string;
}

/** Input shape for a single URL entry. */
export interface FetchUrlInput {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: string;
  body_type?: 'json' | 'form' | 'raw';
  extract?: FetchExtractMode;
  /** CSS selectors for structured extraction mode. */
  selectors?: string[];
  timeout_ms?: number;
  /** Named service for automatic credential lookup from the service registry. */
  service?: string;
  /** Inline auth configuration. Applied directly without registry lookup. */
  auth?: FetchAuthInput;
}

/** Full input shape for the fetch tool. */
export interface FetchInput {
  urls: FetchUrlInput[];
  extract?: FetchExtractMode;
  parallel?: boolean;
  verbosity?: FetchVerbosity;
}
