import type { Tool, ToolDefinition, ToolResult } from '../types/tools.ts';
import { ToolError } from '../types/errors.ts';
import { resolveAndValidatePath } from '../utils/path-safety.ts';

const DEFAULT_MAX_RESULTS = 1000;

/**
 * GlobTool - Find files matching glob patterns using Bun's built-in Glob.
 * Permission category: read (auto-approve).
 */
export class GlobTool implements Tool {
  readonly definition: ToolDefinition = {
    name: 'glob',
    description:
      'Find files matching one or more glob patterns. Returns matching file paths.',
    parameters: {
      type: 'object',
      properties: {
        patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more glob patterns (e.g. ["src/**/*.ts", "*.json"]).',
        },
        cwd: {
          type: 'string',
          description: 'Directory to search from. Defaults to current directory.',
        },
        maxResults: {
          type: 'integer',
          description: `Maximum number of files to return. Defaults to ${DEFAULT_MAX_RESULTS}.`,
        },
      },
      required: ['patterns'],
    },
  };

  async execute(args: Record<string, unknown>): Promise<Omit<ToolResult, 'callId'>> {
    const patterns = args['patterns'];
    if (!Array.isArray(patterns) || patterns.length === 0) {
      return { success: false, error: 'Missing required argument: patterns (array)' };
    }

    const rawCwd = typeof args['cwd'] === 'string' ? args['cwd'] : process.cwd();
    const maxResults =
      typeof args['maxResults'] === 'number' ? args['maxResults'] : DEFAULT_MAX_RESULTS;

    let cwd: string;
    try {
      cwd = resolveAndValidatePath(rawCwd);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const allMatches = new Set<string>();

    try {
      for (const pattern of patterns) {
        if (typeof pattern !== 'string') continue;
        if (allMatches.size >= maxResults) break;
        const globber = new Bun.Glob(pattern);
        for await (const match of globber.scan({ cwd, onlyFiles: true })) {
          allMatches.add(match);
          if (allMatches.size >= maxResults) break;
        }
      }
    } catch (err) {
      throw new ToolError(
        `Glob failed: ${err instanceof Error ? err.message : String(err)}`,
        'glob',
      );
    }

    const sorted = Array.from(allMatches).sort();

    if (sorted.length === 0) {
      return { success: true, output: 'No files matched the given patterns.' };
    }

    const truncated = sorted.length >= maxResults ? `\n(results truncated at ${maxResults})` : '';
    return {
      success: true,
      output: sorted.join('\n') + truncated,
    };
  }
}
