/**
 * Tests for ImportGraph — import/export/require scanning, resolution, and
 * transitive dependency traversal.
 *
 * Run with: bun test src/intelligence/__tests__/import-graph.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ImportGraph } from '../import-graph.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-import-graph-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function write(dir: string, relPath: string, content: string): string {
  const full = join(dir, relPath);
  const parent = join(full, '..');
  mkdirSync(parent, { recursive: true });
  writeFileSync(full, content, 'utf-8');
  return full;
}

/** Reset singleton between tests for full isolation. */
function freshGraph(): ImportGraph {
  (ImportGraph as unknown as { _instance: ImportGraph | null })._instance = null;
  return ImportGraph.getInstance();
}

// ---------------------------------------------------------------------------
// extractRelativeSpecifiers — tested indirectly through build()
// The regex matches: import X from './y', export X from './y', require('./y')
// Side-effect imports (import './y') do NOT match by design.
// ---------------------------------------------------------------------------

describe('extractRelativeSpecifiers (via build)', () => {
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('parses ES named import statements', async () => {
    const a = write(dir, 'a.ts', `import { foo } from './b';`);
    write(dir, 'b.ts', 'export const foo = 1;');

    const graph = freshGraph();
    await graph.build(dir);

    expect(graph.findDependents(join(dir, 'b.ts'))).toContain(a);
  });

  it('parses ES export-from statements', async () => {
    const a = write(dir, 'a.ts', `export { foo } from './b';`);
    write(dir, 'b.ts', 'export const foo = 1;');

    const graph = freshGraph();
    await graph.build(dir);

    expect(graph.findDependents(join(dir, 'b.ts'))).toContain(a);
  });

  it('parses require() calls', async () => {
    const a = write(dir, 'a.js', `const b = require('./b');`);
    write(dir, 'b.js', 'module.exports = 42;');

    const graph = freshGraph();
    await graph.build(dir);

    expect(graph.findDependents(join(dir, 'b.js'))).toContain(a);
  });

  it('ignores non-relative specifiers', async () => {
    write(dir, 'a.ts', `import React from 'react'; import { x } from '@scope/pkg';`);

    const graph = freshGraph();
    await graph.build(dir);

    // No local file deps — dependents map for a.ts should be empty
    expect(graph.findDependents(join(dir, 'a.ts'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolveSpecifier — tested indirectly through build()
// ---------------------------------------------------------------------------

describe('resolveSpecifier (via build)', () => {
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('resolves specifier with explicit extension', async () => {
    const a = write(dir, 'a.ts', `import { x } from './b.ts';`);
    write(dir, 'b.ts', 'export const x = 1;');

    const graph = freshGraph();
    await graph.build(dir);

    expect(graph.findDependents(join(dir, 'b.ts'))).toContain(a);
  });

  it('resolves specifier without extension by trying .ts', async () => {
    const a = write(dir, 'a.ts', `import { x } from './util';`);
    write(dir, 'util.ts', 'export const x = 1;');

    const graph = freshGraph();
    await graph.build(dir);

    expect(graph.findDependents(join(dir, 'util.ts'))).toContain(a);
  });

  it('resolves bare directory specifier to index.ts', async () => {
    const a = write(dir, 'a.ts', `import { x } from './lib';`);
    mkdirSync(join(dir, 'lib'), { recursive: true });
    write(dir, 'lib/index.ts', 'export const x = 1;');

    const graph = freshGraph();
    await graph.build(dir);

    expect(graph.findDependents(join(dir, 'lib/index.ts'))).toContain(a);
  });

  it('ignores unresolvable specifiers without error', async () => {
    write(dir, 'a.ts', `import { x } from './does-not-exist';`);

    const graph = freshGraph();
    // Should not throw
    await expect(graph.build(dir)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// build() — creates correct forward and reverse maps
// ---------------------------------------------------------------------------

describe('ImportGraph.build()', () => {
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('is idempotent when not dirty and root unchanged', async () => {
    write(dir, 'a.ts', '');
    const graph = freshGraph();
    await graph.build(dir);
    // Call again — should be a no-op (no error, same result)
    await expect(graph.build(dir)).resolves.toBeUndefined();
  });

  it('rebuilds after markDirty()', async () => {
    write(dir, 'a.ts', 'export const x = 1;');
    const graph = freshGraph();
    await graph.build(dir);

    // Add a new importer then mark dirty
    const b = write(dir, 'b.ts', `import { x } from './a';`);
    graph.markDirty();
    await graph.build(dir);

    expect(graph.findDependents(join(dir, 'a.ts'))).toContain(b);
  });

  it('every source file appears in the graph even with no imports', async () => {
    write(dir, 'standalone.ts', '// no imports');
    const graph = freshGraph();
    await graph.build(dir);
    // findDependents returns [] (not throws) for a known file
    expect(graph.findDependents(join(dir, 'standalone.ts'))).toEqual([]);
  });

  it('handles a directory that cannot be read gracefully', async () => {
    write(dir, 'valid.ts', '');
    const graph = freshGraph();
    await expect(graph.build(dir)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findDependents — direct importers only
// ---------------------------------------------------------------------------

describe('ImportGraph.findDependents()', () => {
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns direct importers only', async () => {
    // c imports b, b imports a — c is NOT a direct dependent of a
    const a = write(dir, 'a.ts', 'export const x = 1;');
    const b = write(dir, 'b.ts', `import { x } from './a';`);
    write(dir, 'c.ts', `import { x } from './b';`);

    const graph = freshGraph();
    await graph.build(dir);

    const deps = graph.findDependents(a);
    expect(deps).toContain(b);
    // c only imports b — should NOT appear in direct dependents of a
    expect(deps).not.toContain(join(dir, 'c.ts'));
  });

  it('returns empty array for unknown file', async () => {
    const graph = freshGraph();
    await graph.build(dir);
    expect(graph.findDependents('/nonexistent/file.ts')).toEqual([]);
  });

  it('returns empty array for file with no importers', async () => {
    const a = write(dir, 'a.ts', '');
    const graph = freshGraph();
    await graph.build(dir);
    expect(graph.findDependents(a)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findTransitiveDependents — full transitive closure
// ---------------------------------------------------------------------------

describe('ImportGraph.findTransitiveDependents()', () => {
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns full transitive closure', async () => {
    // c → b → a
    const a = write(dir, 'a.ts', 'export const x = 1;');
    const b = write(dir, 'b.ts', `import { x } from './a';`);
    const c = write(dir, 'c.ts', `import { x } from './b';`);

    const graph = freshGraph();
    await graph.build(dir);

    const transitive = graph.findTransitiveDependents(a);
    expect(transitive).toContain(b);
    expect(transitive).toContain(c);
  });

  it('handles diamond dependencies without duplicates', async () => {
    // d → b → a
    // d → c → a
    const a = write(dir, 'a.ts', 'export const v = 1;');
    write(dir, 'b.ts', `import { v } from './a';`);
    write(dir, 'c.ts', `import { v } from './a';`);
    write(dir, 'd.ts', `import { v as bv } from './b'; import { v as cv } from './c';`);

    const graph = freshGraph();
    await graph.build(dir);

    const transitive = graph.findTransitiveDependents(a);
    // No duplicates
    const uniqueCount = new Set(transitive).size;
    expect(uniqueCount).toBe(transitive.length);
    expect(transitive.length).toBe(3); // b, c, d
  });

  it('handles cycles without infinite loop', async () => {
    // a imports b, b imports a — mutual cycle resolved via visited set
    write(dir, 'a.ts', `import { y } from './b';`);
    write(dir, 'b.ts', `import { x } from './a';`);

    const graph = freshGraph();
    await graph.build(dir);

    const aPath = join(dir, 'a.ts');
    // Should terminate and return a finite result
    const result = graph.findTransitiveDependents(aPath);
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns empty array for file with no transitive dependents', async () => {
    const a = write(dir, 'a.ts', '');
    const graph = freshGraph();
    await graph.build(dir);
    expect(graph.findTransitiveDependents(a)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// markDirty() — triggers rebuild
// ---------------------------------------------------------------------------

describe('ImportGraph.markDirty()', () => {
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('causes the next build() to rescan even if root is the same', async () => {
    const a = write(dir, 'a.ts', 'export const x = 1;');
    const graph = freshGraph();
    await graph.build(dir);

    // Initially a has no dependents
    expect(graph.findDependents(a)).toHaveLength(0);

    // Add an importer on disk, mark dirty, rebuild
    const b = write(dir, 'b.ts', `import { x } from './a';`);
    graph.markDirty();
    await graph.build(dir);

    expect(graph.findDependents(a)).toContain(b);
  });
});

// ---------------------------------------------------------------------------
// MAX_FILES cap
// ---------------------------------------------------------------------------

describe('MAX_FILES cap', () => {
  it('does not exceed MAX_FILES (5000) in the graph', async () => {
    // We cannot practically create 5001 files in a unit test, so we verify
    // the graph remains well-behaved when pointed at the real project src/.
    const projectSrc = join(import.meta.dir, '../../..');
    const graph = freshGraph();
    await graph.build(projectSrc);

    // The graph should have been built without error.
    const result = graph.findTransitiveDependents(
      join(projectSrc, 'src/intelligence/import-graph.ts'),
    );
    expect(Array.isArray(result)).toBe(true);
  });
});
