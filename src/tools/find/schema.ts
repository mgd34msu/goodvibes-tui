import type { ToolDefinition } from '../../types/tools.ts';

/**
 * JSON Schema for the find tool's input.
 * Supports three modes: files (glob), content (grep), symbols (regex-based extraction).
 */
export const findSchema: ToolDefinition = {
  name: 'find',
  description:
    'Search the codebase using glob patterns, regex content search, or symbol extraction. ' +
    'Supports multiple queries in one call. Modes: files (glob), content (grep), symbols (regex).',
  parameters: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        description: 'One or more search queries to execute.',
        items: {
          type: 'object',
          required: ['id', 'mode'],
          properties: {
            id: {
              type: 'string',
              description: 'Unique identifier for this query. Results are keyed by this id.',
            },
            mode: {
              type: 'string',
              enum: ['files', 'content', 'symbols', 'references', 'structural'],
              description: 'Search mode: files (glob), content (grep), symbols (regex extraction), references (find all references via LSP with grep fallback), structural (AST pattern matching via ast-grep).',
            },
            // files mode
            patterns: {
              type: 'array',
              items: { type: 'string' },
              description: 'Glob patterns (mode: files).',
            },
            exclude: {
              type: 'array',
              items: { type: 'string' },
              description: 'Glob patterns to exclude (mode: files).',
            },
            min_size: {
              type: 'integer',
              minimum: 0,
              description: 'Minimum file size in bytes (mode: files).',
            },
            max_size: {
              type: 'integer',
              minimum: 0,
              description: 'Maximum file size in bytes (mode: files).',
            },
            modified_after: {
              type: 'string',
              description: 'ISO date string — include only files modified after this date (mode: files).',
            },
            modified_before: {
              type: 'string',
              description: 'ISO date string — include only files modified before this date (mode: files).',
            },
            respect_gitignore: {
              type: 'boolean',
              description: 'Exclude files matched by .gitignore patterns (mode: files). Default: true. Note: only reads the project root .gitignore — nested .gitignore files are not applied.',
            },
            sort_by: {
              type: 'string',
              enum: ['name', 'size', 'modified'],
              description: 'Sort results by name, size, or modified date (mode: files). Default: name.',
            },
            sort_order: {
              type: 'string',
              enum: ['asc', 'desc'],
              description: 'Sort direction (mode: files). Default: asc.',
            },
            has_content: {
              type: 'string',
              description: 'Regex pattern — include only files whose content matches (mode: files).',
            },
            is_empty: {
              type: 'boolean',
              description: 'When true include only empty files; when false exclude empty files (mode: files).',
            },
            follow_symlinks: {
              type: 'boolean',
              description: 'Follow symbolic links when collecting files (mode: files). Default: false.',
            },
            include_hidden: {
              type: 'boolean',
              description: 'Include hidden files and directories (dot-prefixed) (mode: files). Default: false.',
            },
            // content mode
            pattern: {
              type: 'string',
              description: 'Regex search pattern (mode: content).',
            },
            pattern_base64: {
              type: 'string',
              description: 'Base64-encoded regex pattern, alternative to pattern (mode: content).',
            },
            glob: {
              type: 'string',
              description: 'File filter glob pattern (mode: content).',
            },
            path: {
              type: 'string',
              description: 'Directory to search (modes: content, symbols). Defaults to project root.',
            },
            case_sensitive: {
              type: 'boolean',
              description: 'Case-sensitive matching (mode: content). Default: true.',
            },
            whole_word: {
              type: 'boolean',
              description: 'Match whole words only (mode: content).',
            },
            multiline: {
              type: 'boolean',
              description: 'Enable multiline regex (mode: content). Default: false.',
            },
            negate: {
              type: 'boolean',
              description: 'Return files that do NOT match the pattern (mode: content).',
            },
            ranked: {
              type: 'boolean',
              description:
                'Sort results by relevance (mode: content). Exact matches score +10, matches in export declarations +5, recently modified files +3. Results sorted by score descending.',
            },
            preview_replace: {
              type: 'string',
              description:
                'Replacement string (mode: content). When provided, shows what each matched line would look like after replacement WITHOUT writing to disk. Adds original and replaced fields to each match.',
            },
            relationships: {
              type: 'boolean',
              description:
                'Include import/export relationships (mode: content). For each matched file, shows which files import it and which files it imports.',
            },
            // references mode
            symbol: {
              type: 'string',
              description: 'Symbol name to search for references to (mode: references).',
            },
            file: {
              type: 'string',
              description: 'File path containing the symbol (mode: references).',
            },
            line: {
              type: 'integer',
              minimum: 0,
              description: 'Zero-based line number of the symbol (mode: references).',
            },
            column: {
              type: 'integer',
              minimum: 0,
              description: 'Zero-based column offset of the symbol (mode: references).',
            },
            // symbols mode
            query: {
              type: 'string',
              description: 'Symbol name pattern to filter by (modes: content context, symbols).',
            },
            kinds: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['function', 'class', 'interface', 'type', 'variable', 'constant', 'enum'],
              },
              description: 'Symbol kinds to include (mode: symbols).',
            },
            exported_only: {
              type: 'boolean',
              description: 'Only return exported symbols (mode: symbols). Default: false.',
            },
            include_private: {
              type: 'boolean',
              description:
                'Include non-exported (private) symbols (mode: symbols). When true, overrides exported_only and includes all symbols regardless of export status.',
            },
            group_by: {
              type: 'string',
              enum: ['file', 'kind', 'none'],
              description: 'Group symbol results (mode: symbols). file: group by file path, kind: group by symbol kind, none: flat list (default).',
            },
            // structural mode
            lang: {
              type: 'string',
              enum: ['ts', 'tsx', 'js', 'jsx', 'css', 'html'],
              description:
                'Language for AST parsing (mode: structural). Auto-detected from file extension when omitted. ' +
                'Supported: ts, tsx, js, jsx, css, html. Files with unrecognized extensions are skipped.',
            },
          },
        },
      },
      output: {
        type: 'object',
        description: 'Output format options.',
        properties: {
          format: {
            type: 'string',
            enum: ['count_only', 'files_only', 'locations', 'matches', 'context', 'with_stats', 'with_preview', 'signatures', 'full'],
            description:
              'Progressive disclosure format. count_only < files_only < locations < matches < context. ' +
              'with_stats returns file size and modified date per file (mode: files). ' +
              'with_preview returns first N lines of each file (mode: files, controlled by preview_lines). ' +
              'signatures: include full function/method signature with params+return type (mode: symbols). ' +
              'full: include signature + JSDoc comment + container class/namespace (mode: symbols).',
          },
          preview_lines: {
            type: 'integer',
            minimum: 1,
            description: 'Number of lines to include in preview (format: with_preview). Default: 3.',
          },
          context_before: {
            type: 'integer',
            minimum: 0,
            description: 'Lines before each match (format: context).',
          },
          context_after: {
            type: 'integer',
            minimum: 0,
            description: 'Lines after each match (format: context).',
          },
          expand_to: {
            type: 'string',
            enum: ['line', 'block', 'function', 'class'],
            description:
              'Expand each content match to its enclosing scope. ' +
              "'function' expands to the enclosing function/method, 'class' to the enclosing class. " +
              'Adds startLine and endLine fields to each match. ' +
              'Requires tree-sitter grammar for the file language; silently ignored otherwise. ' +
              "'line' and 'block' are accepted but currently behave the same as no expansion.",
          },
          max_results: {
            type: 'integer',
            minimum: 0,
            description: 'Maximum total results per query. Default: 100.',
          },
          max_per_item: {
            type: 'integer',
            minimum: 0,
            description: 'Maximum matches per file. Default: 10.',
          },
          max_total_matches: {
            type: 'integer',
            minimum: 0,
            description: 'Maximum total matches across all files. Default: 100.',
          },
          max_tokens: {
            type: 'integer',
            minimum: 0,
            description: 'Approximate token budget for the response.',
          },
          max_line_length: {
            type: 'integer',
            minimum: 1,
            description: 'Truncate matched lines longer than this value (mode: content). Adds "..." suffix when truncated.',
          },
        },
      },
      parallel: {
        type: 'boolean',
        description: 'Execute queries concurrently. Default: true.',
      },
    },
    required: ['queries'],
  },
};
