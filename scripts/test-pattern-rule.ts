/**
 * test-pattern-rule.ts — pure argv/filter logic backing run-tests.ts's optional
 * positional pattern filter (the TUI's /test <pattern> passthrough).
 *
 * Extracted from run-tests.ts (rather than left inline) so it can be unit
 * tested directly: run-tests.ts itself runs its full test-collection/spawn
 * pipeline as top-level side effects at import time, so importing it from a
 * test would trigger a real test run. This module has no side effects.
 */
import { relative } from 'node:path';

/**
 * Parse the first non-flag positional argv token as the test-file filter
 * pattern. Recognizes and skips the two existing flags (`--coverage`,
 * `--jobs N`) so a pattern can be combined with either; unrecognized flags
 * are skipped defensively rather than treated as the pattern.
 */
export function parseTestPattern(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--coverage') continue;
    if (arg === '--jobs') { i++; continue; } // skip the flag and its value
    if (arg.startsWith('--')) continue; // ignore unrecognized flags defensively
    return arg;
  }
  return undefined;
}

/**
 * Filter absolute test-file paths to those whose path relative to `root`
 * contains `pattern` as a substring. Returns `files` unchanged when `pattern`
 * is undefined.
 */
export function filterTestFilesByPattern(
  files: readonly string[],
  root: string,
  pattern: string | undefined,
): string[] {
  if (!pattern) return [...files];
  return files.filter((f) => relative(root, f).includes(pattern));
}
