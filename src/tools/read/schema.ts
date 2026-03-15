/**
 * JSON Schema definition for the `read` tool.
 *
 * The read tool accepts a list of files and returns their content (or a
 * transformed view of it) in one batched response.
 */
export const READ_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      description: 'Files to read. Processed as a batch in one call.',
      items: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative or absolute path to the file.',
          },
          extract: {
            type: 'string',
            enum: ['content', 'outline', 'symbols', 'ast', 'lines'],
            description:
              'Extraction mode. Overrides the global extract for this file.'
              + ' content: full text; outline: signatures without bodies;'
              + ' symbols: exported names only; lines: specific line range;'
              + ' ast: structural outline (Phase 3 placeholder).',
          },
          range: {
            type: 'object',
            description: 'Line range to read (1-based, inclusive). Used with extract=lines.',
            properties: {
              start: { type: 'integer', minimum: 1 },
              end: { type: 'integer', minimum: 1 },
            },
            required: ['start', 'end'],
          },
          force: {
            type: 'boolean',
            description: 'Bypass cache and re-read the file from disk.',
          },
        },
        required: ['path'],
      },
      minItems: 1,
    },
    extract: {
      type: 'string',
      enum: ['content', 'outline', 'symbols', 'ast', 'lines'],
      description:
        'Global extraction mode applied to all files unless overridden per-file.'
        + ' Defaults to content.',
    },
    output: {
      type: 'object',
      description: 'Output formatting options.',
      properties: {
        format: {
          type: 'string',
          enum: ['count_only', 'minimal', 'standard', 'verbose'],
          description:
            'count_only: file count + totals; minimal: paths + line counts;'
            + ' standard: full content with line numbers (default);'
            + ' verbose: full content + metadata.',
        },
        include_line_numbers: {
          type: 'boolean',
          description: 'Include line numbers in content output. Default true.',
        },
        max_per_item: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum lines to return per file.',
        },
        max_tokens: {
          type: 'integer',
          minimum: 1,
          description: 'Hard token cap across the entire response.',
        },
      },
    },
    token_budget: {
      type: 'integer',
      minimum: 1,
      description:
        'Token budget for paginated reads. When set, results are binned into'
        + ' pages that fit within the budget.',
    },
    page: {
      type: 'integer',
      minimum: 1,
      description: 'Page number to return when using token_budget pagination. Default 1.',
    },
  },
  required: ['files'],
} as const;

/** Extract mode for a single file or globally. */
export type ExtractMode = 'content' | 'outline' | 'symbols' | 'ast' | 'lines';

/** Output verbosity format. */
export type OutputFormat = 'count_only' | 'minimal' | 'standard' | 'verbose';

/** Input shape for a single file entry in the read tool. */
export interface ReadFileInput {
  path: string;
  extract?: ExtractMode;
  range?: { start: number; end: number };
  force?: boolean;
}

/** Full input shape for the read tool. */
export interface ReadInput {
  files: ReadFileInput[];
  extract?: ExtractMode;
  output?: {
    format?: OutputFormat;
    include_line_numbers?: boolean;
    max_per_item?: number;
    max_tokens?: number;
  };
  token_budget?: number;
  page?: number;
}
