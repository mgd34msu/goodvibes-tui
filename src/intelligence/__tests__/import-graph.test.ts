import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import {
  ImportGraph,
  extractRelativeSpecifiersForTest,
  resolveSpecifierForTest,
} from '@pellux/goodvibes-sdk/platform/intelligence/import-graph';

function fileMap(entries: Record<string, string>, root = '/virtual'): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).map(([relativePath, content]) => [join(root, relativePath), content]),
  );
}

function buildGraph(entries: Record<string, string>, root = '/virtual'): {
  graph: ImportGraph;
  files: Record<string, string>;
} {
  const files = fileMap(entries, root);
  const graph = new ImportGraph();
  graph.buildFromFilesForTest(files);
  return { graph, files };
}

describe('extractRelativeSpecifiersForTest', () => {
  it('parses ES named imports, export-from statements, and require calls', () => {
    const specs = extractRelativeSpecifiersForTest([
      `import { foo } from './a';`,
      `export { bar } from './b';`,
      `const baz = require('./c');`,
    ].join('\n'));

    expect(specs).toEqual(['./a', './b', './c']);
  });

  it('ignores side-effect imports and non-relative specifiers', () => {
    const specs = extractRelativeSpecifiersForTest([
      `import './setup';`,
      `import React from 'react';`,
      `import { x } from '@scope/pkg';`,
    ].join('\n'));

    expect(specs).toEqual([]);
  });
});

describe('resolveSpecifierForTest', () => {
  it('resolves explicit extensions, implicit extensions, and directory indexes', () => {
    const files = new Set([
      '/virtual/a.ts',
      '/virtual/b.ts',
      '/virtual/util.ts',
      '/virtual/lib/index.ts',
    ]);

    expect(resolveSpecifierForTest('/virtual/a.ts', './b.ts', files)).toBe('/virtual/b.ts');
    expect(resolveSpecifierForTest('/virtual/a.ts', './util', files)).toBe('/virtual/util.ts');
    expect(resolveSpecifierForTest('/virtual/a.ts', './lib', files)).toBe('/virtual/lib/index.ts');
  });

  it('returns null for unresolvable specifiers', () => {
    const files = new Set(['/virtual/a.ts']);
    expect(resolveSpecifierForTest('/virtual/a.ts', './missing', files)).toBeNull();
  });
});

describe('ImportGraph.buildFromFilesForTest', () => {
  it('creates reverse dependencies for imports, export-from, and require', () => {
    const { graph } = buildGraph({
      'a.ts': `import { foo } from './b';`,
      'reexport.ts': `export { foo } from './b';`,
      'consumer.js': `const mod = require('./b');`,
      'b.ts': `export const foo = 1;`,
    });

    const b = join('/virtual', 'b.ts');
    expect(graph.findDependents(b)).toEqual(expect.arrayContaining([
      join('/virtual', 'a.ts'),
      join('/virtual', 'reexport.ts'),
      join('/virtual', 'consumer.js'),
    ]));
  });

  it('leaves standalone files with empty dependency sets', () => {
    const { graph } = buildGraph({ 'standalone.ts': '// no imports' });
    expect(graph.findDependents(join('/virtual', 'standalone.ts'))).toEqual([]);
  });

  it('supports rebuilds after markDirty on the filesystem-backed path', async () => {
    const root = '/virtual-rebuild';
    const initial = fileMap({ 'a.ts': 'export const x = 1;' }, root);
    const graph = new ImportGraph();
    graph.buildFromFilesForTest(initial);
    graph.markDirty();
    graph.buildFromFilesForTest({
      ...initial,
      [join(root, 'b.ts')]: `import { x } from './a';`,
    });

    expect(graph.findDependents(join(root, 'a.ts'))).toContain(join(root, 'b.ts'));
  });
});

describe('ImportGraph.findDependents', () => {
  it('returns direct importers only', () => {
    const { graph } = buildGraph({
      'a.ts': 'export const x = 1;',
      'b.ts': `import { x } from './a';`,
      'c.ts': `import { x } from './b';`,
    });

    const a = join('/virtual', 'a.ts');
    const b = join('/virtual', 'b.ts');
    const c = join('/virtual', 'c.ts');
    const dependents = graph.findDependents(a);

    expect(dependents).toContain(b);
    expect(dependents).not.toContain(c);
  });

  it('returns an empty array for unknown files', () => {
    const graph = new ImportGraph();
    expect(graph.findDependents('/virtual/missing.ts')).toEqual([]);
  });
});

describe('ImportGraph.findTransitiveDependents', () => {
  it('returns the full transitive closure without duplicates', () => {
    const { graph } = buildGraph({
      'a.ts': 'export const v = 1;',
      'b.ts': `import { v } from './a';`,
      'c.ts': `import { v } from './a';`,
      'd.ts': `import { v as bv } from './b'; import { v as cv } from './c';`,
    });

    const transitive = graph.findTransitiveDependents(join('/virtual', 'a.ts'));
    expect(new Set(transitive).size).toBe(transitive.length);
    expect(transitive).toEqual(expect.arrayContaining([
      join('/virtual', 'b.ts'),
      join('/virtual', 'c.ts'),
      join('/virtual', 'd.ts'),
    ]));
  });

  it('handles cycles without infinite recursion', () => {
    const { graph } = buildGraph({
      'a.ts': `import { y } from './b';`,
      'b.ts': `import { x } from './a';`,
    });

    const result = graph.findTransitiveDependents(join('/virtual', 'a.ts'));
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('ImportGraph statistics and export helpers', () => {
  it('reports stats and relative graph shape', () => {
    const { graph } = buildGraph({
      'a.ts': `import { x } from './b';`,
      'b.ts': 'export const x = 1;',
    }, '/project');

    expect(graph.stats()).toMatchObject({ files: 2, edges: 1, dirty: false });
    expect(graph.toRelativeGraph('/project')).toEqual({
      'a.ts': ['b.ts'],
      'b.ts': [],
    });
  });
});
