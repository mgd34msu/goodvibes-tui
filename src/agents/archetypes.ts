import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// AgentArchetype type
// ---------------------------------------------------------------------------

/** A named agent archetype loaded from a .goodvibes/agents/*.md file
 *  or from built-in templates. */
export interface AgentArchetype {
  /** Archetype identifier (filename without extension, or template key). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Tool names the agent has access to. */
  tools: string[];
  /** Model override (optional). */
  model?: string;
  /** Provider override (optional). */
  provider?: string;
  /** System prompt injected at agent start (optional). */
  systemPrompt?: string;
  /** True if loaded from a markdown file, false if built-in. */
  isCustom: boolean;
  /** Where this archetype came from. */
  origin: 'builtin' | 'local-markdown';
  /** Source path when loaded from a markdown file. */
  sourcePath?: string;
  /** Validation or schema issues discovered while loading. */
  validationIssues?: readonly string[];
}

// ---------------------------------------------------------------------------
// Built-in fallback templates
// Mirrors the AGENT_TEMPLATES in src/tools/agent/index.ts so that
// archetypes.ts has no circular dependency on the tool module.
// ---------------------------------------------------------------------------

const BUILT_IN_ARCHETYPES: AgentArchetype[] = [
  {
    name: 'engineer',
    description: 'Full-stack implementation agent',
    tools: ['read', 'write', 'edit', 'find', 'exec', 'analyze', 'inspect', 'fetch', 'registry'],
    isCustom: false,
    origin: 'builtin',
  },
  {
    name: 'reviewer',
    description: 'Code review and quality assessment',
    tools: ['read', 'find', 'analyze', 'inspect', 'fetch', 'registry'],
    isCustom: false,
    origin: 'builtin',
  },
  {
    name: 'tester',
    description: 'Test writing and execution',
    tools: ['read', 'write', 'find', 'exec', 'analyze', 'inspect'],
    isCustom: false,
    origin: 'builtin',
  },
  {
    name: 'researcher',
    description: 'Codebase exploration and analysis',
    tools: ['read', 'find', 'analyze', 'inspect', 'fetch', 'registry'],
    isCustom: false,
    origin: 'builtin',
  },
  {
    name: 'general',
    description: 'General purpose agent',
    tools: ['read', 'write', 'edit', 'find', 'exec', 'analyze', 'inspect', 'fetch', 'registry'],
    isCustom: false,
    origin: 'builtin',
  },
];

// ---------------------------------------------------------------------------
// Minimal YAML frontmatter parser
// Supports the subset used in agent markdown files:
//   key: value
//   tools: [read, write, edit]
//   tools:
//     - read
//     - write
// ---------------------------------------------------------------------------

interface RawFrontmatter {
  name?: string;
  description?: string;
  tools?: string[];
  model?: string;
  provider?: string;
  system_prompt?: string;
}

function parseSimpleYaml(yaml: string): RawFrontmatter {
  const result: RawFrontmatter = {};
  const lines = yaml.split('\n');
  let i = 0;
  let currentKey: string | null = null;
  let collectingList = false;
  const listBuffer: string[] = [];

  const flushList = () => {
    if (currentKey && collectingList) {
      (result as Record<string, unknown>)[currentKey] = listBuffer.slice();
    }
    collectingList = false;
    listBuffer.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];
    i++;

    // Skip comments and blank lines
    if (!line.trim() || line.trim().startsWith('#')) {
      if (collectingList) flushList();
      continue;
    }

    // List item under current key
    const listItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (listItemMatch && collectingList) {
      listBuffer.push(listItemMatch[1].trim());
      continue;
    }

    // Key: value line
    const kvMatch = line.match(/^([\w_]+):\s*(.*)$/);
    if (kvMatch) {
      // Flush any pending list
      if (collectingList) flushList();

      currentKey = kvMatch[1];
      const rawValue = kvMatch[2].trim();

      if (!rawValue) {
        // Value will be on following list lines
        collectingList = true;
        continue;
      }

      // Inline list: [a, b, c]
      const inlineListMatch = rawValue.match(/^\[(.*)\]$/);
      if (inlineListMatch) {
        (result as Record<string, unknown>)[currentKey] = inlineListMatch[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        continue;
      }

      // Multi-line string with | (just take first line for simple values)
      const stripped = rawValue.replace(/^['"]|['"]$/g, '');
      (result as Record<string, unknown>)[currentKey] = stripped;
    }
  }

  // Flush any trailing list
  if (collectingList) flushList();

  return result;
}

/** Extract `--- frontmatter ---` + body from markdown text.
 *  Returns null if no frontmatter block is present. */
function extractFrontmatter(content: string): { raw: string; body: string } | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) return null;

  const secondDash = trimmed.indexOf('\n---', 3);
  if (secondDash === -1) return null;

  const raw = trimmed.slice(3, secondDash).trim();
  const body = trimmed.slice(secondDash + 4).trimStart();
  return { raw, body };
}

function validateArchetype(archetype: Omit<AgentArchetype, 'validationIssues'>): string[] {
  const issues: string[] = [];
  if (!archetype.name.trim()) issues.push('missing name');
  if (!archetype.description.trim()) issues.push('missing description');
  if (archetype.tools.length === 0) issues.push('no tools declared');
  const uniqueTools = new Set(archetype.tools.map((tool) => tool.trim()).filter(Boolean));
  if (uniqueTools.size !== archetype.tools.length) issues.push('duplicate or empty tool declarations');
  return issues;
}

// ---------------------------------------------------------------------------
// ArchetypeLoader
// ---------------------------------------------------------------------------

/** Loads and caches agent archetypes from .goodvibes/agents/*.md files.
 *
 * Progressive loading:
 *  - `listArchetypes()` returns all known archetypes (frontmatter only);
 *    full body (system_prompt) is populated on first call to `loadArchetype()`.
 *  - Falls back to built-in templates when no .md file is found.
 */
export class ArchetypeLoader {
  private static instance: ArchetypeLoader | null = null;

  /** Map from archetype name -> AgentArchetype (may be partially loaded) */
  private cache = new Map<string, AgentArchetype>();
  /** Map from archetype name -> raw markdown body (lazy) */
  private bodyCache = new Map<string, string>();
  /** Whether the directory scan has been run */
  private scanned = false;
  /** Directory to scan for .md files */
  private dir: string;

  constructor(dir?: string) {
    // Default: .goodvibes/agents/ relative to process.cwd()
    this.dir = dir ?? join(process.cwd(), '.goodvibes', 'agents');
  }

  /** Singleton accessor. */
  static getInstance(): ArchetypeLoader {
    if (!ArchetypeLoader.instance) {
      ArchetypeLoader.instance = new ArchetypeLoader();
    }
    return ArchetypeLoader.instance;
  }

  /** Reset the singleton — for testing only. */
  static resetInstance(): void {
    ArchetypeLoader.instance = null;
  }

  // -------------------------------------------------------------------------
  // Scanning
  // -------------------------------------------------------------------------

  /** Scan the agents directory and populate cache with frontmatter-only entries.
 *  Called automatically on first access. */
  private scan(): void {
    if (this.scanned) return;
    this.scanned = true;

    // Seed with built-ins first so they act as fallbacks
    for (const builtin of BUILT_IN_ARCHETYPES) {
      this.cache.set(builtin.name, { ...builtin });
    }

    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.md'));
    } catch {
      // Directory doesn't exist — built-ins are the only archetypes
      logger.debug('ArchetypeLoader: agents dir not found, using built-ins', { dir: this.dir });
      return;
    }

    for (const file of files) {
      try {
        const filePath = join(this.dir, file);
        const content = readFileSync(filePath, 'utf-8');
        const parsed = extractFrontmatter(content);
        if (!parsed) continue;

        const fm = parseSimpleYaml(parsed.raw);
        const name = fm.name ?? file.replace(/\.md$/, '');

        const archetype: AgentArchetype = {
          name,
          description: fm.description ?? '',
          tools: fm.tools ?? [],
          model: fm.model,
          provider: fm.provider,
          // systemPrompt intentionally omitted here — lazy loaded
          isCustom: true,
          origin: 'local-markdown',
          sourcePath: filePath,
        };

        // Store body for lazy loading
        if (fm.system_prompt) {
          // If system_prompt is inline in frontmatter, set it directly
          archetype.systemPrompt = fm.system_prompt;
        } else {
          // Otherwise, the markdown body is the system prompt
          this.bodyCache.set(name, parsed.body);
        }

        archetype.validationIssues = validateArchetype(archetype);

        this.cache.set(name, archetype);
      } catch (err) {
        logger.error('ArchetypeLoader: failed to parse agent file', {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Load a named archetype with full content (including system prompt).
   *  Returns null if not found in files or built-ins. */
  loadArchetype(name: string): AgentArchetype | null {
    this.scan();

    const archetype = this.cache.get(name);
    if (!archetype) return null;

    // Lazy-load body as system prompt if not yet resolved
    if (!archetype.systemPrompt && this.bodyCache.has(name)) {
      archetype.systemPrompt = this.bodyCache.get(name);
      this.bodyCache.delete(name);
    }

    return { ...archetype };
  }

  /** List all known archetypes (frontmatter only, no body loading). */
  listArchetypes(): AgentArchetype[] {
    this.scan();
    return Array.from(this.cache.values()).map((a) => ({ ...a }));
  }

  /** Merge archetype config with runtime overrides.
   *  Override properties take precedence over archetype defaults.
   *  Returns null if the named archetype is not found. */
  mergeWithOverrides(
    name: string,
    overrides: {
      model?: string;
      provider?: string;
      tools?: string[];
    },
  ): AgentArchetype | null {
    const archetype = this.loadArchetype(name);
    if (!archetype) return null;

    return {
      ...archetype,
      model: overrides.model ?? archetype.model,
      provider: overrides.provider ?? archetype.provider,
      tools: overrides.tools ?? archetype.tools,
    };
  }

  /** Clear all cached archetypes and force re-scan on next access.
   *  Primarily for testing. */
  clear(): void {
    this.cache.clear();
    this.bodyCache.clear();
    this.scanned = false;
  }
}
