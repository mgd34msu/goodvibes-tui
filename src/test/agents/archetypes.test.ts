import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArchetypeLoader } from '@pellux/goodvibes-sdk/platform/agents/archetypes';
import type { AgentArchetype } from '@pellux/goodvibes-sdk/platform/agents/archetypes';
import { getTestArchetypeLoader, resetTestRuntimeServices } from '../helpers/runtime-services.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gv-archetypes-test-'));
}

function writeAgentMd(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetTestRuntimeServices();
});

// ---------------------------------------------------------------------------
// Built-in archetypes (no .md directory)
// ---------------------------------------------------------------------------

describe('built-in archetypes', () => {
  test('listArchetypes returns 5 built-in archetypes when no agents dir', () => {
    const loader = new ArchetypeLoader('/nonexistent/path');
    const archetypes = loader.listArchetypes();
    expect(archetypes.length).toBe(5);
  });

  test('built-ins include engineer, reviewer, tester, researcher, general', () => {
    const loader = new ArchetypeLoader('/nonexistent/path');
    const names = loader.listArchetypes().map((a) => a.name);
    expect(names).toContain('engineer');
    expect(names).toContain('reviewer');
    expect(names).toContain('tester');
    expect(names).toContain('researcher');
    expect(names).toContain('general');
  });

  test('built-in archetypes have non-empty tools array', () => {
    const loader = new ArchetypeLoader('/nonexistent/path');
    for (const archetype of loader.listArchetypes()) {
      expect(archetype.tools.length).toBeGreaterThan(0);
    }
  });

  test('built-in archetypes have isCustom=false', () => {
    const loader = new ArchetypeLoader('/nonexistent/path');
    for (const archetype of loader.listArchetypes()) {
      expect(archetype.isCustom).toBe(false);
    }
  });

  test('loadArchetype returns null for unknown name', () => {
    const loader = new ArchetypeLoader('/nonexistent/path');
    expect(loader.loadArchetype('nonexistent-archetype')).toBeNull();
  });

  test('loadArchetype returns built-in for known name', () => {
    const loader = new ArchetypeLoader('/nonexistent/path');
    const archetype = loader.loadArchetype('engineer');
    expect(archetype).not.toBeNull();
    expect(archetype!.name).toBe('engineer');
    expect(archetype!.tools).toContain('read');
    expect(archetype!.tools).toContain('write');
  });
});

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

describe('frontmatter parsing', () => {
  test('loads archetype from markdown file with basic frontmatter', () => {
    const dir = makeTempDir();
    writeAgentMd(dir, 'custom.md', [
      '---',
      'name: custom',
      'description: A custom agent',
      'tools: [read, write, analyze]',
      '---',
      '',
      'This is the system prompt body.',
    ].join('\n'));

    const loader = new ArchetypeLoader(dir);
    const archetype = loader.loadArchetype('custom');
    expect(archetype).not.toBeNull();
    expect(archetype!.name).toBe('custom');
    expect(archetype!.description).toBe('A custom agent');
    expect(archetype!.tools).toEqual(['read', 'write', 'analyze']);
    expect(archetype!.isCustom).toBe(true);
    expect(archetype!.origin).toBe('local-markdown');
    expect(archetype!.sourcePath).toContain('custom.md');
    expect(archetype!.validationIssues).toEqual([]);
  });

  test('loads system prompt from markdown body (lazy)', () => {
    const dir = makeTempDir();
    writeAgentMd(dir, 'bodytest.md', [
      '---',
      'name: bodytest',
      'description: Has a system prompt body',
      'tools: [read]',
      '---',
      '',
      'You are a specialized read-only agent.',
      'Focus on analysis.',
    ].join('\n'));

    const loader = new ArchetypeLoader(dir);
    const archetype = loader.loadArchetype('bodytest');
    expect(archetype!.systemPrompt).toBeTruthy();
    expect(archetype!.systemPrompt).toContain('specialized read-only agent');
  });

  test('loads inline system_prompt from frontmatter', () => {
    const dir = makeTempDir();
    writeAgentMd(dir, 'inline.md', [
      '---',
      'name: inline',
      'description: Has inline system prompt',
      'tools: [read]',
      'system_prompt: You are an inline agent.',
      '---',
    ].join('\n'));

    const loader = new ArchetypeLoader(dir);
    const archetype = loader.loadArchetype('inline');
    expect(archetype!.systemPrompt).toBe('You are an inline agent.');
  });

  test('loads model and provider from frontmatter', () => {
    const dir = makeTempDir();
    writeAgentMd(dir, 'withmodel.md', [
      '---',
      'name: withmodel',
      'description: Has model override',
      'tools: [read]',
      'model: gpt-5',
      'provider: openai',
      '---',
    ].join('\n'));

    const loader = new ArchetypeLoader(dir);
    const archetype = loader.loadArchetype('withmodel');
    expect(archetype!.model).toBe('gpt-5');
    expect(archetype!.provider).toBe('openai');
  });

  test('uses filename as name when frontmatter has no name field', () => {
    const dir = makeTempDir();
    writeAgentMd(dir, 'autoname.md', [
      '---',
      'description: No name in frontmatter',
      'tools: [read]',
      '---',
    ].join('\n'));

    const loader = new ArchetypeLoader(dir);
    const archetype = loader.loadArchetype('autoname');
    expect(archetype).not.toBeNull();
    expect(archetype!.name).toBe('autoname');
  });

  test('handles multi-line tools list (YAML list format)', () => {
    const dir = makeTempDir();
    writeAgentMd(dir, 'multitools.md', [
      '---',
      'name: multitools',
      'description: Multi-line tools',
      'tools:',
      '  - read',
      '  - write',
      '  - exec',
      '---',
    ].join('\n'));

    const loader = new ArchetypeLoader(dir);
    const archetype = loader.loadArchetype('multitools');
    expect(archetype!.tools).toEqual(['read', 'write', 'exec']);
  });

  test('skips files without frontmatter delimiters', () => {
    const dir = makeTempDir();
    writeAgentMd(dir, 'nofrontmatter.md', 'Just a plain markdown file with no frontmatter.');

    const loader = new ArchetypeLoader(dir);
    // Should not appear in list since no frontmatter
    const archetype = loader.loadArchetype('nofrontmatter');
    expect(archetype).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Progressive loading
// ---------------------------------------------------------------------------

describe('progressive loading', () => {
  test('listArchetypes does not yet load system prompt body', () => {
    const dir = makeTempDir();
    writeAgentMd(dir, 'lazy.md', [
      '---',
      'name: lazy',
      'description: Lazy loaded',
      'tools: [read]',
      '---',
      '',
      'Large system prompt content here.',
    ].join('\n'));

    const loader = new ArchetypeLoader(dir);
    const listed = loader.listArchetypes().find((a) => a.name === 'lazy');
    // systemPrompt should not be populated yet (progressive loading)
    expect(listed!.systemPrompt).toBeUndefined();

    // After loadArchetype, it should be populated
    const loaded = loader.loadArchetype('lazy');
    expect(loaded!.systemPrompt).toContain('Large system prompt content');
  });

  test('custom archetype overrides built-in with same name', () => {
    const dir = makeTempDir();
    writeAgentMd(dir, 'engineer.md', [
      '---',
      'name: engineer',
      'description: Custom engineer override',
      'tools: [read, find]',
      '---',
    ].join('\n'));

    const loader = new ArchetypeLoader(dir);
    const archetype = loader.loadArchetype('engineer');
    // Custom should override built-in
    expect(archetype!.description).toBe('Custom engineer override');
    expect(archetype!.tools).toEqual(['read', 'find']);
    expect(archetype!.isCustom).toBe(true);
  });

  test('list exposes preview/includes while load materializes @ references', () => {
    const dir = makeTempDir();
    writeAgentMd(dir, 'shared.md', 'Shared instructions.');
    writeAgentMd(dir, 'withrefs.md', [
      '---',
      'name: withrefs',
      'description: Uses linked prompt fragments',
      'tools: [read]',
      '---',
      '',
      'Before include.',
      '@shared.md',
      'After include.',
    ].join('\n'));

    const loader = new ArchetypeLoader(dir);
    const listed = loader.listArchetypes().find((entry) => entry.name === 'withrefs');
    expect(listed?.preview).toContain('Before include.');
    expect(listed?.includes).toEqual(['shared.md']);

    const loaded = loader.loadArchetype('withrefs');
    expect(loaded?.systemPrompt).toContain('Shared instructions.');
  });
});

// ---------------------------------------------------------------------------
// mergeWithOverrides
// ---------------------------------------------------------------------------

describe('mergeWithOverrides', () => {
  test('overrides model and provider', () => {
    const loader = new ArchetypeLoader('/nonexistent/path');
    const merged = loader.mergeWithOverrides('engineer', { model: 'claude-3', provider: 'anthropic' });
    expect(merged).not.toBeNull();
    expect(merged!.model).toBe('claude-3');
    expect(merged!.provider).toBe('anthropic');
  });

  test('overrides tools array', () => {
    const loader = new ArchetypeLoader('/nonexistent/path');
    const merged = loader.mergeWithOverrides('engineer', { tools: ['read', 'find'] });
    expect(merged!.tools).toEqual(['read', 'find']);
  });

  test('non-overridden fields preserve archetype defaults', () => {
    const loader = new ArchetypeLoader('/nonexistent/path');
    const merged = loader.mergeWithOverrides('engineer', {});
    expect(merged!.name).toBe('engineer');
    expect(merged!.description).toBeTruthy();
    expect(merged!.tools.length).toBeGreaterThan(0);
  });

  test('returns null for unknown archetype', () => {
    const loader = new ArchetypeLoader('/nonexistent/path');
    const merged = loader.mergeWithOverrides('nonexistent', { model: 'gpt-5' });
    expect(merged).toBeNull();
  });
});

describe('runtime ownership', () => {
  test('test runtime exposes one archetype loader per runtime graph', () => {
    const a = getTestArchetypeLoader();
    const b = getTestArchetypeLoader();
    expect(a).toBe(b);
  });

  test('resetting the test runtime creates a fresh loader graph', () => {
    const a = getTestArchetypeLoader();
    resetTestRuntimeServices();
    const b = getTestArchetypeLoader();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe('error resilience', () => {
  test('handles agents dir with no .md files gracefully', () => {
    const dir = makeTempDir();
    const loader = new ArchetypeLoader(dir);
    const archetypes = loader.listArchetypes();
    // Only built-ins
    expect(archetypes.length).toBe(5);
    expect(archetypes.every((a) => !a.isCustom)).toBe(true);
  });

  test('handles malformed frontmatter gracefully (still loads built-ins)', () => {
    const dir = makeTempDir();
    writeAgentMd(dir, 'broken.md', '---\nthis is not yaml: [unclosed\n---\nBody');
    const loader = new ArchetypeLoader(dir);
    // Broken file should be skipped, built-ins still available
    const archetypes = loader.listArchetypes();
    expect(archetypes.find((a) => a.name === 'general')).toBeTruthy();
  });
});
