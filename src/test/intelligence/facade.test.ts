/**
 * Tests for CodeIntelligence facade and language config.
 *
 * Run with: bun test src/test/intelligence/facade.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';

import { CodeIntelligence, pathToUri, uriToPath } from '../../intelligence/facade.ts';
import { TreeSitterService } from '../../intelligence/tree-sitter/service.ts';
import { LspService } from '../../intelligence/lsp/service.ts';
import { getTestCodeIntelligence, getTestLspService, getTestTreeSitterService, resetTestLspService } from '../helpers/runtime-services.ts';
import {
  loadLanguageConfigs,
  getLanguageConfig,
  getDefaultConfigs,
} from '../../intelligence/config.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh CodeIntelligence with isolated test-owned services.
 */
function makeFreshIntelligence(): CodeIntelligence {
  getTestTreeSitterService().dispose();
  resetTestLspService();

  const ts = getTestTreeSitterService();
  const lsp = getTestLspService();
  return new CodeIntelligence(ts, lsp);
}

// ---------------------------------------------------------------------------
// detectLanguage
// ---------------------------------------------------------------------------

describe('CodeIntelligence.detectLanguage', () => {
  it('returns typescript for .ts', () => {
    const ci = makeFreshIntelligence();
    expect(ci.detectLanguage('foo/bar.ts')).toBe('typescript');
  });

  it('returns tsx for .tsx', () => {
    const ci = makeFreshIntelligence();
    // .tsx maps to its own 'tsx' grammar ID (housed in tree-sitter-typescript package)
    expect(ci.detectLanguage('Component.tsx')).toBe('tsx');
  });

  it('returns python for .py', () => {
    const ci = makeFreshIntelligence();
    expect(ci.detectLanguage('script.py')).toBe('python');
  });

  it('returns rust for .rs', () => {
    const ci = makeFreshIntelligence();
    expect(ci.detectLanguage('main.rs')).toBe('rust');
  });

  it('returns go for .go', () => {
    const ci = makeFreshIntelligence();
    expect(ci.detectLanguage('main.go')).toBe('go');
  });

  it('returns bash for .sh', () => {
    const ci = makeFreshIntelligence();
    expect(ci.detectLanguage('run.sh')).toBe('bash');
  });

  it('returns null for unknown extension', () => {
    const ci = makeFreshIntelligence();
    expect(ci.detectLanguage('file.xyz123')).toBeNull();
  });

  it('returns null for file with no extension', () => {
    const ci = makeFreshIntelligence();
    expect(ci.detectLanguage('Makefile')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hasTreeSitter
// ---------------------------------------------------------------------------

describe('CodeIntelligence.hasTreeSitter', () => {
  it('returns false for unknown extension', () => {
    const ci = makeFreshIntelligence();
    expect(ci.hasTreeSitter('file.unknown')).toBe(false);
  });

  it('returns false when grammar not loaded (no WASM in test env)', () => {
    const ci = makeFreshIntelligence();
    expect(ci.hasTreeSitter('file.ts')).toBe(false);
  });

  it('returns false for file with no extension', () => {
    const ci = makeFreshIntelligence();
    expect(ci.hasTreeSitter('Dockerfile')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getSymbols (graceful degradation)
// ---------------------------------------------------------------------------

describe('CodeIntelligence.getSymbols', () => {
  it('returns empty array when no grammar loaded', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.getSymbols('file.ts', 'const x = 1;');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for unknown language', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.getSymbols('file.xyz', 'whatever');
    expect(result).toHaveLength(0);
  });

  it('does not throw even for real-looking TypeScript content', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.getSymbols('src/index.ts', 'export function main() {}');
    expect(Array.isArray(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getOutline (graceful degradation)
// ---------------------------------------------------------------------------

describe('CodeIntelligence.getOutline', () => {
  it('returns empty array when no grammar loaded', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.getOutline('file.py', 'def foo(): pass');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for unknown language', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.getOutline('file.unknown', 'whatever');
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getEnclosingScope (graceful degradation)
// ---------------------------------------------------------------------------

describe('CodeIntelligence.getEnclosingScope', () => {
  it('returns null when no grammar loaded', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.getEnclosingScope('file.ts', 'function foo() {}', 0);
    expect(result).toBeNull();
  });

  it('returns null for unknown language', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.getEnclosingScope('file.bin', 'whatever', 5);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hasLsp
// ---------------------------------------------------------------------------

describe('CodeIntelligence.hasLsp', () => {
  it('returns false when no server configured', async () => {
    const ci = makeFreshIntelligence();
    // No server registered, command not on PATH — both conditions cause false
    const result = await ci.hasLsp('file.ts');
    expect(result).toBe(false);
  });

  it('returns false for unknown language', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.hasLsp('file.unknownlang');
    expect(result).toBe(false);
  });

  it('returns false for file with no extension', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.hasLsp('Makefile');
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getReferences (graceful degradation)
// ---------------------------------------------------------------------------

describe('CodeIntelligence.getReferences', () => {
  it('returns empty array when no LSP server configured', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.getReferences('file.ts', 5, 10);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for unknown language', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.getReferences('file.xyz', 0, 0);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getDefinition (graceful degradation)
// ---------------------------------------------------------------------------

describe('CodeIntelligence.getDefinition', () => {
  it('returns null when no LSP server configured', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.getDefinition('file.ts', 5, 10);
    expect(result).toBeNull();
  });

  it('returns null for unknown language', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.getDefinition('file.nolang', 0, 0);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getHover (graceful degradation)
// ---------------------------------------------------------------------------

describe('CodeIntelligence.getHover', () => {
  it('returns null when no LSP server configured', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.getHover('file.ts', 5, 10);
    expect(result).toBeNull();
  });

  it('returns null for unknown language', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.getHover('file.bin', 0, 0);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getDiagnostics (graceful degradation)
// ---------------------------------------------------------------------------

describe('CodeIntelligence.getDiagnostics', () => {
  it('returns empty array when no LSP server configured', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.getDiagnostics('file.ts');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for unknown language', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.getDiagnostics('file.xyz');
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getDocumentSymbols (hybrid fallback)
// ---------------------------------------------------------------------------

describe('CodeIntelligence.getDocumentSymbols', () => {
  it('falls back to tree-sitter and returns empty array when neither available', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.getDocumentSymbols('file.ts', 'const x = 1;');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for unknown language', async () => {
    const ci = makeFreshIntelligence();
    const result = await ci.getDocumentSymbols('file.unknown', 'whatever');
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

describe('CodeIntelligence.getInstance', () => {
  afterEach(async () => {
    // Dispose the shared test-owned services after these tests
    const inst = getTestCodeIntelligence();
    await inst.dispose().catch(() => {});
    resetTestLspService();
    getTestTreeSitterService().dispose();
  });

  it('returns the same instance on repeated calls', () => {
    const a = getTestCodeIntelligence();
    const b = getTestCodeIntelligence();
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Language config: defaults
// ---------------------------------------------------------------------------

describe('getDefaultConfigs', () => {
  it('returns a non-empty map', () => {
    const configs = getDefaultConfigs();
    expect(configs.size).toBeGreaterThan(0);
  });

  it('has typescript with lsp and treeSitter', () => {
    const configs = getDefaultConfigs();
    const ts = configs.get('typescript');
    expect(ts).toBeDefined();
    expect(ts?.lsp?.command).toBe('typescript-language-server');
    expect(ts?.treeSitter).toBe('typescript');
  });

  it('has python config', () => {
    const configs = getDefaultConfigs();
    const py = configs.get('python');
    expect(py?.lsp?.command).toBe('pyright-langserver');
  });

  it('has rust config', () => {
    const configs = getDefaultConfigs();
    const rs = configs.get('rust');
    expect(rs?.lsp?.command).toBe('rust-analyzer');
  });

  it('has go config', () => {
    const configs = getDefaultConfigs();
    const go = configs.get('go');
    expect(go?.lsp?.command).toBe('gopls');
  });

  it('has bash config', () => {
    const configs = getDefaultConfigs();
    const bash = configs.get('bash');
    expect(bash?.lsp?.command).toBe('bash-language-server');
  });
});

// ---------------------------------------------------------------------------
// Language config: getLanguageConfig
// ---------------------------------------------------------------------------

describe('getLanguageConfig', () => {
  it('returns config for known language', () => {
    const cfg = getLanguageConfig('typescript');
    expect(cfg).not.toBeNull();
    expect(cfg?.lsp?.command).toBe('typescript-language-server');
  });

  it('returns null for unknown language', () => {
    const cfg = getLanguageConfig('cobol');
    expect(cfg).toBeNull();
  });

  it('returns consistent results on repeated calls', () => {
    const a = getLanguageConfig('python');
    const b = getLanguageConfig('python');
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// Language config: user file override (mock via temp directory)
// ---------------------------------------------------------------------------

describe('loadLanguageConfigs with project override', () => {
  let tempDir: string;
  let langDir: string;
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tempDir = join(tmpdir(), `gv-facade-test-${Date.now()}`);
    langDir = join(tempDir, '.goodvibes', 'tui', 'languages');
    mkdirSync(langDir, { recursive: true });
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('applies project-level override for typescript', () => {
    writeFileSync(
      join(langDir, 'typescript.json'),
      JSON.stringify({ lsp: { command: 'my-custom-lsp', args: ['--stdio'] } }),
    );
    const configs = loadLanguageConfigs();
    const ts = configs.get('typescript');
    expect(ts?.lsp?.command).toBe('my-custom-lsp');
  });

  it('ignores malformed JSON files gracefully', () => {
    writeFileSync(join(langDir, 'python.json'), 'not json {{');
    let configs: Map<string, { lsp?: { command?: string } }> | null = null;
    expect(() => {
      configs = loadLanguageConfigs() as Map<string, { lsp?: { command?: string } }>;
    }).not.toThrow();
    // Python config falls back to default
    const py = (configs as Map<string, { lsp?: { command?: string } }> | null)?.get('python');
    expect(py?.lsp?.command).toBe('pyright-langserver');
  });

  it('preserves other language defaults when only one is overridden', () => {
    writeFileSync(
      join(langDir, 'rust.json'),
      JSON.stringify({ lsp: { command: 'my-rust-analyzer', args: [] } }),
    );
    const configs = loadLanguageConfigs();
    // Rust is overridden
    expect(configs.get('rust')?.lsp?.command).toBe('my-rust-analyzer');
    // Python is untouched
    expect(configs.get('python')?.lsp?.command).toBe('pyright-langserver');
    // Go is untouched
    expect(configs.get('go')?.lsp?.command).toBe('gopls');
  });
});

// ---------------------------------------------------------------------------
// pathToUri / uriToPath
// ---------------------------------------------------------------------------

describe('pathToUri / uriToPath', () => {
  it('produces a valid file:// URI', () => {
    const uri = pathToUri('/home/user/project/file.ts');
    expect(uri).toMatch(/^file:\/\/\//);
    expect(uri).toContain('file.ts');
  });

  it('round-trips path through URI and back', () => {
    const original = '/tmp/some/path/file.ts';
    const uri = pathToUri(original);
    const recovered = uriToPath(uri);
    expect(recovered).toBe(original);
  });

  it('percent-encodes spaces in paths', () => {
    const uri = pathToUri('/home/user/my project/file.ts');
    expect(uri).toContain('%20');
    expect(uri).not.toContain(' ');
  });

  it('uriToPath decodes percent-encoded characters', () => {
    const uri = 'file:///home/user/my%20project/file.ts';
    const path = uriToPath(uri);
    expect(path).toBe('/home/user/my project/file.ts');
  });
});

// ---------------------------------------------------------------------------
// Happy-path tests with mocked services
// ---------------------------------------------------------------------------

/**
 * Minimal mock for TreeSitterService — returns a fake tree and language
 * so the facade can exercise its delegation logic without WASM.
 */
function makeMockTreeSitter() {
  const fakeTree = { rootNode: { type: 'program', startPosition: { row: 0, column: 0 }, endPosition: { row: 10, column: 0 }, children: [] } };
  const fakeLang = { query: () => ({ matches: () => [] }) };
  const loadedLangs: string[] = [];

  return {
    initialize: async () => {},
    dispose: () => { loadedLangs.length = 0; },
    get loadedLanguages() { return loadedLangs; },
    parse: async (_fp: string, _content: string, lang: string) => {
      loadedLangs.push(lang);
      return fakeTree;
    },
    loadLanguage: async (_lang: string) => fakeLang,
  } as unknown as TreeSitterService;
}

/**
 * Minimal mock for LspService — no real servers, returns predictable data.
 */
function makeMockLspService(responses: Record<string, unknown> = {}) {
  const mockClient = {
    isRunning: true,
    request: async (method: string, _params: unknown) => responses[method] ?? null,
    notify: () => {},
    stop: async () => {},
  };
  return {
    registerServer: () => {},
    getClient: async (_lang: string) => mockClient,
    isAvailable: async (_lang: string) => true,
    shutdown: async () => {},
  } as unknown as LspService;
}

describe('CodeIntelligence happy-path delegation (mocked services)', () => {
  it('getSymbols delegates to extractSymbols when tree-sitter is available', async () => {
    const ts = makeMockTreeSitter();
    const lsp = makeMockLspService();
    const ci = new CodeIntelligence(ts, lsp);
    // With no grammar loaded, extractSymbols returns [] since the fake lang has no queries.
    // The key thing: no exception thrown and the delegation path is exercised.
    const result = await ci.getSymbols('src/index.ts', 'export function main() {}');
    expect(Array.isArray(result)).toBe(true);
  });

  it('getOutline delegates to extractOutline when tree-sitter is available', async () => {
    const ts = makeMockTreeSitter();
    const lsp = makeMockLspService();
    const ci = new CodeIntelligence(ts, lsp);
    const result = await ci.getOutline('src/index.ts', 'function foo() {}');
    expect(Array.isArray(result)).toBe(true);
  });

  it('getEnclosingScope delegates to findEnclosingScope when tree-sitter is available', async () => {
    const ts = makeMockTreeSitter();
    const lsp = makeMockLspService();
    const ci = new CodeIntelligence(ts, lsp);
    // findEnclosingScope returns null when no matching scope is found in fake tree
    const result = await ci.getEnclosingScope('src/index.ts', 'function foo() {}', 0);
    // Result is null or a scope object — either is acceptable; it must not throw
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('hasLsp returns true when mock service reports available', async () => {
    const ts = makeMockTreeSitter();
    const lsp = makeMockLspService();
    const ci = new CodeIntelligence(ts, lsp);
    const result = await ci.hasLsp('file.ts');
    expect(result).toBe(true);
  });

  it('getDefinition returns LSP result when client responds', async () => {
    const ts = makeMockTreeSitter();
    const fakeLocation = { uri: 'file:///src/foo.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } };
    const lsp = makeMockLspService({ 'textDocument/definition': fakeLocation });
    const ci = new CodeIntelligence(ts, lsp);
    const result = await ci.getDefinition('file.ts', 0, 0);
    expect(result).toEqual(fakeLocation);
  });

  it('getDefinition returns first element when LSP returns an array', async () => {
    const ts = makeMockTreeSitter();
    const fakeLocation = { uri: 'file:///src/foo.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } };
    const lsp = makeMockLspService({ 'textDocument/definition': [fakeLocation] });
    const ci = new CodeIntelligence(ts, lsp);
    const result = await ci.getDefinition('file.ts', 0, 0);
    expect(result).toEqual(fakeLocation);
  });

  it('getReferences returns LSP result array', async () => {
    const ts = makeMockTreeSitter();
    const fakeRefs = [
      { uri: 'file:///src/a.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
      { uri: 'file:///src/b.ts', range: { start: { line: 3, character: 2 }, end: { line: 3, character: 7 } } },
    ];
    const lsp = makeMockLspService({ 'textDocument/references': fakeRefs });
    const ci = new CodeIntelligence(ts, lsp);
    const result = await ci.getReferences('file.ts', 0, 0);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(fakeRefs[0]);
  });

  it('getHover returns LSP hover result', async () => {
    const ts = makeMockTreeSitter();
    const fakeHover = { contents: { kind: 'markdown', value: '**function** foo(): void' } };
    const lsp = makeMockLspService({ 'textDocument/hover': fakeHover });
    const ci = new CodeIntelligence(ts, lsp);
    const result = await ci.getHover('file.ts', 0, 0);
    expect(result).toEqual(fakeHover);
  });

  it('getDiagnostics returns items from LSP pull result', async () => {
    const ts = makeMockTreeSitter();
    const fakeDiag = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1 as const, message: 'error here' };
    const lsp = makeMockLspService({ 'textDocument/diagnostic': { items: [fakeDiag] } });
    const ci = new CodeIntelligence(ts, lsp);
    const result = await ci.getDiagnostics('file.ts');
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('error here');
  });

  it('getDocumentSymbols uses LSP result when available', async () => {
    const ts = makeMockTreeSitter();
    const fakeSymbol = { name: 'MyClass', kind: 5, range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } }, selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } } };
    const lsp = makeMockLspService({ 'textDocument/documentSymbol': [fakeSymbol] });
    const ci = new CodeIntelligence(ts, lsp);
    const result = await ci.getDocumentSymbols('file.ts', 'class MyClass {}');
    expect(result).toHaveLength(1);
    expect((result[0] as typeof fakeSymbol).name).toBe('MyClass');
  });

  it('getDocumentSymbols falls back to tree-sitter when LSP returns empty', async () => {
    const ts = makeMockTreeSitter();
    // LSP returns empty array — should fall back to tree-sitter
    const lsp = makeMockLspService({ 'textDocument/documentSymbol': [] });
    const ci = new CodeIntelligence(ts, lsp);
    // Fake tree-sitter returns [] too (no real grammar), but execution reaches tree-sitter path
    const result = await ci.getDocumentSymbols('file.ts', 'const x = 1;');
    expect(Array.isArray(result)).toBe(true);
  });

  it('initialize wires language configs into LspService', async () => {
    const registered: Record<string, unknown> = {};
    const ts = makeMockTreeSitter();
    const lsp = {
      registerServer: (lang: string, cfg: unknown) => { registered[lang] = cfg; },
      getClient: async () => null,
      isAvailable: async () => false,
      shutdown: async () => {},
    } as unknown as LspService;
    const ci = new CodeIntelligence(ts, lsp);
    await ci.initialize();
    // initialize() calls loadLanguageConfigs() and registers each lang with an LSP config
    expect('typescript' in registered).toBe(true);
    expect('python' in registered).toBe(true);
    expect('rust' in registered).toBe(true);
  });
});
