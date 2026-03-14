import type { Tool, ToolDefinition, ToolResult } from '../types/tools.ts';
import { ToolError } from '../types/errors.ts';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * FileWriteTool - Write content to a file, creating parent directories if needed.
 * Permission category: write (prompt user).
 */
export class FileWriteTool implements Tool {
  readonly definition: ToolDefinition = {
    name: 'file_write',
    description:
      'Write content to a file. Creates the file and any parent directories if they do not exist.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative path to the file to write.',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file.',
        },
      },
      required: ['path', 'content'],
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const path = args['path'];
    const content = args['content'];

    if (typeof path !== 'string' || !path) {
      return { callId: '', success: false, error: 'Missing required argument: path' };
    }
    if (typeof content !== 'string') {
      return { callId: '', success: false, error: 'Missing required argument: content' };
    }

    try {
      // Ensure parent directory exists
      const dir = dirname(path);
      await mkdir(dir, { recursive: true });

      const bytesWritten = await Bun.write(path, content);

      return {
        callId: '',
        success: true,
        output: `Wrote ${bytesWritten} bytes to ${path}`,
      };
    } catch (err) {
      throw new ToolError(
        `Failed to write file '${path}': ${err instanceof Error ? err.message : String(err)}`,
        'file_write',
      );
    }
  }
}
