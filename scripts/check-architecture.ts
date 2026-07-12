/**
 * Architecture Check — static analysis gate run in CI via `bun run architecture:check`.
 *
 * What this checks:
 *   1. Source-file line-count gate (non-test files ≤ 800 lines)
 *   2. Pattern-based rules (no singletons, no ambient globals, etc.)
 *   3. Explicit-any detection (via TypeScript compiler API)
 *   4. Test discipline (no mock.module())
 *   5. Required-snippet presence (foundation artifacts)
 *   6. SDK contract catalog invariants
 *   7. **Import-cycle detection** — Tarjan SCC over the src/ import graph
 *   8. **Layer-boundary rules** — codified allowed dependency directions
 *   9. **Hex-literal ratchet** — bans raw #RRGGBB literals in
 *      src/panels/**\/*.ts and src/renderer/**\/*.ts except ui-primitives.ts,
 *      theme.ts and syntax-highlighter.ts; a seeded baseline
 *      (scripts/hex-literal-baseline.json) may only shrink, never grow
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
 * Layer 2  runtime      runtime  (bootstrap files are composition roots — they
 *                       legitimately import shell-UI to wire everything together)
 * Layer 3  shell-UI     input, renderer, panels  (mutually coupled; form one UI layer)
 * Layer 4  entrypoint   cli, daemon
 *
 * Allowed cross-layer directions (↓ = lower may import higher in special cases;
 * ↑ = higher may import lower):
 *   - shell-UI layers (input/renderer/panels) may import each other (same layer)
 *   - runtime/bootstrap files may import shell-UI (composition-root privilege)
 *   - All layers may import Layer 0 foundation
 *
 * Enforced FORBIDDEN directions (rules added only where zero HEAD violations exist):
 *   - renderer  → cli, daemon
 *   - input     → cli, daemon
 *   - panels    → cli, daemon
 *   - config    → renderer, input, panels, cli, daemon
 *   - providers → renderer, input, panels, cli, daemon
 *   - channels  → renderer, input, panels
 *   - audio     → renderer, input, panels, cli
 *   - daemon    → renderer, input, panels
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { checkHexLiteralRatchet } from './hex-literal-rule.ts';
import { checkNoUnusedExports } from './no-unused-exports-rule.ts';
import { checkSelectedIndexReads } from './selected-index-rule.ts';
import { checkNoInternalIdentifiers } from './internal-identifier-rule.ts';

const ROOT = join(import.meta.dir, '..');
const SRC_ROOT = join(ROOT, 'src');
const SCRIPTS_ROOT = join(ROOT, 'scripts');
const MAX_SOURCE_LINES = 800;

type Rule = {
  readonly name: string;
  readonly files: readonly string[];
  readonly pattern: RegExp;
  readonly allow?: readonly string[];
  readonly message: string;
};

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

function expandTargets(targets: readonly string[]): string[] {
  return targets.flatMap((target) => {
    const abs = join(ROOT, target);
    if (!existsSync(abs)) {
      return [];
    }
    const stats = statSync(abs);
    if (stats.isDirectory()) {
      return walk(abs).filter((file) => !isTestSource(file));
    }
    return [abs];
  });
}

function isGenericObjectSchema(schema: Record<string, unknown> | undefined): boolean {
  return Boolean(schema && schema.type === 'object' && !Object.hasOwn(schema, 'properties'));
}

// ─── Import-graph utilities ───────────────────────────────────────────────────

/**
 * Regex matching bare relative import paths (static import/export/require).
 *
 * Coverage note: Only relative imports (beginning with ".") are resolved.
 * Path-alias imports (e.g. `@/runtime/index.ts`, `@pellux/…`) are NOT
 * followed — they are invisible to the cycle detector and layer-boundary
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
 * Tarjan's Strongly Connected Components — finds all cycles.
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
   * Rationale: why this boundary exists — becomes part of the violation message
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
    rationale: 'renderer is a pure UI layer and must not depend on CLI/daemon entrypoints',
    fromLayers: new Set(['renderer']),
    toLayers: new Set(['cli', 'daemon']),
  },
  {
    // Rationale: input handles keystrokes and user interactions; it must not pull in
    // CLI argument parsing or daemon lifecycle — those are entrypoint concerns.
    name: 'input-no-entrypoints',
    rationale: 'input is a pure event-handling layer and must not depend on CLI/daemon entrypoints',
    fromLayers: new Set(['input']),
    toLayers: new Set(['cli', 'daemon']),
  },
  {
    // Rationale: panels are reusable UI widgets; importing CLI or daemon would
    // make them entrypoint-specific and prevent reuse across surfaces.
    name: 'panels-no-entrypoints',
    rationale: 'panels are reusable UI widgets and must not depend on CLI/daemon entrypoints',
    fromLayers: new Set(['panels']),
    toLayers: new Set(['cli', 'daemon']),
  },
  {
    // Rationale: config is the lowest-level configuration layer used everywhere;
    // importing shell-UI would create an upward dependency that breaks layering
    // and prevents config from being used in headless/daemon contexts.
    name: 'config-no-shell-ui',
    rationale:
      'config is a foundational layer used in all contexts (TUI, daemon, SDK) and must not depend on shell-UI',
    fromLayers: new Set(['config']),
    toLayers: new Set(['renderer', 'input', 'panels', 'cli', 'daemon']),
  },
  {
    // Rationale: providers supply LLM/API abstractions used by core and runtime;
    // importing shell-UI would make providers TUI-only and prevent headless use.
    name: 'providers-no-shell-ui',
    rationale:
      'providers are headless LLM abstractions and must not depend on shell-UI or entrypoints',
    fromLayers: new Set(['providers']),
    toLayers: new Set(['renderer', 'input', 'panels', 'cli', 'daemon']),
  },
  {
    // Rationale: channels are the async event-delivery layer used by runtime and
    // daemon; they must not import shell-UI to remain usable without a TUI.
    name: 'channels-no-shell-ui',
    rationale: 'channels are headless event delivery and must not depend on shell-UI layers',
    fromLayers: new Set(['channels']),
    toLayers: new Set(['renderer', 'input', 'panels']),
  },
  {
    // Rationale: audio handles TTS and media playback; it is wired into the UI
    // via shell wiring files, not by importing shell-UI itself.
    name: 'audio-no-shell-ui',
    rationale: 'audio is a headless media layer and must not import shell-UI or CLI entrypoints',
    fromLayers: new Set(['audio']),
    toLayers: new Set(['renderer', 'input', 'panels', 'cli']),
  },
  {
    // Rationale: daemon manages the background process and serves HTTP; importing
    // shell-UI would make the daemon depend on Ink/TUI rendering, which is
    // incompatible with headless daemon operation.
    name: 'daemon-no-shell-ui',
    rationale:
      'daemon is a headless background process and must not import TUI shell-UI layers',
    fromLayers: new Set(['daemon']),
    toLayers: new Set(['renderer', 'input', 'panels']),
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

const allSourceFiles = walk(SRC_ROOT);
const scriptFiles = walk(SCRIPTS_ROOT);
const nonTestFiles = allSourceFiles.filter((file) => !isTestSource(file));
const testFiles = allSourceFiles.filter((file) => isTestSource(file));
const explicitAnyFiles = [...allSourceFiles, ...scriptFiles];
const violations: string[] = [];

const startMs = Date.now();

for (const file of nonTestFiles) {
  const text = readFileSync(file, 'utf-8');
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lineCount = normalized.length === 0 ? 0 : normalized.split('\n').length;
  if (lineCount > MAX_SOURCE_LINES) {
    violations.push(`${relative(ROOT, file)}: exceeds ${MAX_SOURCE_LINES} lines (${lineCount})`);
  }
}

const rules: readonly Rule[] = [
  {
    name: 'no-runtime-globals',
    files: nonTestFiles,
    pattern: /__goodvibesRuntime(Store|Dispatch)/,
    message: 'runtime store/dispatch globals are forbidden; use RuntimeServices ownership instead',
  },
  {
    name: 'no-ambient-integration-helper-usage',
    files: nonTestFiles,
    pattern: /\b(setIntegrationHelpersContext|clearIntegrationHelpersContext|getIntegrationHelpersContextOptional|getLegacyIntegrationHelperService)\b/,
    allow: ['src/runtime/integration/helpers.ts'],
    message: 'ambient integration-helper access is forbidden outside the helper module',
  },
  {
    name: 'no-legacy-runtime-singletons',
    files: nonTestFiles,
    pattern: /\b(getPolicyRuntimeState|getMemoryRegistry|getMemoryStore|getSubscriptionManager|getLocalUserAuthManager|getRemoteRunnerRegistry|getDistributedRuntimeManagerForTesting|resetDistributedRuntimeManagerForTesting|_setKnowledgeRegistryForTesting|_resetMemoryRegistryForTesting|FeatureFlagManager\.getInstance|getSecretsManager)\b/,
    allow: ['src/config/secrets.ts'],
    message: 'legacy singleton/service-locator access is forbidden; use explicit RuntimeServices ownership or explicit instances',
  },
  {
    name: 'no-ambient-tool-singletons',
    files: nonTestFiles,
    pattern: /\b(fetchTool|findTool|execTool)\b/,
    message: 'ambient tool singletons are forbidden; construct tool instances explicitly',
  },
  {
    name: 'no-singleton-core-lookups-in-adapters',
    files: expandTargets([
      'src/daemon',
      'src/control-plane/routes',
      'src/runtime/bootstrap.ts',
      'src/runtime/bootstrap-services.ts',
      'src/daemon/cli.ts',
      'src/daemon/control-plane.ts',
    ]),
    pattern: /\b(AutomationManager|SharedSessionBroker|ApprovalBroker|RouteBindingManager|SurfaceRegistry|WatcherRegistry|ChannelPolicyManager)\.getInstance\(|\bgetDistributedRuntimeManager\(/,
    message: 'adapter/composition code must use explicit RuntimeServices ownership instead of singleton lookups',
  },
  {
    name: 'no-service-active-lookups-in-adapters',
    files: expandTargets([
      'src/daemon',
      'src/control-plane/routes',
      'src/channels/delivery',
    ]),
    pattern: /\b(ArtifactStore|KnowledgeService|VoiceService|WebSearchService|MediaProviderRegistry|MultimodalService|GatewayMethodCatalog|ControlPlaneGateway)\.getActive\(/,
    message: 'adapter-layer code must receive app-owned services instead of pulling active instances',
  },
  {
    name: 'no-singleton-lookups-in-shell-bridges',
    files: expandTargets([
      'src/main.ts',
      'src/runtime/bootstrap-command-context.ts',
      'src/runtime/bootstrap-runtime-events.ts',
      'src/panels/control-plane-panel.ts',
      'src/channels/builtin-runtime.ts',
      'src/channels/builtin/rendering.ts',
    ]),
    pattern: /\b(AutomationManager|SharedSessionBroker|ApprovalBroker|AgentManager|ModeManager|ChannelPolicyManager|FileUndoManager)\.getInstance\(|\bChannelDeliveryRouter\.getActive\(/,
    message: 'shell adapters and builtin channel bridges must receive explicit app-owned dependencies',
  },
  {
    name: 'future-foundation-surfaces-no-server-or-shell-imports',
    files: expandTargets([
      'src/runtime/operator-client.ts',
      'src/runtime/peer-client.ts',
      'src/runtime/transports',
      'src/runtime/runtime-provider-api.ts',
      'src/runtime/runtime-knowledge-api.ts',
      'src/runtime/runtime-hook-api.ts',
      'src/runtime/runtime-mcp-api.ts',
      'src/providers/provider-api.ts',
      'src/knowledge/knowledge-api.ts',
      'src/hooks/hook-api.ts',
      'src/mcp/mcp-api.ts',
    ]),
    pattern: /from ['"][.\/]+(?:\.\.\/)*(?:daemon|input|panels|renderer)(?:\/|\.ts['"])/,
    message: 'future foundation/client surfaces must not depend on daemon or shell modules',
  },
  {
    name: 'future-server-surfaces-no-shell-imports',
    files: expandTargets([
      'src/daemon',
      'src/control-plane/routes',
    ]),
    pattern: /from ['"][.\/]+(?:\.\.\/)*(?:input|panels|renderer)(?:\/|\.ts['"])/,
    message: 'future server surfaces must not depend on TUI shell modules',
  },
  {
    name: 'no-raw-generic-object-contract-schemas',
    files: expandTargets([
      'src/control-plane/operator-contract-schemas-admin.ts',
      'src/control-plane/operator-contract-schemas-channels.ts',
      'src/control-plane/operator-contract-schemas-knowledge.ts',
      'src/control-plane/operator-contract-schemas-media.ts',
      'src/control-plane/operator-contract-schemas-permissions.ts',
      'src/control-plane/operator-contract-schemas-remote.ts',
      'src/control-plane/operator-contract-schemas.ts',
      'src/control-plane/media-contract-schemas.ts',
      'src/control-plane/operator-contract.ts',
    ]),
    pattern: /\bJSON_OBJECT_SCHEMA\b/,
    message: 'contract schema modules must use explicit DTO schemas or named typed JSON record/document schemas instead of raw JSON_OBJECT_SCHEMA',
  },
  {
    name: 'no-implicit-project-root-literals',
    files: nonTestFiles,
    allow: [
      'src/main.ts',
      'src/daemon/cli.ts',
      'src/runtime/worktree/registry.ts',
    ],
    pattern: /join\(\s*['"]\.goodvibes['"]|join\(\s*['"]\.['"]\s*,\s*['"]\.goodvibes['"]|workspaceRoot:\s*['"]\.['"]/,
    message: 'reusable code must not hide project-root ownership behind relative .goodvibes paths or "." workspace roots; inject explicit owned roots instead',
  },
  {
    name: 'no-ambient-root-discovery-in-reusable-code',
    files: nonTestFiles,
    allow: [
      'src/main.ts',
      'src/daemon/cli.ts',
    ],
    pattern: /\bprocess\.cwd\(\)|\bhomedir\(\)/,
    message: 'reusable code must not discover cwd/home implicitly; composition roots must pass owned roots explicitly',
  },
];

for (const rule of rules) {
  for (const file of rule.files) {
    const rel = relative(ROOT, file);
    if (rule.allow?.includes(rel)) continue;
    const text = readFileSync(file, 'utf-8');
    if (rule.pattern.test(text)) {
      violations.push(`${rel}: ${rule.message} [${rule.name}]`);
    }
  }
}

// ─── Hex-literal ratchet ──────────────────────────────────────────────────

const hexLiteralBaseline: Record<string, number> = JSON.parse(
  readFileSync(join(ROOT, 'scripts/hex-literal-baseline.json'), 'utf-8'),
);
const hexLiteralCandidates = nonTestFiles
  .filter((file) => {
    const rel = relative(ROOT, file);
    return rel.startsWith('src/panels/') || rel.startsWith('src/renderer/');
  })
  .map((file) => ({ relPath: relative(ROOT, file), text: readFileSync(file, 'utf-8') }));
for (const v of checkHexLiteralRatchet(hexLiteralCandidates, hexLiteralBaseline)) {
  violations.push(v);
}

// ─── Selected-index selection-safety ban ───────────────────────────────────────

const selectedIndexCandidates = nonTestFiles
  .filter((file) => relative(ROOT, file).split('\\').join('/').startsWith('src/panels/'))
  .map((file) => ({ relPath: relative(ROOT, file), text: readFileSync(file, 'utf-8') }));
for (const v of checkSelectedIndexReads(selectedIndexCandidates)) {
  violations.push(v);
}

// ─── No-unused-exports ────────────────────────────────────────────────

const noUnusedExportsTargets = nonTestFiles
  .filter((file) => relative(ROOT, file).split('\\').join('/').startsWith('src/renderer/'))
  .map((file) => ({ relPath: relative(ROOT, file), text: readFileSync(file, 'utf-8') }));
const noUnusedExportsImporters = [...allSourceFiles, ...scriptFiles].map((file) => ({
  relPath: relative(ROOT, file),
  text: readFileSync(file, 'utf-8'),
  isTest: isTestSource(file),
}));
const resolveSpecifierRelative = (fromRelPath: string, specifier: string): string | null => {
  const resolved = resolveImport(join(ROOT, fromRelPath), specifier);
  return resolved ? relative(ROOT, resolved) : null;
};
for (const v of checkNoUnusedExports(noUnusedExportsTargets, noUnusedExportsImporters, resolveSpecifierRelative)) {
  violations.push(v);
}

for (const file of explicitAnyFiles) {
  const text = readFileSync(file, 'utf-8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const rel = relative(ROOT, file);
  const seenPositions = new Set<number>();

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const start = node.getStart(source);
      if (!seenPositions.has(start)) {
        seenPositions.add(start);
        const { line, character } = source.getLineAndCharacterOfPosition(start);
        violations.push(`${rel}:${line + 1}:${character + 1}: explicit any is forbidden`);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
}

for (const file of testFiles) {
  const text = readFileSync(file, 'utf-8');
  if (text.includes('mock.module(')) {
    violations.push(`${relative(ROOT, file)}: process-global mock.module() is forbidden in tests; use explicit dependency injection or local spies instead`);
  }
}

const requiredSnippets: Array<{ file: string; snippets: readonly string[]; message: string }> = [
  {
    file: 'scripts/project-surfaces.ts',
    snippets: [
      'GatewayMethodCatalog',
      '@pellux/goodvibes-sdk/platform/control-plane',
    ],
    message: 'foundation artifacts must be generated from SDK control-plane surfaces',
  },
];

for (const requirement of requiredSnippets) {
  const file = join(ROOT, requirement.file);
  const text = readFileSync(file, 'utf-8');
  if (!requirement.snippets.some((snippet) => text.includes(snippet))) {
    violations.push(`${requirement.file}: ${requirement.message}`);
  }
}

const { GatewayMethodCatalog } = await import('@pellux/goodvibes-sdk/platform/control-plane');
const catalog = new GatewayMethodCatalog();
const methodIds = new Set(catalog.list().map((method) => method.id));
if (!methodIds.has('control.contract')) {
  violations.push('operator-contract: control.contract must stay cataloged');
}
if (!methodIds.has('remote.node_host.contract')) {
  violations.push('operator-contract: remote.node_host.contract must stay cataloged');
}
for (const method of catalog.list()) {
  if (isGenericObjectSchema(method.inputSchema)) {
    violations.push(`operator-contract: ${method.id} still exposes a generic object input schema`);
  }
  if (isGenericObjectSchema(method.outputSchema)) {
    violations.push(`operator-contract: ${method.id} still exposes a generic object output schema`);
  }
}

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

// ─── No internal planning identifiers ─────────────────────────────────────────

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdown(abs));
      continue;
    }
    if (entry.isFile() && abs.endsWith('.md')) {
      files.push(abs);
    }
  }
  return files;
}

const internalIdentifierCandidates = [
  ...allSourceFiles,
  ...scriptFiles,
  ...walkMarkdown(join(ROOT, 'docs')),
  ...(existsSync(join(ROOT, 'action.yml')) ? [join(ROOT, 'action.yml')] : []),
].map((file) => ({ relPath: relative(ROOT, file).split('\\').join('/'), text: readFileSync(file, 'utf-8') }));

for (const v of checkNoInternalIdentifiers(internalIdentifierCandidates)) {
  violations.push(v);
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
