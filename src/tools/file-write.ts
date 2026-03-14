import type { Tool, ToolDefinition, ToolResult } from '../types/tools.ts';
import { ToolError } from '../types/errors.ts';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveAndValidatePath } from '../utils/path-safety.ts';

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

  async execute(args: Record<string, unknown>): Promise<Omit<ToolResult, 'callId'>> {
    const path = args['path'];
    const content = args['content'];

    if (typeof path !== 'string' || !path) {
      return { success: false, error: 'Missing required argument: path' };
    }
    if (typeof content !== 'string') {
      return { success: false, error: 'Missing required argument: content' };
    }

    let resolvedPath: string;
    try {
      resolvedPath = resolveAndValidatePath(path);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      // Ensure parent directory exists
      const dir = dirname(resolvedPath);
      await mkdir(dir, { recursive: true });

      const bytesWritten = await Bun.write(resolvedPath, content);

      return {
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
