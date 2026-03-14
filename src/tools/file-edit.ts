import type { Tool, ToolDefinition, ToolResult } from '../types/tools.ts';
import { ToolError } from '../types/errors.ts';
import { resolveAndValidatePath } from '../utils/path-safety.ts';

/**
 * FileEditTool - Find an exact string in a file and replace it.
 * Fails if `find` is not found or is not unique (ambiguous edit).
 * Permission category: write (prompt user).
 */
export class FileEditTool implements Tool {
  readonly definition: ToolDefinition = {
    name: 'file_edit',
    description:
      'Edit a file by finding an exact string and replacing it. ' +
      'The `find` string must appear exactly once. Returns a unified diff of changes.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative path to the file to edit.',
        },
        find: {
          type: 'string',
          description: 'Exact string to find in the file. Must be unique.',
        },
        replace: {
          type: 'string',
          description: 'String to replace the found text with.',
        },
      },
      required: ['path', 'find', 'replace'],
    },
  };

  async execute(args: Record<string, unknown>): Promise<Omit<ToolResult, 'callId'>> {
    const path = args['path'];
    const find = args['find'];
    const replace = args['replace'];

    if (typeof path !== 'string' || !path) {
      return { success: false, error: 'Missing required argument: path' };
    }
    if (typeof find !== 'string') {
      return { success: false, error: 'Missing required argument: find' };
    }
    if (typeof replace !== 'string') {
      return { success: false, error: 'Missing required argument: replace' };
    }

    let resolvedPath: string;
    try {
      resolvedPath = resolveAndValidatePath(path);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    let original: string;
    try {
      original = await Bun.file(resolvedPath).text();
    } catch (err) {
      throw new ToolError(
        `Failed to read file '${path}': ${err instanceof Error ? err.message : String(err)}`,
        'file_edit',
      );
    }

    const occurrences = countOccurrences(original, find);
    if (occurrences === 0) {
      return {
        success: false,
        error: `String not found in '${path}'. The find string must match exactly.`,
      };
    }
    if (occurrences > 1) {
      return {
        success: false,
        error: `String found ${occurrences} times in '${path}'. The find string must be unique.`,
      };
    }

    const updated = original.replace(find, replace);

    try {
      await Bun.write(resolvedPath, updated);
    } catch (err) {
      throw new ToolError(
        `Failed to write file '${path}': ${err instanceof Error ? err.message : String(err)}`,
        'file_edit',
      );
    }

    const diff = buildUnifiedDiff(path, original, updated);
    return { success: true, output: diff };
  }
}

/** Count non-overlapping occurrences of needle in haystack. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/** Build a minimal unified diff string between two texts. */
function buildUnifiedDiff(filePath: string, original: string, updated: string): string {
  const oldLines = original.split('\n');
  const newLines = updated.split('\n');

  const header = `--- ${filePath} (original)\n+++ ${filePath} (updated)`;
  const hunks: string[] = [];

  // Simple line-based diff: find first and last changed line
  let firstDiff = -1;
  let lastDiff = -1;
  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLen; i++) {
    if (oldLines[i] !== newLines[i]) {
      if (firstDiff === -1) firstDiff = i;
      lastDiff = i;
    }
  }

  if (firstDiff === -1) {
    return `${header}\n(no changes)`;
  }

  const context = 3;
  const startLine = Math.max(0, firstDiff - context);
  const endOld = Math.min(oldLines.length, lastDiff + context + 1);
  const endNew = Math.min(newLines.length, lastDiff + context + 1);

  const hunkHeader = `@@ -${startLine + 1},${endOld - startLine} +${startLine + 1},${endNew - startLine} @@`;
  const hunkLines: string[] = [hunkHeader];

  for (let i = startLine; i < Math.max(endOld, endNew); i++) {
    const inOld = i < endOld;
    const inNew = i < endNew;
    if (inOld && inNew && oldLines[i] === newLines[i]) {
      hunkLines.push(` ${oldLines[i]}`);
    } else {
      if (inOld && oldLines[i] !== newLines[i]) hunkLines.push(`-${oldLines[i]}`);
      if (inNew && newLines[i] !== oldLines[i]) hunkLines.push(`+${newLines[i]}`);
    }
  }

  hunks.push(hunkLines.join('\n'));
  return `${header}\n${hunks.join('\n')}`;
}
