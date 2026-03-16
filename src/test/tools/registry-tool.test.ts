/**
 * Tests for the registry tool.
 *
 * Uses a temporary directory tree with fake .goodvibes/skills and
 * .goodvibes/agents to isolate tests from the real filesystem.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, existsSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolRegistry } from '../../tools/registry.ts';
import { createRegistryTool } from '../../tools/registry-tool/index.ts';
import type { Tool, ToolDefinition } from '../../types/tools.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();

function makeTmpDir(): string {
  const base = join(PROJECT_ROOT, '.test-tmp');
  if (!existsSync(base)) mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, 'registry-tool-'));
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

async function run(
  tool: ReturnType<typeof createRegistryTool>,
  args: Record<string, unknown>,
) {
  const result = await tool.execute(args);
  if (!result.success) return result;
  return { ...result, parsed: JSON.parse(result.output!) };
}

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let origCwd: () => string;
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

  // Override process.cwd so tool sees our tmp dir
  origCwd = process.cwd.bind(process);
  (process as unknown as Record<string, unknown>).cwd = () => tmpDir;

  // Build a small ToolRegistry with a couple of mock tools
  toolRegistry = new ToolRegistry();
  toolRegistry.register(makeTool('read', 'Read files from disk'));
  toolRegistry.register(makeTool('write', 'Write files to disk'));
  toolRegistry.register(makeTool('shell-exec', 'Execute shell commands'));

  tool = createRegistryTool(toolRegistry);
});

afterEach(() => {
  (process as unknown as Record<string, unknown>).cwd = origCwd;
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// search mode
// ---------------------------------------------------------------------------

describe('search mode', () => {
  test('finds skill by name', async () => {
    const res = await run(tool, { mode: 'search', query: 'code-review', type: 'skills' });
    expect(res.parsed.results).toHaveLength(1);
    expect(res.parsed.results[0].name).toBe('code-review');
    expect(res.parsed.results[0].type).toBe('skill');
  });

  test('finds agent by name', async () => {
    const res = await run(tool, { mode: 'search', query: 'researcher', type: 'agents' });
    expect(res.parsed.results).toHaveLength(1);
    expect(res.parsed.results[0].name).toBe('researcher');
    expect(res.parsed.results[0].type).toBe('agent');
  });

  test('finds tool by name from ToolRegistry', async () => {
    const res = await run(tool, { mode: 'search', query: 'shell-exec', type: 'tools' });
    expect(res.parsed.results).toHaveLength(1);
    expect(res.parsed.results[0].name).toBe('shell-exec');
    expect(res.parsed.results[0].type).toBe('tool');
  });

  test('type filter "skills" excludes agents and tools', async () => {
    const res = await run(tool, { mode: 'search', type: 'skills' });
    for (const item of res.parsed.results) {
      expect(item.type).toBe('skill');
    }
  });

  test('type filter "agents" excludes skills and tools', async () => {
    const res = await run(tool, { mode: 'search', type: 'agents' });
    for (const item of res.parsed.results) {
      expect(item.type).toBe('agent');
    }
  });

  test('type filter "tools" excludes skills and agents', async () => {
    const res = await run(tool, { mode: 'search', type: 'tools' });
    for (const item of res.parsed.results) {
      expect(item.type).toBe('tool');
    }
  });

  test('type "all" (default) returns skills, agents, and tools', async () => {
    const res = await run(tool, { mode: 'search' });
    const types = new Set(res.parsed.results.map((r: { type: string }) => r.type));
    expect(types.has('skill')).toBe(true);
    expect(types.has('agent')).toBe(true);
    expect(types.has('tool')).toBe(true);
  });

  test('returns empty results for no-match query', async () => {
    const res = await run(tool, { mode: 'search', query: 'zzz-no-match-xyz' });
    expect(res.parsed.count).toBe(0);
    expect(res.parsed.results).toHaveLength(0);
  });

  test('search includes description in match target', async () => {
    const res = await run(tool, { mode: 'search', query: 'gathers information', type: 'agents' });
    expect(res.parsed.results.length).toBeGreaterThan(0);
    expect(res.parsed.results[0].name).toBe('researcher');
  });
});

// ---------------------------------------------------------------------------
// recommend mode
// ---------------------------------------------------------------------------

describe('recommend mode', () => {
  test('returns all skills when no task given', async () => {
    const res = await run(tool, { mode: 'recommend' });
    expect(res.parsed.scope).toBe('skills');
    expect(res.parsed.results.length).toBeGreaterThanOrEqual(2);
  });

  test('returns tools when scope=tools', async () => {
    const res = await run(tool, { mode: 'recommend', scope: 'tools' });
    for (const item of res.parsed.results) {
      expect(item.type).toBe('tool');
    }
  });

  test('sorts results by keyword relevance to task', async () => {
    const res = await run(tool, { mode: 'recommend', task: 'review code quality', scope: 'skills' });
    // code-review skill has "review" and "code" in name+description so should rank first
    expect(res.parsed.results[0].name).toBe('code-review');
  });

  test('result items have name, type, description, path fields', async () => {
    const res = await run(tool, { mode: 'recommend' });
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
    const res = await run(tool, { mode: 'dependencies', skillName: 'test-driven' });
    expect(res.parsed.depends_on).toContain('code-review');
    expect(res.parsed.depends_on).toContain('some-other-skill');
  });

  test('returns empty depends_on for skill with no dependencies', async () => {
    const res = await run(tool, { mode: 'dependencies', skillName: 'code-review' });
    expect(res.parsed.depends_on).toEqual([]);
  });

  test('detects @ include directives in body', async () => {
    const res = await run(tool, { mode: 'dependencies', skillName: 'test-driven' });
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
    const filePath = join(tmpDir, '.goodvibes', 'skills', 'code-review.md');
    const res = await run(tool, { mode: 'content', path: filePath });
    expect(res.parsed.content).toContain('Body content here');
    expect(res.parsed.metadata.name).toBe('code-review');
    expect(res.parsed.metadata.description).toBe('Automated code review workflow');
  });

  test('returns full content and metadata for agent file', async () => {
    const filePath = join(tmpDir, '.goodvibes', 'agents', 'researcher.md');
    const res = await run(tool, { mode: 'content', path: filePath });
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
