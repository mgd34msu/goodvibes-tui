import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !rel.includes('/..') && !rel.startsWith('/'));
}

function nearestExistingPath(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * Resolves an input path against the provided project root and validates it is
 * contained within the project root. Throws if the resolved path escapes the
 * root (path traversal attempt).
 */
export function resolveAndValidatePath(inputPath: string, projectRoot: string): string {
  const root = realpathSync(resolve(projectRoot), 'utf8');
  const resolved = resolve(root, inputPath);
  const rel = relative(root, resolved);
  // NOTE: This check targets Unix paths only. Windows backslash separators are not handled (acceptable for Linux-targeted TUI).
  if (rel.startsWith('..') || rel.includes('/..')) {
    throw new Error(`Path '${inputPath}' is outside the project root`);
  }
  const existingPath = nearestExistingPath(resolved);
  const realExistingPath = realpathSync(existingPath, 'utf8');
  if (!isInsideRoot(root, realExistingPath)) {
    throw new Error(`Path '${inputPath}' is outside the project root`);
  }
  if (existsSync(resolved)) {
    const realTargetPath = realpathSync(resolved, 'utf8');
    if (!isInsideRoot(root, realTargetPath)) {
      throw new Error(`Path '${inputPath}' is outside the project root`);
    }
  }
  return resolved;
}
