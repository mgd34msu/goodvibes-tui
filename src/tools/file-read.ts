import type { Tool, ToolDefinition, ToolResult } from '../types/tools.ts';
import { ToolError } from '../types/errors.ts';

/**
 * FileReadTool - Read a file's contents, optionally restricted to a line range.
 * Permission category: read (auto-approve).
 */
export class FileReadTool implements Tool {
  readonly definition: ToolDefinition = {
    name: 'file_read',
    description:
      'Read the contents of a file. Optionally specify a line range to read a subset.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative path to the file to read.',
        },
        range: {
          type: 'object',
          description: 'Optional line range (1-based, inclusive).',
          properties: {
            start: { type: 'integer', minimum: 1, description: 'First line to read.' },
            end: { type: 'integer', minimum: 1, description: 'Last line to read.' },
          },
          required: ['start', 'end'],
        },
      },
      required: ['path'],
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const path = args['path'];
    if (typeof path !== 'string' || !path) {
      return { callId: '', success: false, error: 'Missing required argument: path' };
    }

    let text: string;
    try {
      text = await Bun.file(path).text();
    } catch (err) {
      throw new ToolError(
        `Failed to read file '${path}': ${err instanceof Error ? err.message : String(err)}`,
        'file_read',
      );
    }

    const lines = text.split('\n');
    const range = args['range'] as { start: number; end: number } | undefined;

    let subset: string[];
    let rangeNote = '';

    if (range) {
      const start = Math.max(1, range.start);
      const end = Math.min(lines.length, range.end);
      subset = lines.slice(start - 1, end);
      rangeNote = ` (lines ${start}-${end} of ${lines.length})`;
    } else {
      subset = lines;
    }

    // Format output with line numbers
    const numbered = subset
      .map((line, i) => {
        const lineNum = range ? range.start + i : i + 1;
        return `${String(lineNum).padStart(6)} | ${line}`;
      })
      .join('\n');

    return {
      callId: '',
      success: true,
      output: `File: ${path}${rangeNote}\n${numbered}`,
    };
  }
}
