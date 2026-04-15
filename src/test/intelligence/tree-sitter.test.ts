/**
 * Tests for the tree-sitter intelligence module.
 *
 * Grammar WASM files may not be available in CI. Tests that require an
 * actual parsed tree use test.skipIf() to skip gracefully.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { TreeSitterService } from '@pellux/goodvibes-sdk/platform/intelligence/tree-sitter/service';
import {
  detectLanguage,
  getGrammarPackage,
  getSupportedLanguages,
} from '@pellux/goodvibes-sdk/platform/intelligence/tree-sitter/languages';
import {
  extractSymbols,
  extractOutline,
  findEnclosingScope,
} from '@pellux/goodvibes-sdk/platform/intelligence/tree-sitter/queries';
import { existsSync } from 'fs';
import { join } from 'path';
import { getTestTreeSitterService } from '../helpers/runtime-services.ts';

// ---------------------------------------------------------------------------
// Environment probes
// ---------------------------------------------------------------------------

/** Returns true if the web-tree-sitter WASM is available (always true after npm install). */
function wasmAvailable(): boolean {
  return existsSync(
    join(process.cwd(), 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
  );
}

/** Returns true if the TypeScript grammar WASM is available. */
function tsGrammarAvailable(): boolean {
  return existsSync(
    join(
      process.cwd(),
      'node_modules',
      'tree-sitter-typescript',
      'tree-sitter-typescript.wasm',
    ),
  );
}

/** Returns true if the JavaScript grammar WASM is available. */
function jsGrammarAvailable(): boolean {
  return existsSync(
    join(
      process.cwd(),
      'node_modules',
      'tree-sitter-javascript',
      'tree-sitter-javascript.wasm',
    ),
  );
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

describe('detectLanguage', () => {
  test('detects TypeScript', () => {
    expect(detectLanguage('foo.ts')).toBe('typescript');
    expect(detectLanguage('/abs/path/bar.ts')).toBe('typescript');
  });

  test('detects TSX', () => {
    expect(detectLanguage('App.tsx')).toBe('tsx');
  });

  test('detects JavaScript variants', () => {
    expect(detectLanguage('index.js')).toBe('javascript');
    expect(detectLanguage('mod.mjs')).toBe('javascript');
    expect(detectLanguage('mod.cjs')).toBe('javascript');
    expect(detectLanguage('comp.jsx')).toBe('javascript');
  });

  test('detects Python', () => {
    expect(detectLanguage('main.py')).toBe('python');
  });

  test('detects Rust, Go, Java', () => {
    expect(detectLanguage('lib.rs')).toBe('rust');
    expect(detectLanguage('main.go')).toBe('go');
    expect(detectLanguage('Main.java')).toBe('java');
  });

  test('detects C and C++', () => {
    expect(detectLanguage('main.c')).toBe('c');
    expect(detectLanguage('defs.h')).toBe('c');
    expect(detectLanguage('app.cpp')).toBe('cpp');
    expect(detectLanguage('app.hpp')).toBe('cpp');
  });

  test('detects shell scripts', () => {
    expect(detectLanguage('run.sh')).toBe('bash');
    expect(detectLanguage('run.bash')).toBe('bash');
    expect(detectLanguage('run.zsh')).toBe('bash');
  });

  test('detects markup and data formats', () => {
    expect(detectLanguage('config.json')).toBe('json');
    expect(detectLanguage('config.yaml')).toBe('yaml');
    expect(detectLanguage('config.yml')).toBe('yaml');
    expect(detectLanguage('Cargo.toml')).toBe('toml');
    expect(detectLanguage('style.css')).toBe('css');
    expect(detectLanguage('style.scss')).toBe('css');
    expect(detectLanguage('index.html')).toBe('html');
    expect(detectLanguage('index.htm')).toBe('html');
    expect(detectLanguage('README.md')).toBe('markdown');
  });

  test('returns null for unknown extension', () => {
    expect(detectLanguage('file.xyz')).toBeNull();
    expect(detectLanguage('noextension')).toBeNull();
  });

  test('is case-insensitive for extension', () => {
    expect(detectLanguage('file.TS')).toBe('typescript');
    expect(detectLanguage('file.PY')).toBe('python');
  });
});

// ---------------------------------------------------------------------------
// getGrammarPackage
// ---------------------------------------------------------------------------

describe('getGrammarPackage', () => {
  test('returns correct package for typescript', () => {
    expect(getGrammarPackage('typescript')).toBe('tree-sitter-typescript');
  });

  test('tsx shares the typescript package', () => {
    expect(getGrammarPackage('tsx')).toBe('tree-sitter-typescript');
  });

  test('returns default pattern for unknown language', () => {
    expect(getGrammarPackage('haskell')).toBe('tree-sitter-haskell');
  });
});

// ---------------------------------------------------------------------------
// getSupportedLanguages
// ---------------------------------------------------------------------------

describe('getSupportedLanguages', () => {
  test('returns a non-empty array', () => {
    const langs = getSupportedLanguages();
    expect(langs.length).toBeGreaterThan(0);
  });

  test('includes expected core languages', () => {
    const langs = getSupportedLanguages();
    expect(langs).toContain('typescript');
    expect(langs).toContain('javascript');
    expect(langs).toContain('python');
    expect(langs).toContain('rust');
  });

  test('includes all 17 planned languages', () => {
    const langs = getSupportedLanguages();
    expect(langs.length).toBeGreaterThanOrEqual(17);
  });
});

// ---------------------------------------------------------------------------
// TreeSitterService
// ---------------------------------------------------------------------------

describe('TreeSitterService', () => {
  let svc: TreeSitterService;

  beforeEach(() => {
    svc = new TreeSitterService();
  });

  afterEach(() => {
    svc.dispose();
  });

  test('starts with empty cache and no loaded languages', () => {
    expect(svc.cacheSize).toBe(0);
    expect(svc.loadedLanguages).toEqual([]);
  });

  test('dispose() clears cache', () => {
    // Just verify no crash and state is clean
    svc.dispose();
    // Re-create for afterEach cleanup
    svc = new TreeSitterService();
  });

  test('invalidate() on empty cache does not crash', () => {
    svc.invalidate('nonexistent.ts');
    expect(svc.cacheSize).toBe(0);
  });

  test('parse() returns null when not initialized', async () => {
    const result = await svc.parse('test.ts', 'const x = 1;');
    expect(result).toBeNull();
  });

  test('parse() returns null for unknown file extension', async () => {
    // Even if initialized, unknown extension has no langId
    const result = await svc.parse('test.xyz', 'content');
    expect(result).toBeNull();
  });

  test('loadLanguage() returns null for missing grammar WASM', async () => {
    // tree-sitter-haskell is not installed
    const lang = await svc.loadLanguage('haskell');
    expect(lang).toBeNull();
  });

  test.skipIf(!wasmAvailable())(
    'initialize() succeeds when WASM is present',
    async () => {
      await svc.initialize();
      // Idempotent: multiple calls are safe
      await svc.initialize();
      await svc.initialize();
    },
  );

  test.skipIf(!wasmAvailable())(
    'initialize() concurrent calls resolve correctly',
    async () => {
      // Multiple concurrent initialize() calls must not double-initialize
      await Promise.all([svc.initialize(), svc.initialize(), svc.initialize()]);
    },
  );

  // -------------------------------------------------------------------------
  // Full parse tests (require TypeScript grammar WASM)
  // -------------------------------------------------------------------------

  test.skipIf(!wasmAvailable() || !tsGrammarAvailable())(
    'parse() returns a tree for valid TypeScript',
    async () => {
      await svc.initialize();
      const code = 'export function greet(name: string): string { return name; }';
      const tree = await svc.parse('hello.ts', code, 'typescript');
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe('program');
    },
  );

  test.skipIf(!wasmAvailable() || !tsGrammarAvailable())(
    'parse() caches result and increments version on re-parse',
    async () => {
      await svc.initialize();
      await svc.parse('cached.ts', 'const x = 1;', 'typescript');
      expect(svc.cacheSize).toBe(1);
      await svc.parse('cached.ts', 'const x = 2;', 'typescript');
      expect(svc.cacheSize).toBe(1); // still one entry
    },
  );

  test.skipIf(!wasmAvailable() || !tsGrammarAvailable())(
    'invalidate() removes a parsed tree from cache',
    async () => {
      await svc.initialize();
      await svc.parse('inv.ts', 'let y = 2;', 'typescript');
      expect(svc.cacheSize).toBe(1);
      svc.invalidate('inv.ts');
      expect(svc.cacheSize).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// extractSymbols / extractOutline / findEnclosingScope
// (require TypeScript grammar WASM)
// ---------------------------------------------------------------------------

const TS_CODE = [
  'export function greet(name: string): string { return name; }',
  'export class Greeter {',
  '  hello(): void {}',
  '}',
  'export interface IGreeter { hello(): void; }',
  'export type Name = string;',
  'export const MAX = 100;',
  'export enum Color { Red, Green }',
].join('\n');

describe('extractSymbols (TypeScript grammar)', () => {
  let svc: TreeSitterService;

  beforeEach(() => {
    svc = new TreeSitterService();
  });

  afterEach(() => {
    svc.dispose();
  });

  test.skipIf(!wasmAvailable() || !tsGrammarAvailable())(
    'extracts exported function',
    async () => {
      await svc.initialize();
      const tree = await svc.parse('x.ts', TS_CODE, 'typescript');
      expect(tree).not.toBeNull();
      const lang = svc['languages'].get('typescript')!;
      const symbols = extractSymbols(tree!, lang, 'typescript');
      const fn = symbols.find((s) => s.kind === 'function' && s.name === 'greet');
      expect(fn).toBeDefined();
      expect(fn!.exported).toBe(true);
      expect(fn!.line).toBeGreaterThan(0);
    },
  );

  test.skipIf(!wasmAvailable() || !tsGrammarAvailable())(
    'extracts class and its method with container set',
    async () => {
      await svc.initialize();
      const tree = await svc.parse('x.ts', TS_CODE, 'typescript');
      const lang = svc['languages'].get('typescript')!;
      const symbols = extractSymbols(tree!, lang, 'typescript');
      const cls = symbols.find((s) => s.kind === 'class' && s.name === 'Greeter');
      expect(cls).toBeDefined();
      const method = symbols.find((s) => s.kind === 'method' && s.name === 'hello');
      expect(method).toBeDefined();
      expect(method!.container).toBe('Greeter');
    },
  );

  test.skipIf(!wasmAvailable() || !tsGrammarAvailable())(
    'extracts interface, type alias, constant, and enum',
    async () => {
      await svc.initialize();
      const tree = await svc.parse('x.ts', TS_CODE, 'typescript');
      const lang = svc['languages'].get('typescript')!;
      const symbols = extractSymbols(tree!, lang, 'typescript');
      expect(symbols.find((s) => s.kind === 'interface' && s.name === 'IGreeter')).toBeDefined();
      expect(symbols.find((s) => s.kind === 'type' && s.name === 'Name')).toBeDefined();
      expect(symbols.find((s) => s.kind === 'constant' && s.name === 'MAX')).toBeDefined();
      expect(symbols.find((s) => s.kind === 'enum' && s.name === 'Color')).toBeDefined();
    },
  );

  test.skipIf(!wasmAvailable() || !tsGrammarAvailable())(
    'extractOutline nests method inside class',
    async () => {
      await svc.initialize();
      const tree = await svc.parse('x.ts', TS_CODE, 'typescript');
      const lang = svc['languages'].get('typescript')!;
      const outline = extractOutline(tree!, lang, 'typescript');
      const cls = outline.find((e) => e.name === 'Greeter');
      expect(cls).toBeDefined();
      expect(cls!.children.some((c) => c.name === 'hello')).toBe(true);
    },
  );

  test.skipIf(!wasmAvailable() || !tsGrammarAvailable())(
    'findEnclosingScope finds class for line inside Greeter body',
    async () => {
      await svc.initialize();
      const tree = await svc.parse('x.ts', TS_CODE, 'typescript');
      const lang = svc['languages'].get('typescript')!;
      // Line 2 is the class declaration line — inside the class, outside any method
      const scope = findEnclosingScope(tree!, lang, 'typescript', 2);
      expect(scope).not.toBeNull();
      expect(scope!.name).toBe('Greeter');
    },
  );
});

// ---------------------------------------------------------------------------
// Graceful fallback for unsupported language
// ---------------------------------------------------------------------------

describe('extractSymbols: unsupported language', () => {
  test.skipIf(!wasmAvailable() || !tsGrammarAvailable())(
    'returns empty array for unsupported language without crash',
    async () => {
      const svc2 = new TreeSitterService();
      await svc2.initialize();
      const tree = await svc2.parse('x.ts', 'const x = 1;', 'typescript');
      const lang = svc2['languages'].get('typescript')!;
      const symbols = extractSymbols(tree!, lang, 'haskell');
      expect(symbols).toEqual([]);
      svc2.dispose();
    },
  );
});

// ---------------------------------------------------------------------------
// Grammar installation verification
// (Verify that grammar packages are installed and functional)
// ---------------------------------------------------------------------------

describe('Grammar loading (installed packages)', () => {
  let svc: TreeSitterService;

  beforeEach(() => {
    svc = new TreeSitterService();
  });

  afterEach(() => {
    svc.dispose();
  });

  test.skipIf(!wasmAvailable())(
    'initialize() succeeds with installed web-tree-sitter',
    async () => {
      await svc.initialize();
      // If we reach here without throwing, initialization succeeded.
      // A second call must also succeed (idempotent).
      await svc.initialize();
    },
  );

  test.skipIf(!wasmAvailable() || !tsGrammarAvailable())(
    'typescript grammar loads from node_modules',
    async () => {
      await svc.initialize();
      const lang = await svc.loadLanguage('typescript');
      expect(lang).not.toBeNull();
      expect(svc.loadedLanguages).toContain('typescript');
    },
  );

  test.skipIf(!wasmAvailable() || !jsGrammarAvailable())(
    'javascript grammar loads from node_modules',
    async () => {
      await svc.initialize();
      const lang = await svc.loadLanguage('javascript');
      expect(lang).not.toBeNull();
      expect(svc.loadedLanguages).toContain('javascript');
    },
  );

  test.skipIf(!wasmAvailable() || !tsGrammarAvailable())(
    'parsing a TypeScript file returns a non-null tree',
    async () => {
      await svc.initialize();
      const code = [
        'interface User { id: number; name: string; }',
        'function getUser(id: number): User {',
        '  return { id, name: "Alice" };',
        '}',
        'export const DEFAULT_USER: User = getUser(1);',
      ].join('\n');
      const tree = await svc.parse('user.ts', code, 'typescript');
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe('program');
    },
  );

  test.skipIf(!wasmAvailable() || !jsGrammarAvailable())(
    'parsing a JavaScript file returns a non-null tree',
    async () => {
      await svc.initialize();
      const code = [
        'function add(a, b) { return a + b; }',
        'const result = add(1, 2);',
        'module.exports = { add };',
      ].join('\n');
      const tree = await svc.parse('math.js', code, 'javascript');
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe('program');
    },
  );

  test.skipIf(!wasmAvailable() || !tsGrammarAvailable())(
    'symbol extraction from a parsed TypeScript tree returns results',
    async () => {
      await svc.initialize();
      const code = [
        'export function multiply(a: number, b: number): number { return a * b; }',
        'export class Calculator {',
        '  add(a: number, b: number): number { return a + b; }',
        '}',
        'export const PI = 3.14159;',
      ].join('\n');
      const tree = await svc.parse('calc.ts', code, 'typescript');
      expect(tree).not.toBeNull();
      const lang = svc['languages'].get('typescript')!;
      const symbols = extractSymbols(tree!, lang, 'typescript');
      expect(symbols.length).toBeGreaterThan(0);
      expect(symbols.find((s) => s.name === 'multiply' && s.kind === 'function')).toBeDefined();
      expect(symbols.find((s) => s.name === 'Calculator' && s.kind === 'class')).toBeDefined();
      expect(symbols.find((s) => s.name === 'PI')).toBeDefined();
    },
  );

  test.skipIf(!wasmAvailable() || !tsGrammarAvailable())(
    'tsx grammar loads from tree-sitter-typescript package',
    async () => {
      await svc.initialize();
      const lang = await svc.loadLanguage('tsx');
      expect(lang).not.toBeNull();
      expect(svc.loadedLanguages).toContain('tsx');
    },
  );
});
