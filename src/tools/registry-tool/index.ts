import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import Fuse from 'fuse.js';
import { logger } from '../../utils/logger.ts';
import {
  collectMarkdownReferences,
  extractMarkdownPreview,
  normalizeFrontmatterList,
  parseMarkdownFrontmatter,
  readMarkdownDisclosure,
  materializeMarkdownBody,
} from '../../utils/markdown-disclosure.ts';
import type { Tool, ToolDefinition } from '../../types/tools.ts';
import type { ToolRegistry } from '../registry.ts';
import { REGISTRY_TOOL_SCHEMA } from './schema.ts';
import type { RegistryInput } from './schema.ts';

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) result[key.trim()] = rest.join(':').trim();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Directory scanning helpers
// ---------------------------------------------------------------------------

interface RegistryMatch {
  name: string;
  type: 'skill' | 'agent' | 'tool';
  description: string;
  path: string;
  preview?: string;
  dependencies?: string[];
  includes?: string[];
  sections?: string[];
}

function scanDirectory(
  dir: string,
  itemType: 'skill' | 'agent',
  query: string,
): RegistryMatch[] {
  if (!existsSync(dir)) return [];
  const all = scanDirectoryAll(dir, itemType);
  if (!query) return all;
  return fuzzyFilter(all, query);
}

function scanDirectoryAll(
  dir: string,
  itemType: 'skill' | 'agent',
): RegistryMatch[] {
  if (!existsSync(dir)) return [];
  const results: RegistryMatch[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    // Strategy 1: flat .md file (e.g., skills/foo.md)
    if (entry.endsWith('.md')) {
      const filePath = join(dir, entry);
      let content = '';
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }
      const { metadata: frontmatter, body } = parseMarkdownFrontmatter(content);
      const name = typeof frontmatter['name'] === 'string' ? frontmatter['name'] : entry.replace(/\.md$/, '');
      const description = typeof frontmatter['description'] === 'string' ? frontmatter['description'] : '';
      results.push({
        name,
        type: itemType,
        description,
        path: filePath,
        preview: extractMarkdownPreview(body),
        dependencies: normalizeFrontmatterList(frontmatter['depends_on']),
        includes: collectMarkdownReferences(body),
      });
      continue;
    }

    // Strategy 2: directory with SKILL.md or AGENT.md (e.g., skills/foo/SKILL.md)
    const markerFile = itemType === 'skill' ? 'SKILL.md' : 'AGENT.md';
    const markerPath = join(dir, entry, markerFile);
    if (existsSync(markerPath)) {
      let content = '';
      try {
        content = readFileSync(markerPath, 'utf-8');
      } catch {
        continue;
      }
      const { metadata: frontmatter, body } = parseMarkdownFrontmatter(content);
      const name = typeof frontmatter['name'] === 'string' ? frontmatter['name'] : entry;
      const description = typeof frontmatter['description'] === 'string' ? frontmatter['description'] : '';
      results.push({
        name,
        type: itemType,
        description,
        path: markerPath,
        preview: extractMarkdownPreview(body),
        dependencies: normalizeFrontmatterList(frontmatter['depends_on']),
        includes: collectMarkdownReferences(body),
      });
    }
  }
  return results;
}

/**
 * Fuzzy-filter a list of RegistryMatch items using Fuse.js.
 * Weights: name (3) > path/filename (2) > description (1).
 * Results are sorted by ascending Fuse score (lower = better match).
 */
function fuzzyFilter(items: RegistryMatch[], query: string): RegistryMatch[] {
  if (!query || items.length === 0) return items;
  const fuse = new Fuse(items, {
    keys: [
      { name: 'name', weight: 3 },
      { name: 'path', weight: 2 },
      { name: 'description', weight: 1 },
    ],
    threshold: 0.4,
    includeScore: true,
    minMatchCharLength: 1,
  });
  return fuse.search(query).map((r) => r.item);
}

function getSkillDirs(cwd: string): string[] {
  return [
    join(cwd, '.goodvibes', 'skills'),
    join(cwd, '.goodvibes', 'tui', 'skills'),
    join(homedir(), '.goodvibes', 'skills'),
    join(homedir(), '.goodvibes', 'tui', 'skills'),
  ];
}

function getAgentDirs(cwd: string): string[] {
  return [
    join(cwd, '.goodvibes', 'agents'),
    join(cwd, '.goodvibes', 'tui', 'agents'),
    join(homedir(), '.goodvibes', 'agents'),
    join(homedir(), '.goodvibes', 'tui', 'agents'),
  ];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the `registry` tool bound to the given ToolRegistry.
 *
 * Returns a Tool object conforming to the Tool interface.
 * Never throws from execute().
 */
export function createRegistryTool(toolRegistry: ToolRegistry): Tool {
  const definition: ToolDefinition = {
    name: 'registry',
    description:
      'Discover and inspect skills, agents, and tools.'
      + ' Modes: search finds items by keyword; recommend lists items sorted by relevance;'
      + ' dependencies reads a skill\'s dependency chain; content returns full markdown file.',
    parameters: REGISTRY_TOOL_SCHEMA as unknown as Record<string, unknown>,
    sideEffects: ['read_fs'],
    concurrency: 'parallel',
  };

  async function execute(
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
      if (!args.mode || typeof args.mode !== 'string') {
        return { success: false, error: 'Missing required "mode" field' };
      }
      const input = args as unknown as RegistryInput;
      const { mode } = input;

      switch (mode) {
        case 'search':       return runSearch(input, toolRegistry);
        case 'recommend':    return runRecommend(input, toolRegistry);
        case 'dependencies': return runDependencies(input);
        case 'preview':      return runPreview(input);
        case 'content':      return runContent(input);
        default: {
          return { success: false, error: `Unknown mode: ${String(mode)}` };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug('registry tool: unexpected error', { error: message });
      return { success: false, error: `Unexpected error: ${message}` };
    }
  }

  return { definition, execute };
}

// ---------------------------------------------------------------------------
// Mode handlers
// ---------------------------------------------------------------------------

function runSearch(
  input: RegistryInput,
  toolRegistry: ToolRegistry,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const query = input.query ?? '';
  const typeFilter = input.type ?? 'all';
  const cwd = process.cwd();
  const matches: RegistryMatch[] = [];

  if (typeFilter === 'skills' || typeFilter === 'all') {
    for (const dir of getSkillDirs(cwd)) {
      matches.push(...scanDirectory(dir, 'skill', query));
    }
  }

  if (typeFilter === 'agents' || typeFilter === 'all') {
    for (const dir of getAgentDirs(cwd)) {
      matches.push(...scanDirectory(dir, 'agent', query));
    }
  }

  if (typeFilter === 'tools' || typeFilter === 'all') {
    const allTools: RegistryMatch[] = toolRegistry.list().map((t) => ({
      name: t.definition.name,
      type: 'tool' as const,
      description: t.definition.description,
      path: '',
    }));
    const filtered = query ? fuzzyFilter(allTools, query) : allTools;
    matches.push(...filtered);
  }

  // Deduplicate: project-local entries override global (first seen wins)
  const seen = new Set<string>();
  const deduped = matches.filter((r) => {
    const key = `${r.type}:${r.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return Promise.resolve({
    success: true,
    output: JSON.stringify({
      mode: 'search',
      query,
      count: deduped.length,
      results: deduped,
    }),
  });
}

function runRecommend(
  input: RegistryInput,
  toolRegistry: ToolRegistry,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const task = input.task ?? '';
  const scope = input.scope ?? 'skills';
  const cwd = process.cwd();
  const lowerTask = task.toLowerCase();

  let candidates: RegistryMatch[];

  if (scope === 'tools') {
    candidates = toolRegistry.list().map((t) => ({
      name: t.definition.name,
      type: 'tool' as const,
      description: t.definition.description,
      path: '',
    }));
  } else {
    candidates = [];
    for (const dir of getSkillDirs(cwd)) {
      candidates.push(...scanDirectoryAll(dir, 'skill'));
    }
    // Deduplicate: project-local entries override global (first seen wins)
    const seen = new Set<string>();
    candidates = candidates.filter((r) => {
      const key = `${r.type}:${r.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Use Fuse.js for fuzzy scoring when task is given; otherwise sort alphabetically
  let sorted: RegistryMatch[];
  if (task) {
    sorted = fuzzyFilter(candidates, task);
    // For items not matched by fuzzy (below threshold), append alphabetically
    const matchedNames = new Set(sorted.map((r) => `${r.type}:${r.name}`));
    const unmatched = candidates
      .filter((c) => !matchedNames.has(`${c.type}:${c.name}`))
      .sort((a, b) => a.name.localeCompare(b.name));
    sorted = [...sorted, ...unmatched];
  } else {
    // No task — fall back to simple word-overlap scoring.
    const lowerTask2 = lowerTask; // already empty string
    const taskWords = lowerTask2.split(/\s+/).filter(Boolean);
    const scored = candidates.map((item) => {
      const target = `${item.name} ${item.description}`.toLowerCase();
      const score = taskWords.reduce((acc, word) => acc + (target.includes(word) ? 1 : 0), 0);
      return { ...item, score };
    });
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    sorted = scored;
  }

  return Promise.resolve({
    success: true,
    output: JSON.stringify({
      mode: 'recommend',
      task,
      scope,
      count: sorted.length,
      results: sorted.map(({ score: _score, ...item }: { score?: number } & RegistryMatch) => {
        // strip internal score if present (from fallback path)
        const { score: _s, ...rest } = { score: undefined, ...item };
        void _s;
        return rest;
      }),
    }),
  });
}

function runDependencies(
  input: RegistryInput,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const skillName = input.skillName;
  if (!skillName) {
    return Promise.resolve({
      success: false,
      error: 'mode "dependencies" requires "skillName"',
    });
  }

  const cwd = process.cwd();
  let filePath: string | null = null;

  for (const dir of getSkillDirs(cwd)) {
    const candidate = join(dir, `${skillName}.md`);
    if (existsSync(candidate)) {
      filePath = candidate;
      break;
    }
    // Also try exact match without .md appended (caller may have included extension)
    const candidateExact = join(dir, skillName);
    if (existsSync(candidateExact)) {
      filePath = candidateExact;
      break;
    }
  }

  if (!filePath) {
    return Promise.resolve({
      success: false,
      error: `Skill not found: ${skillName}`,
    });
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return Promise.resolve({
      success: false,
      error: `Failed to read skill file: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const { metadata: frontmatter, body } = parseMarkdownFrontmatter(content);

  // Parse depends_on: can be a comma-separated string or single name
  const dependencies = normalizeFrontmatterList(frontmatter['depends_on']);
  const includes = collectMarkdownReferences(body);

  return Promise.resolve({
    success: true,
    output: JSON.stringify({
      mode: 'dependencies',
      skillName,
      path: filePath,
      depends_on: dependencies,
      includes,
    }),
  });
}

function runPreview(
  input: RegistryInput,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const resolvedPath = resolveRegistryPath(input.path);
  if (!resolvedPath.ok) return Promise.resolve({ success: false, error: resolvedPath.error });

  try {
    const disclosure = readMarkdownDisclosure(resolvedPath.path);
    return Promise.resolve({
      success: true,
      output: JSON.stringify({
        mode: 'preview',
        path: disclosure.path,
        metadata: disclosure.metadata,
        preview: disclosure.preview,
        includes: disclosure.includes,
        sections: disclosure.sections,
        dependencies: normalizeFrontmatterList(disclosure.metadata['depends_on']),
      }),
    });
  } catch (err) {
    return Promise.resolve({
      success: false,
      error: `Failed to preview file: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function runContent(
  input: RegistryInput,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const resolvedPath = resolveRegistryPath(input.path);
  if (!resolvedPath.ok) return Promise.resolve({ success: false, error: resolvedPath.error });

  return Promise.resolve({
    success: true,
    output: JSON.stringify({
      mode: 'content',
      path: resolvedPath.path,
      metadata: readMarkdownDisclosure(resolvedPath.path).metadata,
      content: materializeMarkdownBody(resolvedPath.path),
    }),
  });
}

function resolveRegistryPath(path: string | undefined):
  | { ok: true; path: string }
  | { ok: false; error: string } {
  if (!path) {
    return {
      ok: false,
      error: 'mode requires "path"',
    };
  }

  const resolvedPath = isAbsolute(path)
    ? path
    : resolve(process.cwd(), path);

  if (!resolvedPath.includes('.goodvibes/')) {
    return {
      ok: false,
      error: 'mode can only read files within .goodvibes/ directories',
    };
  }

  if (!existsSync(resolvedPath)) {
    return {
      ok: false,
      error: `File not found: ${resolvedPath}`,
    };
  }

  return { ok: true, path: resolvedPath };
}
