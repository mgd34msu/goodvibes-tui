import type { ToolDefinition } from '../../types/tools.ts';

/**
 * JSON Schema for the analyze tool's input.
 * A mode router for code analysis: impact, dependencies, dead code,
 * security, coverage, surface, preview, diff, and bundle.
 */
export const analyzeSchema: ToolDefinition = {
  name: 'analyze',
  description:
    'Multi-mode code analysis tool. Modes: impact (change blast radius), ' +
    'dependencies (import graph / circular detection), dead_code (unreferenced exports), ' +
    'security (hardcoded secrets/env audit), coverage (lcov parse), ' +
    'surface (public API exports), preview (diff without writing), ' +
    'diff (git ref diff), bundle (stats.json parse).',
  parameters: {
    type: 'object',
    required: ['mode'],
    properties: {
      mode: {
        type: 'string',
        enum: [
          'impact',
          'dependencies',
          'dead_code',
          'security',
          'coverage',
          'bundle',
          'preview',
          'diff',
          'surface',
        ],
        description: 'Analysis mode to run.',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Target files or directories for analysis.',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory. Defaults to current working directory.',
      },
      // mode: impact
      changes: {
        type: 'string',
        description: 'Description of planned changes (mode: impact).',
      },
      // mode: dependencies
      submode: {
        type: 'string',
        enum: ['analyze', 'circular', 'upgrade'],
        description: 'Sub-mode for dependencies analysis. Default: analyze.',
      },
      // mode: security
      securityScope: {
        type: 'string',
        enum: ['secrets', 'permissions', 'env', 'all'],
        description: 'Security check scope (mode: security). Default: all.',
      },
      // mode: diff
      before: {
        type: 'string',
        description: 'Git ref or file path for before state (mode: diff).',
      },
      after: {
        type: 'string',
        description: 'Git ref or file path for after state (mode: diff).',
      },
      // mode: preview
      find: {
        type: 'string',
        description: 'String to find (mode: preview). Used with replace.',
      },
      replace: {
        type: 'string',
        description: 'Replacement string (mode: preview).',
      },
      // mode: surface
      include: {
        type: 'array',
        items: { type: 'string' },
        description: 'Sections to include in surface output: deps, security, tests, api.',
      },
      output: {
        type: 'object',
        description: 'Output options.',
        properties: {
          format: {
            type: 'string',
            enum: ['summary', 'detailed', 'json'],
            description: 'Output format. Default: json.',
          },
          max_tokens: {
            type: 'integer',
            minimum: 0,
            description: 'Approximate token budget for the response.',
          },
        },
      },
    },
  },
};
