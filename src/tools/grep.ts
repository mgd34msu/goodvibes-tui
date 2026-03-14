import type { Tool, ToolDefinition, ToolResult } from '../types/tools.ts';
import { ToolError } from '../types/errors.ts';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const DEFAULT_MAX_RESULTS = 100;

/**
 * GrepTool - Search file contents using a regex pattern.
 * Permission category: read (auto-approve).
 */
export class GrepTool implements Tool {
  readonly definition: ToolDefinition = {
    name: 'grep',
    description:
      'Search file contents using a regular expression. Returns matching lines with file paths and line numbers.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regular expression pattern to search for.',
        },
        path: {
          type: 'string',
          description: 'Directory or file path to search. Defaults to current directory.',
        },
        glob: {
          type: 'string',
          description: 'Glob pattern to filter files (e.g. "*.ts", "src/**/*.tsx").',
        },
        maxResults: {
          type: 'integer',
          description: `Maximum number of matches to return. Defaults to ${DEFAULT_MAX_RESULTS}.`,
        },
      },
      required: ['pattern'],
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = args['pattern'];
    if (typeof pattern !== 'string' || !pattern) {
      return { callId: '', success: false, error: 'Missing required argument: pattern' };
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'g');
    } catch (err) {
      return {
        callId: '',
        success: false,
        error: `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const searchPath = typeof args['path'] === 'string' ? args['path'] : process.cwd();
    const glob = typeof args['glob'] === 'string' ? args['glob'] : undefined;
    const maxResults =
      typeof args['maxResults'] === 'number' ? args['maxResults'] : DEFAULT_MAX_RESULTS;

    try {
      const files = await collectFiles(searchPath, glob);
      const matches: string[] = [];

      for (const file of files) {
        if (matches.length >= maxResults) break;

        let content: string;
        try {
          content = await readFile(file, 'utf-8');
        } catch {
          continue; // Skip unreadable files
        }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxResults) break;
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            const rel = relative(process.cwd(), file);
            matches.push(`${rel}:${i + 1}: ${lines[i]}`);
          }
        }
      }

      if (matches.length === 0) {
        return { callId: '', success: true, output: 'No matches found.' };
      }

      const truncated = matches.length >= maxResults ? `\n(results truncated at ${maxResults})` : '';
      return {
        callId: '',
        success: true,
        output: matches.join('\n') + truncated,
      };
    } catch (err) {
      throw new ToolError(
        `Grep failed: ${err instanceof Error ? err.message : String(err)}`,
        'grep',
      );
    }
  }
}

/** Collect all files under a path, optionally filtered by a simple glob pattern. */
async function collectFiles(searchPath: string, glob?: string): Promise<string[]> {
  const files: string[] = [];

  let pathStat: Awaited<ReturnType<typeof stat>>;
  try {
    pathStat = await stat(searchPath);
  } catch {
    return [];
  }

  if (pathStat.isFile()) {
    files.push(searchPath);
    return files;
  }

  // Build a simple glob matcher if provided
  const matcher = glob ? buildGlobMatcher(glob) : null;

  await walkDir(searchPath, files, matcher);
  return files;
}

async function walkDir(
  dir: string,
  files: string[],
  matcher: ((name: string) => boolean) | null,
  depth = 0,
): Promise<void> {
  if (depth > 20) return; // Sanity limit

  let entries: import('node:fs').Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return;
  }

  for (const entry of entries) {
    // Skip hidden dirs and node_modules
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(fullPath, files, matcher, depth + 1);
    } else if (entry.isFile()) {
      if (!matcher || matcher(fullPath)) {
        files.push(fullPath);
      }
    }
  }
}

// Build a simple glob-to-regex matcher for patterns like "*.ts" or "src/**".
function buildGlobMatcher(glob: string): (path: string) => boolean {
  // Escape regex special chars (except * and ?) character-by-character to avoid
  // TypeScript's strict parsing of character class literals inside regex literals.
  const specials = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);
  let escaped = '';
  for (const ch of glob) {
    if (specials.has(ch)) {
      escaped += '\\' + ch;
    } else {
      escaped += ch;
    }
  }
  // Now handle glob wildcards
  escaped = escaped
    .replace(/\*/g, '__STAR__')
    .replace(/__STAR____STAR__\//g, '(?:.+/)?') // **/ => any path prefix
    .replace(/__STAR____STAR__/g, '.+')         // ** => any chars
    .replace(/__STAR__/g, '[^/]*')              // *  => filename chars only
    .replace(/\?/g, '[^/]');                    // ?  => single non-slash char
  const regex = new RegExp(`(^|/)${escaped}$`);
  return (path: string) => regex.test(path.replace(/\\/g, '/'));
}
