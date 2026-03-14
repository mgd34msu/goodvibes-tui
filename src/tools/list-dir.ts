import type { Tool, ToolDefinition, ToolResult } from '../types/tools.ts';
import { ToolError } from '../types/errors.ts';
import { readdir, stat, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

/**
 * ListDirTool - List directory contents, respecting .gitignore patterns.
 * Permission category: read (auto-approve).
 */
export class ListDirTool implements Tool {
  readonly definition: ToolDefinition = {
    name: 'list_dir',
    description:
      'List files and directories. Respects .gitignore patterns. ' +
      'Supports recursive listing with an optional depth limit.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list. Defaults to current directory.',
        },
        recursive: {
          type: 'boolean',
          description: 'If true, list recursively. Defaults to false.',
        },
        maxDepth: {
          type: 'integer',
          description: 'Maximum recursion depth (only relevant when recursive=true). Defaults to 5.',
        },
      },
      required: [],
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const dirPath = typeof args['path'] === 'string' ? args['path'] : process.cwd();
    const recursive = args['recursive'] === true;
    const maxDepth = typeof args['maxDepth'] === 'number' ? args['maxDepth'] : 5;

    // Load .gitignore patterns from the root
    const ignorePatterns = await loadGitignore(process.cwd());

    try {
      const lines: string[] = [];
      await listDir(resolve(dirPath), lines, recursive, maxDepth, 0, ignorePatterns, dirPath);

      if (lines.length === 0) {
        return { callId: '', success: true, output: '(empty directory)' };
      }

      return { callId: '', success: true, output: lines.join('\n') };
    } catch (err) {
      throw new ToolError(
        `Failed to list directory '${dirPath}': ${err instanceof Error ? err.message : String(err)}`,
        'list_dir',
      );
    }
  }
}

async function listDir(
  dir: string,
  lines: string[],
  recursive: boolean,
  maxDepth: number,
  depth: number,
  ignorePatterns: RegExp[],
  basePath: string,
): Promise<void> {
  let entries: import('node:fs').Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(resolve(basePath), fullPath);

    // Skip ignored paths
    if (isIgnored(relPath, ignorePatterns)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.env') continue; // skip dotfiles except .env

    const indent = '  '.repeat(depth);

    if (entry.isDirectory()) {
      lines.push(`${indent}${entry.name}/`);
      if (recursive && depth < maxDepth) {
        await listDir(fullPath, lines, recursive, maxDepth, depth + 1, ignorePatterns, basePath);
      }
    } else if (entry.isFile()) {
      let size = '';
      try {
        const s = await stat(fullPath);
        size = ` (${formatSize(s.size)})`;
      } catch { /* skip */ }
      lines.push(`${indent}${entry.name}${size}`);
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function loadGitignore(cwd: string): Promise<RegExp[]> {
  const patterns: RegExp[] = [];
  try {
    const content = await readFile(join(cwd, '.gitignore'), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      try {
        // Simple glob-to-regex for .gitignore patterns
        // Escape character-by-character to avoid TS regex literal parsing issues
        const specials = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);
        let escaped = '';
        for (const ch of trimmed) {
          if (specials.has(ch)) {
            escaped += '\\' + ch;
          } else {
            escaped += ch;
          }
        }
        escaped = escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
        patterns.push(new RegExp(`(^|/)${escaped}(/|$)`));
      } catch { /* skip invalid patterns */ }
    }
  } catch { /* no .gitignore */ }
  return patterns;
}

function isIgnored(relPath: string, patterns: RegExp[]): boolean {
  const normalised = relPath.replace(/\\/g, '/');
  return patterns.some((p) => p.test(normalised));
}
