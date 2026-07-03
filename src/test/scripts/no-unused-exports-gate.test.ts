import { describe, expect, test } from 'bun:test';
import {
  checkNoUnusedExports,
  extractExportedSymbols,
  extractImportedBindings,
  isNoUnusedExportsRuleTarget,
  NO_UNUSED_EXPORTS_EXEMPT,
} from '../../../scripts/no-unused-exports-rule.ts';

describe('isNoUnusedExportsRuleTarget', () => {
  test('targets src/renderer files', () => {
    expect(isNoUnusedExportsRuleTarget('src/renderer/theme.ts')).toBe(true);
    expect(isNoUnusedExportsRuleTarget('src/renderer/onboarding/onboarding-wizard.ts')).toBe(true);
  });

  test('does not target test files', () => {
    expect(isNoUnusedExportsRuleTarget('src/renderer/theme.test.ts')).toBe(false);
    expect(isNoUnusedExportsRuleTarget('src/test/renderer/theme.test.ts')).toBe(false);
  });

  test('does not target files outside src/renderer', () => {
    expect(isNoUnusedExportsRuleTarget('src/panels/git-panel.ts')).toBe(false);
    expect(isNoUnusedExportsRuleTarget('src/runtime/bootstrap.ts')).toBe(false);
  });
});

describe('extractExportedSymbols', () => {
  test('collects exported const/function/class/interface/type/enum declarations', () => {
    const symbols = extractExportedSymbols(
      `export const FOO = 1;
export function bar() {}
export class Baz {}
export interface Opts { a: string }
export type Mode = 'a' | 'b';
export enum Kind { A, B }
`,
    );
    expect(symbols.map((s) => s.name)).toEqual(['FOO', 'bar', 'Baz', 'Opts', 'Mode', 'Kind']);
    expect(symbols.map((s) => s.kind)).toEqual(['value', 'value', 'value', 'type', 'type', 'type']);
  });

  test('ignores non-exported declarations', () => {
    const symbols = extractExportedSymbols(`const local = 1;\nfunction helper() {}\n`);
    expect(symbols).toEqual([]);
  });

  test('collects a local named export list as value exports', () => {
    const symbols = extractExportedSymbols(`const A = 1;\nexport { A };\n`);
    expect(symbols).toEqual([{ name: 'A', line: 2, kind: 'value', isTypeOnlyReexport: false }]);
  });

  test('collects a forwarding re-export as a value export needing its own import site', () => {
    const symbols = extractExportedSymbols(`export { STATE_GLYPHS } from './status-glyphs.ts';\n`);
    expect(symbols).toEqual([
      { name: 'STATE_GLYPHS', line: 1, kind: 'value', isTypeOnlyReexport: false },
    ]);
  });

  test('marks `export type { X } from` forwarding as an exempt type-only re-export', () => {
    const symbols = extractExportedSymbols(`export type { StatusState } from './status-glyphs.ts';\n`);
    expect(symbols).toEqual([
      { name: 'StatusState', line: 1, kind: 'type', isTypeOnlyReexport: true },
    ]);
  });

  test('marks `export { type X } from` per-specifier type forwarding as exempt too', () => {
    const symbols = extractExportedSymbols(`export { type StatusState } from './status-glyphs.ts';\n`);
    expect(symbols[0]?.isTypeOnlyReexport).toBe(true);
  });

  test('a local (non-forwarding) `export { type X }` is not treated as a re-export exemption', () => {
    const symbols = extractExportedSymbols(`type X = string;\nexport { type X };\n`);
    expect(symbols).toEqual([{ name: 'X', line: 2, kind: 'type', isTypeOnlyReexport: false }]);
  });
});

describe('extractImportedBindings', () => {
  test('collects named imports from relative specifiers', () => {
    const bindings = extractImportedBindings(`import { foo, bar as baz } from './thing.ts';\n`);
    expect(bindings).toEqual([
      { specifier: './thing.ts', name: 'foo' },
      { specifier: './thing.ts', name: 'bar' },
    ]);
  });

  test('collects forwarding export-from bindings', () => {
    const bindings = extractImportedBindings(`export { STATE_GLYPHS } from './status-glyphs.ts';\n`);
    expect(bindings).toEqual([{ specifier: './status-glyphs.ts', name: 'STATE_GLYPHS' }]);
  });

  test('collects destructured dynamic imports anywhere in the file', () => {
    const bindings = extractImportedBindings(
      `async function run() {
  const { computeSemanticDiff, formatSemanticDiffSummary } = await import('../renderer/semantic-diff.ts');
  return computeSemanticDiff;
}
`,
    );
    expect(bindings).toEqual([
      { specifier: '../renderer/semantic-diff.ts', name: 'computeSemanticDiff' },
      { specifier: '../renderer/semantic-diff.ts', name: 'formatSemanticDiffSummary' },
    ]);
  });

  test('ignores non-relative specifiers and default/namespace bindings', () => {
    const bindings = extractImportedBindings(
      `import fs from 'node:fs';\nimport * as ts from 'typescript';\nimport './side-effect.ts';\n`,
    );
    expect(bindings).toEqual([]);
  });
});

describe('checkNoUnusedExports', () => {
  const noopResolve = (fromRelPath: string, specifier: string): string | null => {
    // Minimal same-directory resolver good enough for these fixtures.
    if (!specifier.startsWith('./')) return null;
    const dir = fromRelPath.split('/').slice(0, -1).join('/');
    return `${dir}/${specifier.slice(2)}`;
  };

  test('passes an export with a non-test import site', () => {
    const violations = checkNoUnusedExports(
      [{ relPath: 'src/renderer/thing.ts', text: `export function used() {}\n` }],
      [{ relPath: 'src/renderer/caller.ts', text: `import { used } from './thing.ts';\n`, isTest: false }],
      noopResolve,
    );
    expect(violations).toEqual([]);
  });

  test('flags a value export with zero import sites', () => {
    const violations = checkNoUnusedExports(
      [{ relPath: 'src/renderer/thing.ts', text: `export function dead() {}\n` }],
      [],
      noopResolve,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("export 'dead'");
    expect(violations[0]).toContain('no-unused-export');
  });

  test('does not count a test-only import site', () => {
    const violations = checkNoUnusedExports(
      [{ relPath: 'src/renderer/thing.ts', text: `export function dead() {}\n` }],
      [{ relPath: 'src/test/renderer/thing.test.ts', text: `import { dead } from '../../renderer/thing.ts';\n`, isTest: true }],
      noopResolve,
    );
    expect(violations).toHaveLength(1);
  });

  test('passes a type export used only as a signature type in its own file (structural typing)', () => {
    const violations = checkNoUnusedExports(
      [
        {
          relPath: 'src/renderer/thing.ts',
          text: `export interface ThingOptions { width: number }\nexport function render(opts: ThingOptions) {}\n`,
        },
      ],
      [{ relPath: 'src/renderer/caller.ts', text: `import { render } from './thing.ts';\n`, isTest: false }],
      noopResolve,
    );
    expect(violations).toEqual([]);
  });

  test('flags a type export referenced nowhere, not even in its own file', () => {
    const violations = checkNoUnusedExports(
      [{ relPath: 'src/renderer/thing.ts', text: `export type Orphan = string;\n` }],
      [],
      noopResolve,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("export 'Orphan'");
  });

  test('does not require an import site for a type-only re-export', () => {
    const violations = checkNoUnusedExports(
      [{ relPath: 'src/renderer/thing.ts', text: `export type { Foo } from './foo.ts';\n` }],
      [],
      noopResolve,
    );
    expect(violations).toEqual([]);
  });

  test('honors a real NO_UNUSED_EXPORTS_EXEMPT entry', () => {
    expect(NO_UNUSED_EXPORTS_EXEMPT.has('src/renderer/term-caps.ts#SYNC_BEGIN')).toBe(true);
    const violations = checkNoUnusedExports(
      [{ relPath: 'src/renderer/term-caps.ts', text: `export const SYNC_BEGIN = '\\x1b[?2026h';\n` }],
      [],
      noopResolve,
    );
    expect(violations).toEqual([]);
  });

  test('ignores files outside src/renderer', () => {
    const violations = checkNoUnusedExports(
      [{ relPath: 'src/panels/git-panel.ts', text: `export function dead() {}\n` }],
      [],
      noopResolve,
    );
    expect(violations).toEqual([]);
  });

  test('counts a destructured dynamic import as a real usage site', () => {
    const violations = checkNoUnusedExports(
      [{ relPath: 'src/renderer/thing.ts', text: `export async function compute() {}\n` }],
      [
        {
          relPath: 'src/input/commands/thing-runtime.ts',
          text: `async function run() {\n  const { compute } = await import('../../renderer/thing.ts');\n  return compute;\n}\n`,
          isTest: false,
        },
      ],
      (fromRelPath, specifier) => {
        // real-ish relative resolver for this one nested-path fixture
        if (fromRelPath === 'src/input/commands/thing-runtime.ts' && specifier === '../../renderer/thing.ts') {
          return 'src/renderer/thing.ts';
        }
        return null;
      },
    );
    expect(violations).toEqual([]);
  });
});
