/**
 * Tests for the registry tool.
 *
 * Uses a temporary directory tree with fake .goodvibes/skills and
 * .goodvibes/agents to isolate tests from the real filesystem.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import { createRegistryTool } from '@pellux/goodvibes-sdk/platform/tools';
import type { Tool, ToolDefinition } from '@pellux/goodvibes-sdk/platform/types';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();

function makeTmpDir(): string {
  // makeProjectTempDir registers the directory with the shared cleanup registry,
  // so the test process removes it before it ends. The hand-rolled creation this
  // replaced was tracked by nothing and left directories under .test-tmp behind
  // after a fully green run.
  return makeProjectTempDir('registry-tool');
}

function makeTool(name: string, description = `Mock tool: ${name}`): Tool {
  return {
    definition: {
      name,
      description,
      parameters: { type: 'object', properties: {}, required: [] },
    } as ToolDefinition,
    execute: async () => ({ success: true, output: 'ok' }),
  };
}

type RegistryToolParsedResult = Omit<Awaited<ReturnType<ReturnType<typeof createRegistryTool>['execute']>>, 'callId'> & {
  parsed?: unknown;
};

async function run<TParsed>(
  tool: ReturnType<typeof createRegistryTool>,
  args: Record<string, unknown>,
): Promise<Omit<RegistryToolParsedResult, 'parsed'> & { parsed: TParsed }> {
  const result = await tool.execute(args);
  if (!result.success) {
    throw new Error(result.error ?? 'registry tool execution failed');
  }
  return { ...result, parsed: JSON.parse(result.output!) as TParsed };
}

type RegistryEntry = {
  name: string;
  type: string;
  description: string;
  path: string;
};

type SearchModeOutput = { count: number; results: RegistryEntry[] };
type RecommendModeOutput = { scope: string; results: RegistryEntry[] };
type DependencyModeOutput = { depends_on: string[]; includes: string[] };
type ContentModeOutput = {
  content: string;
  metadata: {
    name: string;
    description?: string;
  };
};
type PreviewModeOutput = {
  preview: string;
  includes: string[];
  dependencies: string[];
  sections: string[];
};

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let toolRegistry: ToolRegistry;
let tool: ReturnType<typeof createRegistryTool>;

beforeEach(() => {
  tmpDir = makeTmpDir();

  // Create skills directory with two skill files
  mkdirSync(join(tmpDir, '.goodvibes', 'skills'), { recursive: true });
  writeFileSync(
    join(tmpDir, '.goodvibes', 'skills', 'code-review.md'),
    '---\nname: code-review\ndescription: Automated code review workflow\n---\n\nBody content here.\n',
  );
  writeFileSync(
    join(tmpDir, '.goodvibes', 'skills', 'test-driven.md'),
    '---\nname: test-driven\ndescription: TDD workflow\ndepends_on: code-review, some-other-skill\n---\n\n@some-include\nBody here.\n',
  );

  // Create agents directory with one agent file
  mkdirSync(join(tmpDir, '.goodvibes', 'agents'), { recursive: true });
  writeFileSync(
    join(tmpDir, '.goodvibes', 'agents', 'researcher.md'),
    '---\nname: researcher\narchetype: analyst\ndescription: Research agent that gathers information\n---\n\nAgent body.\n',
  );

  // Build a small ToolRegistry with a couple of mock tools
  toolRegistry = new ToolRegistry();
  toolRegistry.register(makeTool('read', 'Read files from disk'));
  toolRegistry.register(makeTool('write', 'Write files to disk'));
  toolRegistry.register(makeTool('shell-exec', 'Execute shell commands'));

  tool = createRegistryTool(toolRegistry, { workingDirectory: tmpDir });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// search mode
// ---------------------------------------------------------------------------

describe('search mode', () => {
  test('finds skill by name', async () => {
    const res = await run<SearchModeOutput>(tool, { mode: 'search', query: 'code-review', type: 'skills' });
    expect(res.parsed.results).toHaveLength(1);
    expect(res.parsed.results[0]?.name).toBe('code-review');
    expect(res.parsed.results[0]?.type).toBe('skill');
  });

  test('finds agent by name', async () => {
    const res = await run<SearchModeOutput>(tool, { mode: 'search', query: 'researcher', type: 'agents' });
    expect(res.parsed.results).toHaveLength(1);
    expect(res.parsed.results[0]?.name).toBe('researcher');
    expect(res.parsed.results[0]?.type).toBe('agent');
  });

  test('finds tool by name from ToolRegistry', async () => {
    const res = await run<SearchModeOutput>(tool, { mode: 'search', query: 'shell-exec', type: 'tools' });
    expect(res.parsed.results).toHaveLength(1);
    expect(res.parsed.results[0]?.name).toBe('shell-exec');
    expect(res.parsed.results[0]?.type).toBe('tool');
  });

  test('type filter "skills" excludes agents and tools', async () => {
    const res = await run<SearchModeOutput>(tool, { mode: 'search', type: 'skills' });
    for (const item of res.parsed.results) {
      expect(item.type).toBe('skill');
    }
  });

  test('type filter "agents" excludes skills and tools', async () => {
    const res = await run<SearchModeOutput>(tool, { mode: 'search', type: 'agents' });
    for (const item of res.parsed.results) {
      expect(item.type).toBe('agent');
    }
  });

  test('type filter "tools" excludes skills and agents', async () => {
    const res = await run<SearchModeOutput>(tool, { mode: 'search', type: 'tools' });
    for (const item of res.parsed.results) {
      expect(item.type).toBe('tool');
    }
  });

  test('type "all" (default) returns skills, agents, and tools', async () => {
    const res = await run<SearchModeOutput>(tool, { mode: 'search' });
    const types = new Set(res.parsed.results.map((r: { type: string }) => r.type));
    expect(types.has('skill')).toBe(true);
    expect(types.has('agent')).toBe(true);
    expect(types.has('tool')).toBe(true);
  });

  test('returns empty results for no-match query', async () => {
    const res = await run<SearchModeOutput>(tool, { mode: 'search', query: 'zzz-no-match-xyz' });
    expect(res.parsed.count).toBe(0);
    expect(res.parsed.results).toHaveLength(0);
  });

  test('search includes description in match target', async () => {
    const res = await run<SearchModeOutput>(tool, { mode: 'search', query: 'gathers information', type: 'agents' });
    expect(res.parsed.results.length).toBeGreaterThan(0);
    expect(res.parsed.results[0]?.name).toBe('researcher');
  });
});

// ---------------------------------------------------------------------------
// recommend mode
// ---------------------------------------------------------------------------

describe('recommend mode', () => {
  test('returns all skills when no task given', async () => {
    const res = await run<RecommendModeOutput>(tool, { mode: 'recommend' });
    expect(res.parsed.scope).toBe('skills');
    expect(res.parsed.results.length).toBeGreaterThanOrEqual(2);
  });

  test('returns tools when scope=tools', async () => {
    const res = await run<RecommendModeOutput>(tool, { mode: 'recommend', scope: 'tools' });
    for (const item of res.parsed.results) {
      expect(item.type).toBe('tool');
    }
  });

  test('sorts results by keyword relevance to task', async () => {
    const res = await run<RecommendModeOutput>(tool, { mode: 'recommend', task: 'review code quality', scope: 'skills' });
    // code-review has "review" and "code" in name+description so should rank before test-driven
    // Note: global ~/.goodvibes/tui/skills may also appear; we verify relative ordering of fixtures
    const names = res.parsed.results.map((r: { name: string }) => r.name);
    const codeReviewIdx = names.indexOf('code-review');
    const testDrivenIdx = names.indexOf('test-driven');
    expect(codeReviewIdx).toBeGreaterThanOrEqual(0); // code-review must appear
    if (testDrivenIdx >= 0) {
      // When test-driven is present, code-review should rank before it
      expect(codeReviewIdx).toBeLessThan(testDrivenIdx);
    }
  });

  test('result items have name, type, description, path fields', async () => {
    const res = await run<RecommendModeOutput>(tool, { mode: 'recommend' });
    for (const item of res.parsed.results) {
      expect(typeof item.name).toBe('string');
      expect(typeof item.type).toBe('string');
      expect(typeof item.description).toBe('string');
      expect('path' in item).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// dependencies mode
// ---------------------------------------------------------------------------

describe('dependencies mode', () => {
  test('reads depends_on from frontmatter', async () => {
    const res = await run<DependencyModeOutput>(tool, { mode: 'dependencies', skillName: 'test-driven' });
    expect(res.parsed.depends_on).toContain('code-review');
    expect(res.parsed.depends_on).toContain('some-other-skill');
  });

  test('returns empty depends_on for skill with no dependencies', async () => {
    const res = await run<DependencyModeOutput>(tool, { mode: 'dependencies', skillName: 'code-review' });
    expect(res.parsed.depends_on).toEqual([]);
  });

  test('detects @ include directives in body', async () => {
    const res = await run<DependencyModeOutput>(tool, { mode: 'dependencies', skillName: 'test-driven' });
    expect(res.parsed.includes).toContain('some-include');
  });

  test('returns error when skillName is missing', async () => {
    const res = await tool.execute({ mode: 'dependencies' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('skillName');
  });

  test('returns error for unknown skill', async () => {
    const res = await tool.execute({ mode: 'dependencies', skillName: 'no-such-skill' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('no-such-skill');
  });
});

// ---------------------------------------------------------------------------
// content mode
// ---------------------------------------------------------------------------

describe('content mode', () => {
  test('returns full content and metadata for skill file', async () => {
    writeFileSync(join(tmpDir, '.goodvibes', 'skills', 'snippet.md'), 'Included snippet body.', 'utf-8');
    writeFileSync(
      join(tmpDir, '.goodvibes', 'skills', 'code-review.md'),
      '---\nname: code-review\ndescription: Automated code review workflow\n---\n\nBody content here.\n@snippet.md\n',
    );
    const filePath = join(tmpDir, '.goodvibes', 'skills', 'code-review.md');
    const res = await run<ContentModeOutput>(tool, { mode: 'content', path: filePath });
    expect(res.parsed.content).toContain('Body content here');
    expect(res.parsed.content).toContain('Included snippet body.');
    expect(res.parsed.metadata.name).toBe('code-review');
    expect(res.parsed.metadata.description).toBe('Automated code review workflow');
  });

  test('returns full content and metadata for agent file', async () => {
    const filePath = join(tmpDir, '.goodvibes', 'agents', 'researcher.md');
    const res = await run<ContentModeOutput>(tool, { mode: 'content', path: filePath });
    expect(res.parsed.content).toContain('Agent body');
    expect(res.parsed.metadata.name).toBe('researcher');
  });

  test('returns error for missing file', async () => {
    const res = await tool.execute({ mode: 'content', path: '/home/does/not/.goodvibes/exist.md' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('not found');
  });

  test('returns error when path is missing', async () => {
    const res = await tool.execute({ mode: 'content' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('path');
  });
});

describe('preview mode', () => {
  test('returns preview metadata without full body materialization', async () => {
    const filePath = join(tmpDir, '.goodvibes', 'skills', 'test-driven.md');
    const res = await run<PreviewModeOutput>(tool, { mode: 'preview', path: filePath });
    expect(res.parsed.preview).toContain('Body here.');
    expect(res.parsed.includes).toContain('some-include');
    expect(res.parsed.dependencies).toContain('code-review');
  });
});

// ---------------------------------------------------------------------------
// invalid mode
// ---------------------------------------------------------------------------

test('invalid mode returns error', async () => {
  const res = await tool.execute({ mode: 'bogusMode' });
  expect(res.success).toBe(false);
  expect(res.error).toContain('bogusMode');
});

// ---------------------------------------------------------------------------
// tool definition
// ---------------------------------------------------------------------------

test('tool has correct name', () => {
  expect(tool.definition.name).toBe('registry');
});

test('tool has non-empty description', () => {
  expect(tool.definition.description.length).toBeGreaterThan(0);
});

test('tool has parameters object', () => {
  expect(typeof tool.definition.parameters).toBe('object');
});
