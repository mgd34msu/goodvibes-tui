/**
 * GC-ARCH-002: Typed emission enforcement — static lint test.
 *
 * Scans all TypeScript source files and verifies that direct calls to
 * `RuntimeEventBus.emit(` (i.e. `bus.emit(` or `this._bus.emit(` patterns
 * that invoke the raw RuntimeEventBus emit method) appear ONLY within the
 * approved allowlist of files.
 *
 * The allowlist contains:
 * - src/runtime/emitters/**  — the typed wrapper modules (these ARE allowed
 *   to call bus.emit directly; that is their sole purpose)
 * - src/runtime/health/effect-handlers.ts — emits synthetic health events
 *   that are intentionally outside AnyRuntimeEvent; documented cross-domain cast
 *
 * Any other file calling bus.emit on a RuntimeEventBus instance is a violation
 * of the typed emission contract and must be migrated to a wrapper function.
 *
 * Detection strategy:
 * - Look for `.emit(` in .ts files outside the allowlist
 * - Cross-reference with files that import RuntimeEventBus (to filter out
 *   legacy EventBus callers which use the same `.emit(` syntax)
 * - Flag any file that both imports RuntimeEventBus AND calls .emit() directly
 */
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Allowlist — files permitted to call RuntimeEventBus.emit() directly
// ---------------------------------------------------------------------------

/**
 * Normalized path prefixes (relative to project root) that are permitted to
 * contain raw `bus.emit(` calls on a RuntimeEventBus instance.
 *
 * ROLLBACK SUPPRESSION: If a migration is incomplete, add the violating file
 * path to this list temporarily and open a tracking issue. Remove entries as
 * migrations are completed.
 */
const EMIT_ALLOWLIST: readonly string[] = [
  // Typed emitter wrappers — the ONLY approved place for raw RuntimeEventBus.emit()
  'src/runtime/emitters/',
  // Health effect handler: emits synthetic out-of-band events (CASCADE_APPLIED)
  // that are not part of AnyRuntimeEvent. Cast is documented and intentional.
  'src/runtime/health/effect-handlers.ts',
];

// ---------------------------------------------------------------------------
// File system scanner
// ---------------------------------------------------------------------------

function walkTs(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules and hidden directories
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walkTs(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function isAllowlisted(relPath: string): boolean {
  return EMIT_ALLOWLIST.some((allowed) =>
    relPath === allowed || relPath.startsWith(allowed)
  );
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/** Returns true if the file imports RuntimeEventBus from the runtime events module. */
function importsRuntimeEventBus(content: string): boolean {
  // Match: import ... RuntimeEventBus ... from '...runtime/events...'
  return (
    /import\s+(?:type\s+)?\{[^}]*RuntimeEventBus[^}]*\}\s+from/.test(content) ||
    /import\s+type\s+\{[^}]*RuntimeEventBus[^}]*\}\s+from/.test(content)
  );
}

/** Returns lines (1-indexed) where .emit( appears in source. */
function findEmitLines(content: string): Array<{ line: number; text: string }> {
  const results: Array<{ line: number; text: string }> = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match .emit( not preceded by // (skip single-line comments)
    // Note: This regex skips single-line comments but not block comments.
    // Block-commenting .emit() calls is rare and not a practical concern.
    if (/(?<!\/\/.*)\.(emit)\(/.test(line)) {
      results.push({ line: i + 1, text: line.trim() });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GC-ARCH-002: typed emission enforcement', () => {
  const projectRoot = join(import.meta.dir, '../../..');
  const srcDir = join(projectRoot, 'src');
  const allFiles = walkTs(srcDir);

  test('zero raw RuntimeEventBus.emit() calls outside the allowlist', () => {
    const violations: string[] = [];

    for (const absPath of allFiles) {
      const relPath = relative(projectRoot, absPath);

      // Skip allowlisted paths — they are permitted to call emit directly
      if (isAllowlisted(relPath)) continue;

      const content = readFileSync(absPath, 'utf8');

      // Only flag files that use RuntimeEventBus — legacy EventBus files are
      // out of scope for this enforcement rule
      if (!importsRuntimeEventBus(content)) continue;

      const emitLines = findEmitLines(content);
      if (emitLines.length === 0) continue;

      for (const { line, text } of emitLines) {
        violations.push(`${relPath}:${line} — ${text}`);
      }
    }

    if (violations.length > 0) {
      const msg = [
        'GC-ARCH-002 violation: raw RuntimeEventBus.emit() call(s) detected outside allowlist.',
        'Migrate these call sites to typed emitter wrapper functions in src/runtime/emitters/.',
        'If migration is incomplete, add the file to EMIT_ALLOWLIST in',
        'src/test/runtime/emit-enforcement.test.ts as a temporary suppression.',
        '',
        'Violations:',
        ...violations.map((v) => `  - ${v}`),
      ].join('\n');
      throw new Error(msg);
    }

    expect(violations).toHaveLength(0);
  });

  test('allowlist entries are valid paths or prefixes', () => {
    // Sanity check: every allowlist entry must either be an existing file
    // or an existing directory prefix (to prevent stale suppression entries)
    const staleEntries: string[] = [];

    for (const entry of EMIT_ALLOWLIST) {
      const absEntry = join(projectRoot, entry);
      // Entry is either a file or a directory (strip trailing slash for check)
      const toCheck = entry.endsWith('/') ? absEntry.slice(0, -1) : absEntry;
      if (!existsSync(toCheck)) {
        staleEntries.push(entry);
      }
    }

    if (staleEntries.length > 0) {
      throw new Error(
        `Stale EMIT_ALLOWLIST entries (paths no longer exist):\n${staleEntries.map((e) => `  - ${e}`).join('\n')}\nRemove them from the allowlist.`
      );
    }

    expect(staleEntries).toHaveLength(0);
  });

  test('every emitter in src/runtime/emitters/ exports typed wrapper functions', () => {
    const emittersDir = join(srcDir, 'runtime', 'emitters');
    const emitterFiles = readdirSync(emittersDir)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts');

    const missingExports: string[] = [];

    for (const file of emitterFiles) {
      const content = readFileSync(join(emittersDir, file), 'utf8');
      // Each emitter file must export at least one function named emit*
      if (!/export function emit/.test(content)) {
        missingExports.push(`src/runtime/emitters/${file}`);
      }
    }

    if (missingExports.length > 0) {
      throw new Error(
        `Emitter files must export at least one emit* function:\n${missingExports.map((f) => `  - ${f}`).join('\n')}`
      );
    }

    expect(missingExports).toHaveLength(0);
  });
});
