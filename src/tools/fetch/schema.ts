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
          params: {
            type: 'object',
            description: 'Query parameters to append to the URL as a query string.',
            additionalProperties: { type: 'string' },
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
          body_base64: {
            type: 'string',
            description: 'Base64-encoded request body. Decoded before sending. Takes precedence over body.',
          },
          body_type: {
            type: 'string',
            enum: ['json', 'form', 'raw', 'multipart'],
            description:
              'How to encode the body. json: sets Content-Type application/json;'
              + ' form: URL-encodes body_data or sends body as application/x-www-form-urlencoded;'
              + ' multipart: builds a FormData body from body_data (object of key-value pairs);'
              + ' raw: sends as-is.',
          },
          body_data: {
            type: 'object',
            description:
              'Key-value pairs for structured request bodies.'
              + ' For form, entries are URL-encoded into the request body.'
              + ' For multipart, each entry becomes a FormData field.',
            additionalProperties: { type: 'string' },
          },
          extract: {
            type: 'string',
            enum: ['raw', 'text', 'json', 'markdown', 'readable', 'code_blocks', 'links', 'metadata', 'structured', 'tables', 'pdf', 'summary'],
            description:
              'Extraction mode for this URL. Overrides the global extract.'
              + ' raw: raw response body; text: plain text, strips HTML tags;'
              + ' json: parse and format JSON; markdown: convert HTML to markdown;'
              + ' readable: extract main content, strip nav/sidebar/footer;'
              + ' code_blocks: extract <pre>/<code> blocks;'
              + ' links: extract all URLs; metadata: extract title/og-tags;'
              + ' structured: extract text of elements matching CSS selectors (requires selectors field);'
              + ' tables: parse <table> elements into JSON arrays;'
              + ' pdf: extract text from PDF responses;'
              + ' summary: extractive summary (first paragraph + headings).',
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
          max_content_length: {
            type: 'integer',
            minimum: 1,
            description: 'Maximum response body size in bytes. Responses exceeding this are truncated. Overrides global max_content_length.',
          },
          retry_on_auth: {
            type: 'boolean',
            description: 'When a service is specified and a 401 is returned, attempt to refresh auth and retry once. Defaults to true when service is specified.',
          },
          service: {
            type: 'string',
            description: 'Named service for automatic credential lookup from the service registry. Services are configured in .goodvibes/tui/services.json. Use the registry tool or check .goodvibes/tui/services.json to discover available service names.',
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
      enum: ['raw', 'text', 'json', 'markdown', 'readable', 'code_blocks', 'links', 'metadata', 'structured', 'tables', 'pdf', 'summary'],
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
    cache_ttl_seconds: {
      type: 'integer',
      minimum: 0,
      description: 'Cache GET responses by URL+params for this many seconds. 0 disables caching (default).',
    },
    rate_limit_ms: {
      type: 'integer',
      minimum: 0,
      description: 'Minimum delay in milliseconds between sequential requests. 0 disables rate limiting (default). Has no effect in parallel mode.',
    },
    max_content_length: {
      type: 'integer',
      minimum: 1,
      description: 'Global maximum response body size in bytes. Responses exceeding this are truncated. Can be overridden per-URL.',
    },
    sanitize_mode: {
      type: 'string',
      enum: ['none', 'safe-text', 'strict'],
      description:
        'Response sanitization mode applied to all URL responses.'
        + ' none: content returned verbatim (trusted hosts only);'
        + ' safe-text: strips script/style blocks and control characters (default);'
        + ' strict: strips all HTML and non-printable characters (untrusted hosts).',
    },
    trusted_hosts: {
      type: 'array',
      items: { type: 'string' },
      description: 'Hostnames or glob patterns explicitly trusted. Trusted hosts may use sanitize_mode: none.',
    },
    blocked_hosts: {
      type: 'array',
      items: { type: 'string' },
      description: 'Hostnames or glob patterns explicitly blocked. Denied pre-request regardless of other config.',
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
  | 'pdf'
  | 'summary';

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
  /** Query parameters appended as a query string to the URL. */
  params?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
  /** Base64-encoded request body. Decoded before sending. Takes precedence over body. */
  body_base64?: string;
  body_type?: 'json' | 'form' | 'raw' | 'multipart';
  /** Key-value pairs used when body_type is 'form' or 'multipart'. */
  body_data?: Record<string, string>;
  extract?: FetchExtractMode;
  /** CSS selectors for structured extraction mode. */
  selectors?: string[];
  timeout_ms?: number;
  /** Maximum response body size in bytes. Overrides global max_content_length. */
  max_content_length?: number;
  /** When a service is specified and a 401 is returned, refresh auth and retry once. */
  retry_on_auth?: boolean;
  /** Named service for automatic credential lookup from the service registry. */
  service?: string;
  /** Inline auth configuration. Applied directly without registry lookup. */
  auth?: FetchAuthInput;
}

/**
 * Sanitization mode for response content.
 *
 * Re-exported from sanitizer.ts to avoid duplication. `FetchSanitizeMode`
 * is an alias for `SanitizeMode`.
 */
import type { SanitizeMode } from './sanitizer.ts';
/** Sanitization mode alias — re-exported from sanitizer.ts to avoid duplication. */
export type FetchSanitizeMode = SanitizeMode;

/** Full input shape for the fetch tool. */
export interface FetchInput {
  urls: FetchUrlInput[];
  extract?: FetchExtractMode;
  parallel?: boolean;
  verbosity?: FetchVerbosity;
  /** Cache GET responses by URL+params for this many seconds. 0 = disabled (default). */
  cache_ttl_seconds?: number;
  /** Minimum delay in ms between sequential requests. 0 = disabled (default). */
  rate_limit_ms?: number;
  /** Global maximum response body size in bytes. */
  max_content_length?: number;
  /**
   * Response sanitization mode applied to all URL responses.
   * Defaults to `'safe-text'` when omitted (rollback-safe default for fetch sanitization).
   */
  sanitize_mode?: FetchSanitizeMode;
  /** Hostnames or glob patterns explicitly trusted. Trusted hosts may use sanitize_mode: none. */
  trusted_hosts?: string[];
  /** Hostnames or glob patterns explicitly blocked. Denied pre-request regardless of other config. */
  blocked_hosts?: string[];
}
