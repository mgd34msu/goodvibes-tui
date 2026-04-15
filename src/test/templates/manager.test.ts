import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, existsSync } from 'fs';
import { TemplateManager, parseTemplateArgs } from '@pellux/goodvibes-sdk/platform/templates/manager';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/** Create an isolated temp directory for each test run. */
function createTempDir(): string {
  return makeProjectTempDir('gv-tmpl-test');
}

describe('TemplateManager', () => {
  let tmpDir: string;
  let manager: TemplateManager;

  beforeEach(() => {
    tmpDir = createTempDir();
    manager = new TemplateManager({ projectRoot: tmpDir, homeDirectory: tmpDir });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── save / load round-trip ───────────────────────────────

  describe('save and load', () => {
    test('save writes template and load reads it back', () => {
      manager.save('greet', 'Hello, {{name}}!');
      const result = manager.load('greet');
      expect(result).toBe('Hello, {{name}}!');
    });

    test('load returns null for missing template', () => {
      expect(manager.load('does-not-exist')).toBeNull();
    });

    test('save overwrites existing template', () => {
      manager.save('greet', 'Hello v1');
      manager.save('greet', 'Hello v2');
      expect(manager.load('greet')).toBe('Hello v2');
    });

    test('template name is sanitized to safe characters', () => {
      // Names with spaces/special chars are sanitized
      manager.save('My Template!', 'content');
      expect(manager.load('My Template!')).toBe('content');
    });
  });

  // ── list ────────────────────────────────────────────────

  describe('list', () => {
    test('list returns empty array when no templates exist', () => {
      expect(manager.list()).toHaveLength(0);
    });

    test('list returns saved templates', () => {
      manager.save('alpha', 'Content A');
      manager.save('beta', 'Content B');
      const entries = manager.list();
      const names = entries.map(e => e.name).sort();
      expect(names).toEqual(['alpha', 'beta']);
    });

    test('list entry includes name, path, and preview', () => {
      manager.save('sample', 'This is the template preview text.');
      const [entry] = manager.list();
      expect(entry.name).toBe('sample');
      expect(entry.path).toBeString();
      expect(entry.preview).toContain('This is the template');
    });

    test('list entries are sorted alphabetically', () => {
      manager.save('zebra', 'z');
      manager.save('apple', 'a');
      manager.save('mango', 'm');
      const names = manager.list().map(e => e.name);
      expect(names).toEqual(['apple', 'mango', 'zebra']);
    });
  });

  // ── delete ──────────────────────────────────────────────

  describe('delete', () => {
    test('delete removes an existing template', () => {
      manager.save('to-delete', 'bye');
      const deleted = manager.delete('to-delete');
      expect(deleted).toBe(true);
      expect(manager.load('to-delete')).toBeNull();
    });

    test('delete returns false for a non-existent template', () => {
      expect(manager.delete('ghost')).toBe(false);
    });

    test('deleted template no longer appears in list', () => {
      manager.save('keep', 'keep me');
      manager.save('remove', 'remove me');
      manager.delete('remove');
      const names = manager.list().map(e => e.name);
      expect(names).not.toContain('remove');
      expect(names).toContain('keep');
    });
  });

  // ── expand: positional args ──────────────────────────────

  describe('expand with positional args', () => {
    test('replaces {{1}} with first positional arg', () => {
      const result = manager.expand('Review {{1}}', { '1': 'src/main.ts' });
      expect(result).toBe('Review src/main.ts');
    });

    test('replaces multiple positional args', () => {
      const result = manager.expand('{{1}} and {{2}}', { '1': 'foo', '2': 'bar' });
      expect(result).toBe('foo and bar');
    });
  });

  // ── expand: named args ───────────────────────────────────

  describe('expand with named args', () => {
    test('replaces {{file}} with named arg', () => {
      const result = manager.expand('Review {{file}} for issues.', { file: 'src/index.ts' });
      expect(result).toBe('Review src/index.ts for issues.');
    });

    test('replaces multiple named args', () => {
      const result = manager.expand('{{action}} {{target}}', { action: 'Refactor', target: 'utils.ts' });
      expect(result).toBe('Refactor utils.ts');
    });
  });

  // ── expand: missing variables left as-is ────────────────

  describe('expand with missing variables', () => {
    test('leaves missing variable as {{var_name}}', () => {
      const result = manager.expand('Hello {{name}}!', {});
      expect(result).toBe('Hello {{name}}!');
    });

    test('expands provided variables but leaves missing ones', () => {
      const result = manager.expand('{{a}} and {{b}}', { a: 'X' });
      expect(result).toBe('X and {{b}}');
    });
  });

  // ── expand: template chaining ────────────────────────────

  describe('expand with template chaining', () => {
    test('expands {{template:name}} by loading and inlining the referenced template', () => {
      manager.save('greeting', 'Hello from nested!');
      const result = manager.expand('Start: {{template:greeting}}', {});
      expect(result).toBe('Start: Hello from nested!');
    });

    test('nested template also has its variables expanded', () => {
      manager.save('inner', 'inner {{val}}');
      const result = manager.expand('outer {{template:inner}}', { val: 'X' });
      expect(result).toBe('outer inner X');
    });

    test('unknown template reference is left as-is', () => {
      const result = manager.expand('{{template:missing}}', {});
      expect(result).toBe('{{template:missing}}');
    });

    test('template chaining respects max depth of 3', () => {
      // depth 0 calls depth 1 calls depth 2 calls depth 3 — depth 4 would be skipped
      manager.save('d1', 'D1:{{template:d2}}');
      manager.save('d2', 'D2:{{template:d3}}');
      manager.save('d3', 'D3:{{template:d4}}');
      manager.save('d4', 'D4-LEAF');
      const result = manager.expand('Root:{{template:d1}}', {});
      // At depth 3 (expanding d3), it calls expand at depth=3 which is the limit
      // d3 contains {{template:d4}} — _depth=3, so max depth check triggers
      expect(result).toContain('Root:D1:D2:D3:');
    });
  });
});

// ── parseTemplateArgs ────────────────────────────────────

describe('parseTemplateArgs', () => {
  test('positional args assigned to 1-based indices', () => {
    const result = parseTemplateArgs(['foo', 'bar']);
    expect(result).toEqual({ '1': 'foo', '2': 'bar' });
  });

  test('named args parsed from key=value syntax', () => {
    const result = parseTemplateArgs(['file=src/main.ts']);
    expect(result).toEqual({ file: 'src/main.ts' });
  });

  test('mixed positional and named args', () => {
    const result = parseTemplateArgs(['src/main.ts', 'mode=strict']);
    expect(result).toEqual({ '1': 'src/main.ts', mode: 'strict' });
  });

  test('empty args returns empty object', () => {
    expect(parseTemplateArgs([])).toEqual({});
  });

  test('value can contain equals sign', () => {
    const result = parseTemplateArgs(['expr=a=b=c']);
    expect(result).toEqual({ expr: 'a=b=c' });
  });
});
