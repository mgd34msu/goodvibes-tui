import type { Tool, ToolDefinition, ToolResult } from '../types/tools.ts';
import { ToolError } from '../types/errors.ts';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { resolveAndValidatePath } from '../utils/path-safety.ts';
import { buildGlobMatcher } from '../utils/glob-to-regex.ts';

const DEFAULT_MAX_RESULTS = 100;
const MAX_PATTERN_LENGTH = 500;
const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1MB
const BINARY_PROBE_BYTES = 8192;

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

  async execute(args: Record<string, unknown>): Promise<Omit<ToolResult, 'callId'>> {
    const pattern = args['pattern'];
    if (typeof pattern !== 'string' || !pattern) {
      return { success: false, error: 'Missing required argument: pattern' };
    }

    if (pattern.length > MAX_PATTERN_LENGTH) {
      return {
        success: false,
        error: `Pattern exceeds maximum length of ${MAX_PATTERN_LENGTH} characters`,
      };
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'g');
      // Quick validation: test on empty string to catch some catastrophic patterns
      regex.test('');
      regex.lastIndex = 0;
    } catch (err) {
      return {
        success: false,
        error: `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const rawPath = typeof args['path'] === 'string' ? args['path'] : process.cwd();
    const glob = typeof args['glob'] === 'string' ? args['glob'] : undefined;
    const maxResults =
      typeof args['maxResults'] === 'number' ? args['maxResults'] : DEFAULT_MAX_RESULTS;

    // Validate the search path is within the project root
    let searchPath: string;
    try {
      searchPath = resolveAndValidatePath(rawPath);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const files = await collectFiles(searchPath, glob);
      const matches: string[] = [];

      for (const file of files) {
        if (matches.length >= maxResults) break;

        // Skip files over the size limit
        let fileStat: Awaited<ReturnType<typeof stat>>;
        try {
          fileStat = await stat(file);
        } catch {
          continue;
        }
        if (fileStat.size > MAX_FILE_SIZE_BYTES) continue;

        // Skip binary files by checking for null bytes in first BINARY_PROBE_BYTES
        let content: string;
        try {
          const raw = await readFile(file);
          const probe = raw.subarray(0, BINARY_PROBE_BYTES);
          if (probe.includes(0)) continue; // null byte found — binary file
          content = raw.toString('utf-8');
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
        return { success: true, output: 'No matches found.' };
      }

      const truncated = matches.length >= maxResults ? `\n(results truncated at ${maxResults})` : '';
      return {
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

