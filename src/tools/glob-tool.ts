import type { Tool, ToolDefinition, ToolResult } from '../types/tools.ts';
import { ToolError } from '../types/errors.ts';
import { resolve } from 'node:path';

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
      },
      required: ['patterns'],
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const patterns = args['patterns'];
    if (!Array.isArray(patterns) || patterns.length === 0) {
      return { callId: '', success: false, error: 'Missing required argument: patterns (array)' };
    }

    const cwd = typeof args['cwd'] === 'string' ? resolve(args['cwd']) : process.cwd();
    const allMatches = new Set<string>();

    try {
      for (const pattern of patterns) {
        if (typeof pattern !== 'string') continue;
        const globber = new Bun.Glob(pattern);
        for await (const match of globber.scan({ cwd, onlyFiles: true })) {
          allMatches.add(match);
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
      return { callId: '', success: true, output: 'No files matched the given patterns.' };
    }

    return {
      callId: '',
      success: true,
      output: sorted.join('\n'),
    };
  }
}
