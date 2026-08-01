/// <reference types="@pellux/goodvibes-sdk/sql-js" />
// `sql.js` ships no types. The declaration is SDK-owned and reaches here
// through that reference — there is no local copy to keep in step.

/**
 * G6 — Dependency verification smoke tests.
 *
 * Each test verifies that a dependency is importable and functional at a
 * basic level.  These are not unit tests of the dep's API; they are
 * production-readiness checks confirming every dep is resolvable and
 * can perform its primary operation without throwing.
 *
 * sql.js  — tested as optional: presence is verified, full init covered
 *            separately since WASM loading may require extra config.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..', '..');

// ---------------------------------------------------------------------------
// @ast-grep/napi
// ---------------------------------------------------------------------------

describe('@ast-grep/napi', () => {
  test('can be imported', async () => {
    const mod = await import('@ast-grep/napi');
    expect(mod).toBeDefined();
  });

  test('exports a parse function', async () => {
    const { parse } = await import('@ast-grep/napi');
    expect(typeof parse).toBe('function');
  });

  test('can parse a TypeScript snippet', async () => {
    const { parse } = await import('@ast-grep/napi');
    const root = parse('TypeScript', 'const x: number = 42;');
    expect(root).toBeDefined();
    // root() returns an SgNode
    const node = root.root();
    expect(node).toBeDefined();
  });

  test('can find nodes in parsed TypeScript', async () => {
    const { parse } = await import('@ast-grep/napi');
    const root = parse('TypeScript', 'function hello(name: string): string { return name; }');
    const node = root.root();
    // findAll on a pattern works
    const funcs = node.findAll({ rule: { kind: 'function_declaration' } });
    expect(Array.isArray(funcs)).toBe(true);
    expect(funcs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// fuse.js
// ---------------------------------------------------------------------------

describe('fuse.js', () => {
  test('can be imported', async () => {
    const mod = await import('fuse.js');
    expect(mod).toBeDefined();
  });

  test('exports a Fuse constructor as default', async () => {
    const { default: Fuse } = await import('fuse.js');
    expect(typeof Fuse).toBe('function');
  });

  test('can create a search index', async () => {
    const { default: Fuse } = await import('fuse.js');
    const data = [{ name: 'read' }, { name: 'write' }, { name: 'execute' }];
    const fuse = new Fuse(data, { keys: ['name'] });
    expect(fuse).toBeDefined();
  });

  test('can search the index and return results', async () => {
    const { default: Fuse } = await import('fuse.js');
    const data = [
      { name: 'precision_read' },
      { name: 'precision_write' },
      { name: 'precision_exec' },
    ];
    const fuse = new Fuse(data, { keys: ['name'], threshold: 0.4 });
    const results = fuse.search('read');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].item.name).toContain('read');
  });

  test('returns empty array for no matches', async () => {
    const { default: Fuse } = await import('fuse.js');
    const data = [{ name: 'alpha' }, { name: 'beta' }];
    const fuse = new Fuse(data, { keys: ['name'], threshold: 0.0 });
    const results = fuse.search('zzzzz');
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sql.js — WASM presence + functional init
// ---------------------------------------------------------------------------

describe('sql.js', () => {
  test('package is resolvable', async () => {
    const mod = await import('sql.js');
    expect(mod).toBeDefined();
  });

  test('exports an initSqlJs factory function', async () => {
    const mod = await import('sql.js');
    // The default export is the init factory
    const factory = mod.default ?? mod;
    expect(typeof factory).toBe('function');
  });

  test('can initialise an in-memory database', async () => {
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    expect(SQL).toBeDefined();
    const db = new SQL.Database();
    expect(db).toBeDefined();
    db.close();
  });

  test('can create a table and insert a row', async () => {
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)');
    db.run('INSERT INTO test VALUES (1, ?)', ['hello']);
    const result = db.exec('SELECT val FROM test WHERE id = 1');
    expect(result.length).toBe(1);
    expect(result[0].values[0][0]).toBe('hello');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// tree-sitter WASM files — existence checks
// ---------------------------------------------------------------------------

describe('tree-sitter WASM files', () => {
  const nmRoot = join(repoRoot, 'node_modules');

  test('tree-sitter-typescript WASM exists', () => {
    const wasmPath = join(nmRoot, 'tree-sitter-typescript', 'tree-sitter-typescript.wasm');
    expect(existsSync(wasmPath)).toBe(true);
  });

  test('tree-sitter-typescript TSX WASM exists', () => {
    const wasmPath = join(nmRoot, 'tree-sitter-typescript', 'tree-sitter-tsx.wasm');
    expect(existsSync(wasmPath)).toBe(true);
  });

  test('tree-sitter-javascript WASM exists', () => {
    const wasmPath = join(nmRoot, 'tree-sitter-javascript', 'tree-sitter-javascript.wasm');
    expect(existsSync(wasmPath)).toBe(true);
  });

  test('tree-sitter-python WASM exists', () => {
    const wasmPath = join(nmRoot, 'tree-sitter-python', 'tree-sitter-python.wasm');
    expect(existsSync(wasmPath)).toBe(true);
  });

  test('tree-sitter-json WASM exists', () => {
    const wasmPath = join(nmRoot, 'tree-sitter-json', 'tree-sitter-json.wasm');
    expect(existsSync(wasmPath)).toBe(true);
  });

  test('tree-sitter-css WASM exists', () => {
    const wasmPath = join(nmRoot, 'tree-sitter-css', 'tree-sitter-css.wasm');
    expect(existsSync(wasmPath)).toBe(true);
  });

  test('web-tree-sitter WASM exists', () => {
    const wasmPath = join(nmRoot, 'web-tree-sitter', 'web-tree-sitter.wasm');
    expect(existsSync(wasmPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// web-tree-sitter — init and basic parse
// ---------------------------------------------------------------------------

describe('web-tree-sitter', () => {
  test('can be imported', async () => {
    const mod = await import('web-tree-sitter');
    expect(mod).toBeDefined();
  });

  test('exports a Parser class', async () => {
    const mod = await import('web-tree-sitter');
    const Parser = mod.default ?? mod.Parser;
    expect(typeof Parser).toBe('function');
  });

  test('Parser.init() completes without throwing', async () => {
    const mod = await import('web-tree-sitter');
    const Parser = mod.default ?? mod.Parser;
    // init() initialises the WASM runtime; call it and verify it does not throw
    let threw = false;
    try {
      // @ts-ignore — web-tree-sitter typings don't include init() but it exists at runtime
      await Parser.init();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// simple-git — instance creation and smoke op
// ---------------------------------------------------------------------------

describe('simple-git', () => {
  test('can be imported', async () => {
    const mod = await import('simple-git');
    expect(mod).toBeDefined();
  });

  test('exports a default factory function', async () => {
    const { default: simpleGit } = await import('simple-git');
    expect(typeof simpleGit).toBe('function');
  });

  test('can create a git instance for the project root', async () => {
    const { default: simpleGit } = await import('simple-git');
    const git = simpleGit(repoRoot);
    expect(git).toBeDefined();
  });

  test('can check if directory is a git repo', async () => {
    const { default: simpleGit } = await import('simple-git');
    const git = simpleGit(repoRoot);
    const isRepo = await git.checkIsRepo();
    // The project is a git repo
    expect(typeof isRepo).toBe('boolean');
    expect(isRepo).toBe(true);
  });

  test('can retrieve git version', async () => {
    const { default: simpleGit } = await import('simple-git');
    const git = simpleGit(repoRoot);
    const version = await git.version();
    expect(version).toBeDefined();
    expect(version.major).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// openai — client creation and SDK introspection
// ---------------------------------------------------------------------------

describe('openai', () => {
  test('can be imported', async () => {
    const mod = await import('openai');
    expect(mod).toBeDefined();
  });

  test('exports an OpenAI class', async () => {
    const { default: OpenAI } = await import('openai');
    expect(typeof OpenAI).toBe('function');
  });

  test('can create a client instance with a dummy key', async () => {
    const { default: OpenAI } = await import('openai');
    // dangerouslyAllowBrowser avoids the browser-env check
    const client = new OpenAI({ apiKey: 'sk-test-dummy', dangerouslyAllowBrowser: true });
    expect(client).toBeDefined();
  });

  test('client exposes chat completions API', async () => {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'sk-test-dummy', dangerouslyAllowBrowser: true });
    expect(client.chat).toBeDefined();
    expect(client.chat.completions).toBeDefined();
    expect(typeof client.chat.completions.create).toBe('function');
  });

  test('client exposes embeddings API', async () => {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'sk-test-dummy', dangerouslyAllowBrowser: true });
    expect(client.embeddings).toBeDefined();
    expect(typeof client.embeddings.create).toBe('function');
  });

  test('client baseURL defaults to openai API', async () => {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'sk-test-dummy', dangerouslyAllowBrowser: true });
    // baseURL is accessible via the client (it's part of the API)
    expect((client as unknown as { baseURL: string }).baseURL).toContain('openai.com');
  });
});

// ---------------------------------------------------------------------------
// @agentclientprotocol/sdk — exports existence checks
// ---------------------------------------------------------------------------

describe('@agentclientprotocol/sdk', () => {
  test('can be imported', async () => {
    const mod = await import('@agentclientprotocol/sdk');
    expect(mod).toBeDefined();
  });

  test('exports AgentSideConnection class', async () => {
    const mod = await import('@agentclientprotocol/sdk');
    expect(typeof mod.AgentSideConnection).toBe('function');
  });

  test('exports ClientSideConnection class', async () => {
    const mod = await import('@agentclientprotocol/sdk');
    expect(typeof mod.ClientSideConnection).toBe('function');
  });

  test('exports TerminalHandle class', async () => {
    const mod = await import('@agentclientprotocol/sdk');
    expect(typeof mod.TerminalHandle).toBe('function');
  });

  test('exports RequestError class', async () => {
    const mod = await import('@agentclientprotocol/sdk');
    expect(typeof mod.RequestError).toBe('function');
  });

  test('RequestError is an Error subclass', async () => {
    const { RequestError } = await import('@agentclientprotocol/sdk');
    const err = new RequestError(42, 'test error');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('test error');
  });

  test('exports PROTOCOL_VERSION', async () => {
    const mod = await import('@agentclientprotocol/sdk');
    // PROTOCOL_VERSION is a number constant
    expect(mod.PROTOCOL_VERSION).toBeDefined();
    expect(typeof mod.PROTOCOL_VERSION === 'number' || typeof mod.PROTOCOL_VERSION === 'string').toBe(true);
  });

  test('exports ndJsonStream factory function', async () => {
    const mod = await import('@agentclientprotocol/sdk');
    expect(typeof mod.ndJsonStream).toBe('function');
  });

  test('exports AGENT_METHODS and CLIENT_METHODS method maps', async () => {
    const mod = await import('@agentclientprotocol/sdk');
    // AGENT_METHODS and CLIENT_METHODS are objects (method-name dictionaries)
    expect(mod.AGENT_METHODS).toBeDefined();
    expect(mod.CLIENT_METHODS).toBeDefined();
    expect(typeof mod.AGENT_METHODS).toBe('object');
    expect(typeof mod.CLIENT_METHODS).toBe('object');
    expect(Object.keys(mod.AGENT_METHODS as object).length).toBeGreaterThan(0);
    expect(Object.keys(mod.CLIENT_METHODS as object).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Pin agreement with the platform
// ---------------------------------------------------------------------------

describe('dependency ranges agree with the platform that declares them', () => {
  /**
   * bun.lock resolves exactly ONE copy of a package both this repository and
   * the SDK depend on. When the two declare different ranges the older one can
   * win, and the SDK is then compiled and run against a version older than the
   * one it is written for — which is how an ACP pin five minors behind the
   * SDK's went unnoticed. Nothing observes that at runtime, so it is asserted
   * here on the declarations themselves.
   */
  test('every shared dependency states the same range the SDK declares', async () => {
    const ours = (await import(join(repoRoot, 'package.json'))).default as {
      dependencies?: Record<string, string>;
    };
    const platform = (await import(join(repoRoot, 'node_modules', '@pellux', 'goodvibes-sdk', 'package.json'))).default as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const declared = {
      ...(platform.dependencies ?? {}),
      ...(platform.peerDependencies ?? {}),
      ...(platform.optionalDependencies ?? {}),
    };
    const drift = Object.entries(ours.dependencies ?? {})
      .filter(([name, range]) => name in declared && declared[name] !== range)
      .map(([name, range]) => `${name}: this repo ${range}, platform ${declared[name]}`);
    expect(drift).toEqual([]);
  });
});
