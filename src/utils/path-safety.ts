import { resolve, relative } from 'node:path';
import { getWorkingDirectory } from '../config/index.ts';

/**
 * Resolves an input path against the working directory and validates it is
 * contained within the project root. Throws if the resolved path escapes the
 * root (path traversal attempt).
 */
export function resolveAndValidatePath(inputPath: string): string {
  const root = resolve(getWorkingDirectory());
  const resolved = resolve(root, inputPath);
  const rel = relative(root, resolved);
  // NOTE: This check targets Unix paths only. Windows backslash separators are not handled (acceptable for Linux-targeted TUI).
  if (rel.startsWith('..') || rel.includes('/..')) {
    throw new Error(`Path '${inputPath}' is outside the project root`);
  }
  return resolved;
}
