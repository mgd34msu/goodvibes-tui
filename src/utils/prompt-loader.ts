import { readFileSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { logger } from './logger.ts';
import { summarizeError } from './error-display.ts';

/**
 * Read a prompt file, resolving `@path/to/file` includes recursively.
 * Circular includes and missing files are silently skipped.
 * Max include depth: 5 (depths 0-4 inclusive; depth >= 5 returns '').
 *
 * The `visited` Set is intentionally shared across all recursive calls
 * within one top-level invocation. This means a file included from one
 * branch is never re-included from a sibling branch, preventing duplicate
 * content and infinite loops across non-trivially circular graphs.
 */
export function readPromptFile(
  filePath: string,
  visited?: Set<string>,
  depth?: number,
): string {
  const maxDepth = 5;
  const currentDepth = depth ?? 0;
  const seen = visited ?? new Set<string>();

  // Fix #3: >= maxDepth so depths 0-4 are valid (5 levels of nesting)
  if (currentDepth >= maxDepth) return '';

  const resolved = resolve(filePath);
  if (seen.has(resolved)) return ''; // circular include guard
  seen.add(resolved);

  let content: string;
  try {
    content = readFileSync(resolved, 'utf-8');
  } catch (err) {
    // Fix #5: distinguish ENOENT (expected miss) from other errors (unexpected)
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      logger.debug('System prompt file not found', { path: resolved });
    } else {
      logger.error('Failed to read system prompt file', { path: resolved, error: summarizeError(err) });
    }
    return '';
  }

  // Process @ includes
  const baseDir = dirname(resolved);
  const lines = content.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('@') && !trimmed.startsWith('@@')) {
      // @ include directive — resolve and inline the referenced file
      const includePath = trimmed.slice(1).trim();
      if (includePath) {
        const includeResolved = resolve(baseDir, includePath);
        const included = readPromptFile(includeResolved, seen, currentDepth + 1);
        if (included) result.push(included);
      }
    } else {
      // Fix #1: unescape @@ to literal @ (preserving leading whitespace)
      const atIdx = line.indexOf('@@');
      if (trimmed.startsWith('@@') && atIdx >= 0) {
        result.push(line.slice(0, atIdx) + line.slice(atIdx + 1));
      } else {
        result.push(line);
      }
    }
  }

  return result.join('\n');
}

/**
 * Load system prompt by chain-loading SYSTEM.md + global + project GOODVIBES.md files.
 *
 * @param getConfigPath Optional injector for the config-specified systemPromptFile path.
 *                      Defaults to reading from configManager (used in production).
 */
export interface LoadSystemPromptOptions {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly getConfigPath?: () => string | undefined;
  readonly argv?: readonly string[];
}

export function loadSystemPrompt(
  options: LoadSystemPromptOptions,
): string {
  const parts: string[] = [];
  const argv = options.argv ?? process.argv;

  // 1. CLI arg override — exclusive, does not chain with other sources
  const argIdx = argv.indexOf('--system-prompt-file');
  if (argIdx !== -1 && argv[argIdx + 1]) {
    const content = readPromptFile(argv[argIdx + 1]!);
    if (content) return content;
  }

  // 2. ~/.goodvibes/SYSTEM.md (base)
  const systemContent = readPromptFile(join(options.homeDirectory, '.goodvibes', 'SYSTEM.md'));
  if (systemContent) parts.push(systemContent);

  // 3. ~/.goodvibes/GOODVIBES.md (global extensions)
  const globalContent = readPromptFile(join(options.homeDirectory, '.goodvibes', 'GOODVIBES.md'));
  if (globalContent) parts.push(globalContent);

  // 4. .goodvibes/GOODVIBES.md (project)
  const projectContent = readPromptFile(
    join(options.workingDirectory, '.goodvibes', 'GOODVIBES.md'),
  );
  if (projectContent) parts.push(projectContent);

  // 5. Config-specified file (additional, appended last)
  const configPath = options.getConfigPath?.();
  if (typeof configPath === 'string' && configPath) {
    const configContent = readPromptFile(configPath);
    if (configContent) parts.push(configContent);
  }

  return parts.join('\n\n');
}
