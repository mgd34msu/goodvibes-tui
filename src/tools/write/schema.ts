/**
 * JSON Schema definition for the write tool input.
 */
export const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      description: 'Array of files to write.',
      items: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to write, relative to project root or absolute.',
          },
          content: {
            type: 'string',
            description: 'UTF-8 file content to write.',
          },
          content_base64: {
            type: 'string',
            description:
              'Base64-encoded file content. Use when content contains single quotes, backticks, or ${} patterns.',
          },
          encoding: {
            type: 'string',
            description: 'File encoding. Default: utf-8.',
            default: 'utf-8',
          },
          mode: {
            type: 'string',
            enum: ['fail_if_exists', 'overwrite', 'backup'],
            description:
              'Behaviour when the file already exists. ' +
              'fail_if_exists (default): return an error. ' +
              'overwrite: replace existing content. ' +
              'backup: copy existing file to .goodvibes/.backups/ before overwriting.',
            default: 'fail_if_exists',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      minItems: 1,
    },
    verbosity: {
      type: 'string',
      enum: ['count_only', 'minimal', 'standard', 'verbose'],
      description:
        'Output detail level. Default: count_only (recommended — you provided the content).',
      default: 'count_only',
    },
    dry_run: {
      type: 'boolean',
      description: 'If true, validate and plan writes but do not write any files.',
      default: false,
    },
    validate: {
      type: 'object',
      description: 'Run validators after all files have been written.',
      properties: {
        after: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['typecheck', 'lint', 'test', 'build'],
          },
          description: 'Validators to run after writing. Failures are reported but do NOT undo writes.',
        },
      },
      additionalProperties: false,
    },
    transaction: {
      type: 'object',
      description: 'Batch transaction behaviour when one or more file writes fail.',
      properties: {
        mode: {
          type: 'string',
          enum: ['atomic', 'partial', 'none'],
          description:
            'atomic: if any write fails, undo all previously written files (restores originals). '
            + 'partial: skip failed writes but continue. '
            + 'none (default): same as partial — no rollback.',
          default: 'none',
        },
      },
      additionalProperties: false,
    },
  },
  required: ['files'],
  additionalProperties: false,
} as const;

export type WriteMode = 'fail_if_exists' | 'overwrite' | 'backup';
export type WriteVerbosity = 'count_only' | 'minimal' | 'standard' | 'verbose';
export type WriteValidatorName = 'typecheck' | 'lint' | 'test' | 'build';
export type WriteTransactionMode = 'atomic' | 'partial' | 'none';

export interface WriteFileInput {
  path: string;
  content?: string;
  content_base64?: string;
  encoding?: string;
  mode?: WriteMode;
}

export interface WriteInput {
  files: WriteFileInput[];
  verbosity?: WriteVerbosity;
  dry_run?: boolean;
  validate?: {
    after?: WriteValidatorName[];
  };
  transaction?: {
    mode?: WriteTransactionMode;
  };
}
