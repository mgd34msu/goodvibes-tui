/**
 * Architecture check, run in CI via `bun run architecture:check`.
 *
 * Runtime dependency structure only:
 *   1. Import-cycle detection, Tarjan SCC over the src/ import graph
 *   2. Layer-boundary rules, codified allowed dependency directions
 *   3. Boundary rules that guard nothing (a layer that is not a src/ directory)
 *
 * The 800-line cap, the unused-export rule and the text-pattern rules (hex
 * literals, selectedIndex reads, internal identifiers, singletons, mkdtemp,
 * explicit any, mock.module, required snippets) were removed in the 2026-09
 * testing overhaul: they policed wording and style, not behavior. See
 * docs/testing-and-validation.md.
 *
 * ─── LAYER MAP ───────────────────────────────────────────────────────────────
 *
 * Layer 0  foundation   config, providers, types, utils, version, acp, adapters,
 *                       artifacts, audio, automation, bookmarks, channels,
 *                       discovery, export, git, hooks, integrations, intelligence,
 *                       knowledge, mcp, media, multimodal, permissions, plugins,
 *                       profiles, scheduler, scripts, security, sessions, shell,
 *                       state, templates, tools, verification, voice, watchers,
 *                       web-search, widget, work-plans, workflow, agents
 * Layer 1  domain       core
 * Layer 2  runtime      runtime  (bootstrap files are composition roots, they
 *                       legitimately import shell-UI to wire everything together)
 * Layer 3  shell-UI     input, renderer, views   (mutually coupled; form one UI layer)
 * Layer 4  entrypoint   cli, daemon
 *
 * Allowed cross-layer directions (↓ = lower may import higher in special cases;
 * ↑ = higher may import lower):
 *   - shell-UI layers (input/renderer/views) may import each other (same layer)
 *   - runtime/bootstrap files may import shell-UI (composition-root privilege)
 *   - All layers may import Layer 0 foundation
 *
 * Enforced FORBIDDEN directions (rules added only where zero HEAD violations exist):
 *   - renderer  → cli, daemon
 *   - input     → cli, daemon
 *   - views     → cli, daemon
 *   - config    → renderer, input, views, cli, daemon
 *   - providers → renderer, input, views, cli, daemon
 *   - channels  → renderer, input, views
 *   - audio     → renderer, input, views, cli
 *   - daemon    → renderer, input, views
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SRC_ROOT = join(ROOT, 'src');

function walk(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(abs));
      continue;
    }
    if (entry.isFile() && abs.endsWith('.ts')) {
      files.push(abs);
    }
  }
  return files;
}

function isTestSource(path: string): boolean {
  return path.includes('/src/test/') || path.endsWith('.test.ts') || path.includes('/__tests__/');
}

// ─── Import-graph utilities ───────────────────────────────────────────────────

/**
 * Regex matching bare relative import paths (static import/export/require).
 *
 * Coverage note: Only relative imports (beginning with ".") are resolved.
 * Path-alias imports (e.g. `@/runtime/index.ts`, `@pellux/…`) are NOT
 * followed, they are invisible to the cycle detector and layer-boundary
 * checker. In practice `@/`-routed imports are mostly `import type` (erased
 * at runtime) and the codebase uses them deliberately to break cycles (e.g.
 * `SystemMessageKind` is imported via `@/runtime/index.ts` to avoid a
 * circular chain through `system-message-router.ts`). This is a known
 * coverage gap; resolving aliases would require reading tsconfig paths.
 */
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*\s+from\s+)?['"](\.[^'"]+)['"]|(?:^|\n)\s*(?:const|let|var)\s+.*=\s*require\(['"](\.[^'"]+)['"]\)/g;

/**
 * Extract all relative import paths from a TypeScript source file.
 * Returns bare specifiers like "./foo" or "../bar/baz".
 */
function extractImports(text: string): string[] {
  const imports: string[] = [];
  const re = new RegExp(IMPORT_RE.source, IMPORT_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec) imports.push(spec);
  }
  return imports;
}

/**
 * Resolve a relative import specifier from a source file to an absolute path.
 * Tries .ts, /index.ts extensions. Returns null if unresolvable.
 */
function resolveImport(fromFile: string, spec: string): string | null {
  const base = dirname(fromFile);
  const target = resolve(base, spec);

  const candidates = [
    target,
    target + '.ts',
    join(target, 'index.ts'),
  ];

  for (const c of candidates) {
    if (existsSync(c) && !statSync(c).isDirectory()) {
      return c;
    }
  }
  return null;
}

/**
 * Build the full import graph for all non-test source files.
 * Returns a Map<absPath, Set<absPath>> of direct dependencies.
 */
function buildImportGraph(files: string[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const text = readFileSync(file, 'utf-8');
    const imports = extractImports(text);
    const deps = new Set<string>();
    for (const spec of imports) {
      const resolved = resolveImport(file, spec);
      // Add edge regardless of whether the target is in the non-test set;
      // targets outside the set have no outbound edges (graph.get returns
      // undefined → treated as a leaf), so they never form SCC cycles.
      if (resolved) deps.add(resolved);
    }
    graph.set(file, deps);
  }
  return graph;
}

/**
 * Tarjan's Strongly Connected Components, finds all cycles.
 * Returns arrays of SCCs with size > 1 (those are cycles).
 */
function findCycles(graph: Map<string, Set<string>>): string[][] {
  const nodes = Array.from(graph.keys());
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Map<string, boolean>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  function strongconnect(v: string): void {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.set(v, true);

    const neighbors = graph.get(v) ?? new Set<string>();
    for (const w of neighbors) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.get(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.set(w, false);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) {
        sccs.push(scc);
      }
    }
  }

  for (const node of nodes) {
    if (!index.has(node)) {
      strongconnect(node);
    }
  }

  return sccs;
}

/**
 * Format a cycle as a readable chain for violation output.
 * Shows the shortest path around the cycle starting from the lexicographically
 * first file for determinism.
 */
function formatCycleChain(cycle: string[], graph: Map<string, Set<string>>): string {
  const sorted = [...cycle].sort();
  const start = sorted[0]!;
  const cycleSet = new Set(cycle);

  // Walk the cycle from start to produce an ordered chain
  const chain: string[] = [start];
  let current = start;
  const visited = new Set<string>([start]);

  for (let i = 0; i < cycle.length; i++) {
    const neighbors = graph.get(current) ?? new Set<string>();
    let next: string | null = null;
    for (const n of neighbors) {
      if (cycleSet.has(n) && !visited.has(n)) {
        next = n;
        break;
      }
    }
    if (next === null) break;
    chain.push(next);
    visited.add(next);
    current = next;
  }

  // Close the loop
  chain.push(start);

  return chain.map((f) => relative(ROOT, f)).join(' → ');
}

// ─── Layer-boundary rule engine ───────────────────────────────────────────────

/**
 * Returns the top-level src/ subdirectory for an absolute file path.
 * e.g. "/…/src/renderer/foo.ts" → "renderer"
 * Returns null for files directly in src/ (like src/main.ts, src/cli-flags.ts).
 */
function srcLayer(absPath: string): string | null {
  const rel = relative(SRC_ROOT, absPath);
  const parts = rel.split('/');
  if (parts.length <= 1) return null; // top-level file
  return parts[0]!;
}

/**
 * A layer-boundary rule describes a set of "from" layers that must NOT import
 * from a set of "to" layers.
 */
type LayerBoundaryRule = {
  /** Short rule name, used in violation messages. */
  readonly name: string;
  /**
   * Rationale: why this boundary exists, becomes part of the violation message
   * so engineers know what to fix rather than just "you violated a rule".
   */
  readonly rationale: string;
  /** Layers that are the source of the forbidden import. */
  readonly fromLayers: ReadonlySet<string>;
  /** Layers that must not be imported by fromLayers. */
  readonly toLayers: ReadonlySet<string>;
  /**
   * Optional: specific files within fromLayers that are exempt.
   * These are composition roots that legitimately bridge layers.
   * Relative to project root (e.g. "src/runtime/bootstrap.ts").
   */
  readonly exemptFiles?: ReadonlySet<string>;
};

const LAYER_BOUNDARY_RULES: readonly LayerBoundaryRule[] = [
  {
    // Rationale: renderer produces terminal output; importing CLI argument parsing
    // or daemon process management would create a hard dependency on entrypoint
    // concerns that the UI layer must never own.
    name: 'renderer-no-entrypoints',
    rationale: 'renderer is a pure UI layer and must not depend on the CLI entrypoint',
    fromLayers: new Set(['renderer']),
    toLayers: new Set(['cli']),
  },
  {
    // Rationale: input handles keystrokes and user interactions; it must not pull in
    // CLI argument parsing or daemon lifecycle, those are entrypoint concerns.
    name: 'input-no-entrypoints',
    rationale: 'input is a pure event-handling layer and must not depend on the CLI entrypoint',
    fromLayers: new Set(['input']),
    toLayers: new Set(['cli']),
  },
  {
    // Rationale: views (modal content, read models and view wiring) are
    // reusable UI pieces; importing CLI or daemon would make them
    // entrypoint-specific and prevent reuse across surfaces.
    name: 'views-no-entrypoints',
    rationale: 'views are reusable UI pieces and must not depend on the CLI entrypoint',
    fromLayers: new Set(['views']),
    toLayers: new Set(['cli']),
  },
  {
    // Rationale: config is the lowest-level configuration layer used everywhere;
    // importing shell-UI would create an upward dependency that breaks layering
    // and prevents config from being used in headless/daemon contexts.
    name: 'config-no-shell-ui',
    rationale:
      'config is a foundational layer read in every context, headless included, and must not depend on shell-UI',
    fromLayers: new Set(['config']),
    toLayers: new Set(['renderer', 'input', 'views', 'cli']),
  },
  {
    // Rationale: providers supply LLM/API abstractions used by core and runtime;
    // importing shell-UI would make providers TUI-only and prevent headless use.
    name: 'providers-no-shell-ui',
    rationale:
      'providers are headless LLM abstractions and must not depend on shell-UI or entrypoints',
    fromLayers: new Set(['providers']),
    toLayers: new Set(['renderer', 'input', 'views', 'cli']),
  },
  {
    // Rationale: audio handles TTS and media playback; it is wired into the UI
    // via shell wiring files, not by importing shell-UI itself.
    name: 'audio-no-shell-ui',
    rationale: 'audio is a headless media layer and must not import shell-UI or CLI entrypoints',
    fromLayers: new Set(['audio']),
    toLayers: new Set(['renderer', 'input', 'views', 'cli']),
  },
];

/**
 * Check all layer-boundary rules against the import graph.
 * Returns violation strings ready to push into the global violations array.
 */
function checkLayerBoundaries(
  graph: Map<string, Set<string>>,
  rules: readonly LayerBoundaryRule[],
): string[] {
  const violations: string[] = [];

  for (const rule of rules) {
    for (const [fromFile, deps] of graph) {
      const fromLayer = srcLayer(fromFile);
      if (!fromLayer || !rule.fromLayers.has(fromLayer)) continue;

      const relFrom = relative(ROOT, fromFile);
      if (rule.exemptFiles?.has(relFrom)) continue;

      for (const toFile of deps) {
        const toLayer = srcLayer(toFile);
        if (!toLayer || !rule.toLayers.has(toLayer)) continue;

        const relTo = relative(ROOT, toFile);
        violations.push(
          `[${rule.name}] ${relFrom} → ${relTo}: ${rule.rationale}`,
        );
      }
    }
  }

  return violations;
}

// ─── Main analysis ────────────────────────────────────────────────────────────

const startMs = Date.now();
const nonTestFiles = walk(SRC_ROOT).filter((file) => !isTestSource(file));
const violations: string[] = [];

// ─── Cycle detection ──────────────────────────────────────────────────────────

const graph = buildImportGraph(nonTestFiles);
const cycles = findCycles(graph);

for (const cycle of cycles) {
  const chain = formatCycleChain(cycle, graph);
  violations.push(`[import-cycle] ${cycle.length}-file cycle: ${chain}`);
}

// ─── Layer-boundary enforcement ───────────────────────────────────────────────

const layerViolations = checkLayerBoundaries(graph, LAYER_BOUNDARY_RULES);
for (const v of layerViolations) {
  violations.push(v);
}

// ─── Rules that guard nothing ─────────────────────────────────────────────────

// A layer is a top-level src/ directory. A boundary rule naming one that is not
// there matches nothing, the same vacuous-pass class as a missing rule target,
// reached through the other half of the engine.
const liveLayers = new Set(
  readdirSync(SRC_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
);
for (const rule of LAYER_BOUNDARY_RULES) {
  for (const layer of [...rule.fromLayers, ...rule.toLayers]) {
    if (!liveLayers.has(layer)) {
      violations.push(
        `[${rule.name}] names the layer "${layer}", which is not a directory under src/;`
        + ' the rule matches nothing; remove the layer (and the rule, if nothing live is left)',
      );
    }
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────

const elapsedMs = Date.now() - startMs;

if (violations.length > 0) {
  console.error('Architecture check failed:\n');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(
  `Architecture check passed for ${nonTestFiles.length} non-test source files.` +
  ` (${cycles.length} cycles checked, ${LAYER_BOUNDARY_RULES.length} boundary rules active,` +
  ` ${Math.round(elapsedMs / 1000)}s)`,
);
