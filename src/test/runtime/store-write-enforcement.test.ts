// Deliberately per-repo test, byte-identical to the sibling product's copy by design: it walks THIS repo's own src/runtime tree to pin that product's store-write boundary, so a shared home would have nothing to scan.
/**
 * GC-ARCH-003: Runtime store write enforcement, static architecture test.
 *
 * Production runtime code must not call Zustand `store.setState(...)`
 * outside the store mutation layer in `src/runtime/store/index.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

function walkTs(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walkTs(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

const SET_STATE_ALLOWLIST = new Set([
  'src/runtime/store/index.ts',
]);

describe('GC-ARCH-003: runtime store write enforcement', () => {
  const projectRoot = join(import.meta.dir, '../../..');
  const runtimeDir = join(projectRoot, 'src', 'runtime');
  const runtimeFiles = walkTs(runtimeDir);

  test('zero direct store.setState() calls outside src/runtime/store/index.ts', () => {
    const violations: string[] = [];

    for (const absPath of runtimeFiles) {
      const relPath = relative(projectRoot, absPath);
      if (SET_STATE_ALLOWLIST.has(relPath)) continue;

      const content = readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('.setState(')) {
          violations.push(`${relPath}:${i + 1}; ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          'GC-ARCH-003 violation: direct store.setState() call(s) detected outside src/runtime/store/index.ts.',
          'Route runtime mutations through DomainDispatch or store-owned reducer helpers instead.',
          '',
          'Violations:',
          ...violations.map((v) => `  - ${v}`),
        ].join('\n'),
      );
    }

    expect(violations).toHaveLength(0);
  });
});
