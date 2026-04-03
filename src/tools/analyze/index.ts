import { resolve, relative, join, dirname } from 'node:path';
import { stat } from 'node:fs/promises';
import { walkDir } from '../../utils/walk-dir.ts';
import { existsSync } from 'node:fs';
import type { Tool } from '../../types/tools.ts';
import { analyzeSchema } from './schema.ts';
import { CodeIntelligence } from '../../intelligence/facade.ts';
import { GitService } from '../../git/service.ts';
import { toolLLM } from '../../config/tool-llm.ts';
import { appendSchemaFingerprint } from '../shared/schema-fingerprint.ts';
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnalyzeInput {
  mode:
    | 'impact'
    | 'dependencies'
    | 'dead_code'
    | 'security'
    | 'coverage'
    | 'bundle'
    | 'preview'
    | 'diff'
    | 'surface'
    | 'breaking'
    | 'semantic_diff'
    | 'upgrade'
    | 'permissions'
    | 'env_audit'
    | 'test_find';
  files?: string[];
  projectRoot?: string;
  changes?: string;
  submode?: 'analyze' | 'circular' | 'upgrade';
  securityScope?: 'secrets' | 'permissions' | 'env' | 'all';
  before?: string;
  after?: string;
  find?: string;
  replace?: string;
  include?: string[];
  packages?: string[];
  output?: {
    format?: 'summary' | 'detailed' | 'json';
    max_tokens?: number;
  };
}

const BINARY_CHECK_BYTES = 8192;
const MAX_SCAN_FILES = 500;
const MAX_SCAN_MS = 5000;

async function isBinary(filePath: string): Promise<boolean> {
  try {
    const file = Bun.file(filePath);
    if (file.size === 0) return false;
    const chunk = await file.slice(0, BINARY_CHECK_BYTES).arrayBuffer();
    const bytes = new Uint8Array(chunk);
    for (const byte of bytes) {
      if (byte === 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

async function collectTextFiles(
  dirPath: string,
  limit = MAX_SCAN_FILES,
  deadline?: number,
): Promise<string[]> {
  const files: string[] = [];
  for await (const filePath of walkDir(dirPath)) {
    if (files.length >= limit) break;
    if (deadline && Date.now() > deadline) break;
    if (!(await isBinary(filePath))) {
      files.push(filePath);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validatePath(inputPath: string, root: string): string | { error: string } {
  try {
    // Local path validation: resolves against the provided root with traversal protection;
    // fall back to manual resolution if the input is absolute or root differs.
    const resolved = resolve(root, inputPath);
    const rel = relative(root, resolved);
    if (rel.startsWith('..') || rel.includes('/..')) {
      return { error: `Path '${inputPath}' is outside the project root` };
    }
    return resolved;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Mode: impact
// ---------------------------------------------------------------------------

async function runImpact(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const targetFiles = input.files ?? [];
  if (targetFiles.length === 0) {
    return { error: 'impact mode requires at least one file in files[]' };
  }

  const deadline = Date.now() + MAX_SCAN_MS;
  const intelligence = CodeIntelligence.getInstance();

  // Collect export names from target files
  const exportedNames: Array<{ name: string; file: string; line: number }> = [];

  for (const rawFile of targetFiles) {
    const resolved = validatePath(rawFile, projectRoot);
    if (typeof resolved === 'object') continue;

    let content: string;
    try {
      content = await Bun.file(resolved).text();
    } catch {
      continue;
    }

    // Try CodeIntelligence first
    const symbols = await intelligence.getSymbols(resolved, content);
    if (symbols.length > 0) {
      for (const sym of symbols) {
        if (sym.exported) {
          exportedNames.push({ name: sym.name, file: resolved, line: sym.line ?? 0 });
        }
      }
    } else {
      // Fallback: regex export scan
      const lines = content.split('\n');
      const exportRegex = /^export\s+(?:(?:async\s+)?function|class|const|let|var|type|interface|enum)\s+(\w+)/;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].trimStart().match(exportRegex);
        if (m?.[1]) {
          exportedNames.push({ name: m[1], file: resolved, line: i + 1 });
        }
      }
    }
  }

  if (exportedNames.length === 0) {
    return { affected_files: [], exported_names: [], message: 'No exported symbols found in target files' };
  }

  // Search for references across the project
  const allProjectFiles = await collectTextFiles(projectRoot, MAX_SCAN_FILES, deadline);
  const targetSet = new Set(targetFiles.map((f) => resolve(projectRoot, f)));

  const affected = new Map<string, Array<{ name: string; line: number }>>(); // file -> hits

  for (const file of allProjectFiles) {
    if (targetSet.has(file)) continue; // skip self
    if (Date.now() > deadline) break;

    let content: string;
    try {
      content = await Bun.file(file).text();
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (const exported of exportedNames) {
      // Word-boundary check
      const nameRegex = new RegExp(`\\b${escapeRegex(exported.name)}\\b`);
      for (let i = 0; i < lines.length; i++) {
        if (nameRegex.test(lines[i])) {
          const entry = affected.get(file) ?? [];
          entry.push({ name: exported.name, line: i + 1 });
          affected.set(file, entry);
          break; // one hit per export per file is sufficient
        }
      }
    }
  }

  return {
    exported_names: exportedNames.map((e) => e.name),
    affected_files: Array.from(affected.entries()).map(([file, hits]) => ({
      file: relative(projectRoot, file),
      references: hits,
    })),
    total_affected: affected.size,
    changes: input.changes ?? null,
  };
}

// ---------------------------------------------------------------------------
// Mode: dependencies
// ---------------------------------------------------------------------------

interface DepGraph {
  [file: string]: string[];
}

async function buildDepGraph(
  files: string[],
  projectRoot: string,
): Promise<DepGraph> {
  const graph: DepGraph = {};
  for (const file of files) {
    let content: string;
    try {
      content = await Bun.file(file).text();
    } catch {
      graph[file] = [];
      continue;
    }

    const imports: string[] = [];
    const fileDir = dirname(file);

    // Line-by-line import extraction — avoids catastrophic backtracking
    const lines = content.split('\n');
    const specs: string[] = [];
    for (const line of lines) {
      const importMatch = line.match(/(?:import|export)\s.*?from\s+['"]([^'"]+)['"]/);
      if (importMatch?.[1]) specs.push(importMatch[1]);
      const requireMatch = line.match(/require\(['"]([^'"]+)['"]\)/);
      if (requireMatch?.[1]) specs.push(requireMatch[1]);
    }

    for (const spec of specs) {
      if (!spec) continue;

      if (spec.startsWith('.')) {
        // Relative import — resolve to absolute
        const base = resolve(fileDir, spec);
        // Try common extensions
        let resolved = base;
        if (!existsSync(resolved)) {
          for (const ext of ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']) {
            if (existsSync(base + ext)) {
              resolved = base + ext;
              break;
            }
          }
        }
        imports.push(relative(projectRoot, resolved));
      } else {
        // External package
        imports.push(spec);
      }
    }

    graph[relative(projectRoot, file)] = [...new Set(imports)];
  }

  return graph;
}

function detectCycles(graph: DepGraph): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    if (inStack.has(node)) {
      // Found a cycle — extract from where the cycle starts
      const cycleStart = path.indexOf(node);
      if (cycleStart !== -1) {
        cycles.push([...path.slice(cycleStart), node]);
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const dep of graph[node] ?? []) {
      if (dep in graph) {
        // Only traverse internal deps
        dfs(dep, path);
      }
    }

    path.pop();
    inStack.delete(node);
  }

  for (const node of Object.keys(graph)) {
    dfs(node, []);
  }

  return cycles;
}

async function runDependencies(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const submode = input.submode ?? 'analyze';

  let targetFiles: string[];
  if (input.files && input.files.length > 0) {
    targetFiles = [];
    for (const f of input.files) {
      const resolved = resolve(projectRoot, f);
      try {
        const info = await stat(resolved);
        if (info.isDirectory()) {
          const sub = await collectTextFiles(resolved);
          targetFiles.push(...sub);
        } else {
          targetFiles.push(resolved);
        }
      } catch {
        // Skip missing
      }
    }
  } else {
    targetFiles = await collectTextFiles(projectRoot);
  }

  const graph = await buildDepGraph(targetFiles, projectRoot);

  if (submode === 'analyze') {
    return { graph, file_count: targetFiles.length };
  }

  if (submode === 'circular') {
    const cycles = detectCycles(graph);
    return {
      cycles,
      cycle_count: cycles.length,
      has_cycles: cycles.length > 0,
    };
  }

  if (submode === 'upgrade') {
    // Collect external package names
    const externals = new Set<string>();
    for (const deps of Object.values(graph)) {
      for (const dep of deps) {
        if (!dep.startsWith('.') && !dep.startsWith('/')) {
          // Normalize scoped packages: @scope/pkg -> @scope/pkg
          const parts = dep.split('/');
          const pkg = dep.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
          if (pkg) externals.add(pkg);
        }
      }
    }
    return { packages: Array.from(externals).sort(), count: externals.size };
  }

  return { error: `Unknown dependencies submode: ${submode}` };
}

// ---------------------------------------------------------------------------
// Mode: dead_code
// ---------------------------------------------------------------------------

async function runDeadCode(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + MAX_SCAN_MS;
  const intelligence = CodeIntelligence.getInstance();

  const scanRoot =
    input.files && input.files.length > 0
      ? resolve(projectRoot, input.files[0])
      : projectRoot;

  const allFiles = await collectTextFiles(scanRoot, MAX_SCAN_FILES, deadline);

  // Phase 1: collect all exported symbols
  const exports: Array<{ name: string; file: string; line: number }> = [];

  for (const file of allFiles) {
    if (Date.now() > deadline) break;

    let content: string;
    try {
      content = await Bun.file(file).text();
    } catch {
      continue;
    }

    const symbols = await intelligence.getSymbols(file, content);
    if (symbols.length > 0) {
      for (const sym of symbols) {
        if (sym.exported) {
          exports.push({ name: sym.name, file, line: sym.line ?? 0 });
        }
      }
    } else {
      // Fallback: regex
      const lines = content.split('\n');
      const exportRegex = /^export\s+(?:(?:async\s+)?function|class|const|let|var|type|interface|enum)\s+(\w+)/;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].trimStart().match(exportRegex);
        if (m?.[1]) {
          exports.push({ name: m[1], file, line: i + 1 });
        }
      }
    }
  }

  // Phase 2: cache file contents, then find which exports have no references outside their own file
  const fileContentCache = new Map<string, string>();
  for (const file of allFiles) {
    if (Date.now() > deadline) break;
    try {
      fileContentCache.set(file, await Bun.file(file).text());
    } catch {
      // Skip unreadable files
    }
  }

  const dead: Array<{ name: string; file: string; line: number }> = [];

  for (const exp of exports) {
    if (Date.now() > deadline) break;

    let hasReference = false;

    for (const file of allFiles) {
      if (file === exp.file) continue; // skip self
      if (Date.now() > deadline) break;

      const content = fileContentCache.get(file);
      if (content === undefined) continue;

      const nameRegex = new RegExp(`\\b${escapeRegex(exp.name)}\\b`);
      if (nameRegex.test(content)) {
        hasReference = true;
        break;
      }
    }

    if (!hasReference) {
      dead.push({ name: exp.name, file: relative(projectRoot, exp.file), line: exp.line });
    }
  }

  return {
    dead_exports: dead,
    total_exports: exports.length,
    dead_count: dead.length,
  };
}

// ---------------------------------------------------------------------------
// Mode: security
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'api_key_prefix', regex: /['"](?:sk-|pk_|ak_|AKIA)[a-zA-Z0-9]{20,}['"]/  },
  { name: 'token_assignment', regex: /(?:token|secret|password|api_key)\s*[:=]\s*['"][^'"]{8,}['"]/i },
  { name: 'aws_access_key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'private_key', regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
];
async function runSecurity(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const scope = input.securityScope ?? 'all';
  const results: Record<string, unknown> = {};

  const scanRoot =
    input.files && input.files.length > 0
      ? resolve(projectRoot, input.files[0])
      : projectRoot;

  if (scope === 'secrets' || scope === 'all') {
    const findings: Array<{ file: string; line: number; pattern: string; match: string }> = [];
    const files = await collectTextFiles(scanRoot);

    for (const file of files) {
      let content: string;
      try {
        content = await Bun.file(file).text();
      } catch {
        continue;
      }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        for (const { name, regex } of SECRET_PATTERNS) {
          const m = lines[i].match(regex);
          if (m) {
            findings.push({
              file: relative(projectRoot, file),
              line: i + 1,
              pattern: name,
              match: m[0].slice(0, 60), // truncate to avoid leaking long secrets
            });
          }
        }
      }
    }

    results.secrets = { findings, count: findings.length };
  }

  if (scope === 'env' || scope === 'all') {
    // Audit .env files
    const envFiles: string[] = [];
    for (const name of ['.env', '.env.local', '.env.development', '.env.production']) {
      const p = join(projectRoot, name);
      if (existsSync(p)) envFiles.push(name);
    }
    results.env = { files_found: envFiles };
  }

  if (scope === 'permissions' || scope === 'all') {
    // Basic file permission check — look for world-writable files
    const suspicious: string[] = [];
    const files = await collectTextFiles(scanRoot);
    for (const file of files) {
      try {
        const info = await stat(file);
        // mode & 0o002 = world-writable
        if ((info.mode & 0o002) !== 0) {
          suspicious.push(relative(projectRoot, file));
        }
      } catch {
        continue;
      }
    }
    results.permissions = { world_writable: suspicious, count: suspicious.length };
  }

  return results;
}

// ---------------------------------------------------------------------------
// Mode: coverage
// ---------------------------------------------------------------------------

async function runCoverage(
  _input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  // Try coverage/coverage-summary.json first (Istanbul/NYC/c8)
  const summaryPath = join(projectRoot, 'coverage', 'coverage-summary.json');
  if (existsSync(summaryPath)) {
    try {
      const raw = await Bun.file(summaryPath).json();
      const total = raw?.total;
      if (total) {
        return {
          source: 'coverage-summary.json',
          lines: total.lines,
          statements: total.statements,
          branches: total.branches,
          functions: total.functions,
        };
      }
    } catch (err) {
      // Fall through
    }
  }

  // Try coverage/lcov.info
  const lcovPath = join(projectRoot, 'coverage', 'lcov.info');
  if (existsSync(lcovPath)) {
    try {
      const content = await Bun.file(lcovPath).text();
      let linesFound = 0;
      let linesHit = 0;
      let branchesFound = 0;
      let branchesHit = 0;
      let functionsFound = 0;
      let functionsHit = 0;

      for (const line of content.split('\n')) {
        if (line.startsWith('LF:')) linesFound += parseInt(line.slice(3), 10);
        else if (line.startsWith('LH:')) linesHit += parseInt(line.slice(3), 10);
        else if (line.startsWith('BRF:')) branchesFound += parseInt(line.slice(4), 10);
        else if (line.startsWith('BRH:')) branchesHit += parseInt(line.slice(4), 10);
        else if (line.startsWith('FNF:')) functionsFound += parseInt(line.slice(4), 10);
        else if (line.startsWith('FNH:')) functionsHit += parseInt(line.slice(4), 10);
      }

      return {
        source: 'lcov.info',
        lines: { total: linesFound, covered: linesHit, pct: linesFound > 0 ? (linesHit / linesFound) * 100 : 0 },
        branches: { total: branchesFound, covered: branchesHit, pct: branchesFound > 0 ? (branchesHit / branchesFound) * 100 : 0 },
        functions: { total: functionsFound, covered: functionsHit, pct: functionsFound > 0 ? (functionsHit / functionsFound) * 100 : 0 },
      };
    } catch {
      // Fall through
    }
  }

  return { error: 'No coverage data found', searched: ['coverage/coverage-summary.json', 'coverage/lcov.info'] };
}

// ---------------------------------------------------------------------------
// Mode: bundle
// ---------------------------------------------------------------------------

async function runBundle(
  _input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const candidates = [
    join(projectRoot, 'stats.json'),
    join(projectRoot, 'bundle-stats.json'),
    join(projectRoot, '.next', 'build-manifest.json'),
    join(projectRoot, 'dist', 'stats.json'),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = await Bun.file(path).json();
      return { source: relative(projectRoot, path), data: raw };
    } catch {
      continue;
    }
  }

  return {
    error: 'No bundle stats found',
    searched: candidates.map((c) => relative(projectRoot, c)),
  };
}

// ---------------------------------------------------------------------------
// Mode: surface
// ---------------------------------------------------------------------------

async function runSurface(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const intelligence = CodeIntelligence.getInstance();
  const targetFiles: string[] = [];

  if (input.files && input.files.length > 0) {
    for (const f of input.files) {
      const resolved = resolve(projectRoot, f);
      try {
        const info = await stat(resolved);
        if (info.isDirectory()) {
          // Find index files in directory
          for (const name of ['index.ts', 'index.tsx', 'index.js', 'mod.ts']) {
            const idx = join(resolved, name);
            if (existsSync(idx)) {
              targetFiles.push(idx);
              break;
            }
          }
        } else {
          targetFiles.push(resolved);
        }
      } catch {
        continue;
      }
    }
  } else {
    // Default: look for index.ts/index.js at project root
    for (const name of ['index.ts', 'index.tsx', 'index.js', 'src/index.ts', 'src/index.js']) {
      const p = join(projectRoot, name);
      if (existsSync(p)) {
        targetFiles.push(p);
        break;
      }
    }
  }

  if (targetFiles.length === 0) {
    return { error: 'No entry point files found', files_checked: input.files ?? [] };
  }

  const surface: Array<{
    file: string;
    exports: Array<{ name: string; kind: string; line: number }>;
  }> = [];

  for (const file of targetFiles) {
    let content: string;
    try {
      content = await Bun.file(file).text();
    } catch {
      continue;
    }

    const fileExports: Array<{ name: string; kind: string; line: number }> = [];

    const symbols = await intelligence.getSymbols(file, content);
    if (symbols.length > 0) {
      for (const sym of symbols) {
        if (sym.exported) {
          fileExports.push({ name: sym.name, kind: sym.kind ?? 'unknown', line: sym.line ?? 0 });
        }
      }
    } else {
      // Fallback: regex export scan
      const lines = content.split('\n');
      const patterns: Array<{ kind: string; regex: RegExp }> = [
        { kind: 'function', regex: /^export\s+(?:async\s+)?function\s+(\w+)/ },
        { kind: 'class', regex: /^export\s+(?:abstract\s+)?class\s+(\w+)/ },
        { kind: 'interface', regex: /^export\s+interface\s+(\w+)/ },
        { kind: 'type', regex: /^export\s+type\s+(\w+)/ },
        { kind: 'enum', regex: /^export\s+enum\s+(\w+)/ },
        { kind: 'const', regex: /^export\s+const\s+(\w+)/ },
        { kind: 'variable', regex: /^export\s+(?:let|var)\s+(\w+)/ },
      ];
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimStart();
        for (const { kind, regex } of patterns) {
          const m = trimmed.match(regex);
          if (m?.[1]) {
            fileExports.push({ name: m[1], kind, line: i + 1 });
            break;
          }
        }
      }
    }

    surface.push({
      file: relative(projectRoot, file),
      exports: fileExports,
    });
  }

  return {
    surface,
    total_exports: surface.reduce((n, f) => n + f.exports.length, 0),
  };
}

// ---------------------------------------------------------------------------
// Mode: preview
// ---------------------------------------------------------------------------

async function runPreview(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  if (!input.files || input.files.length === 0) {
    return { error: 'preview mode requires files[]' };
  }
  if (input.find === undefined) {
    return { error: 'preview mode requires find string' };
  }

  const filePath = resolve(projectRoot, input.files[0]);
  const relPath = relative(projectRoot, filePath);
  const findStr = input.find;
  const replaceStr = input.replace ?? '';

  let original: string;
  try {
    original = await Bun.file(filePath).text();
  } catch {
    return { error: `Cannot read file: ${relPath}` };
  }

  if (!original.includes(findStr)) {
    return { error: `String not found in ${relPath}`, find: findStr };
  }

  const modified = original.replace(findStr, replaceStr);

  // Generate unified diff
  const diff = generateUnifiedDiff(relPath, original, modified);

  return {
    file: relPath,
    find: findStr,
    replace: replaceStr,
    diff,
    changed_lines: diff.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-')).length,
  };
}

/** Generate a basic unified diff between two strings. */
function generateUnifiedDiff(filename: string, before: string, after: string): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  const header = `--- ${filename}\n+++ ${filename} (modified)\n`;
  const hunks: string[] = [];

  // Find changed regions using a simple line-by-line scan
  let i = 0;
  let j = 0;

  while (i < beforeLines.length || j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      i++;
      j++;
      continue;
    }

    // Find the end of this hunk
    const hunkStartI = i;
    const hunkStartJ = j;
    const contextLines = 3;

    // Collect changed lines
    const changed: string[] = [];
    while (i < beforeLines.length || j < afterLines.length) {
      if (i < beforeLines.length && j < afterLines.length && beforeLines[i] === afterLines[j]) {
        // Check if we're done (3 matching lines in a row)
        let match = 0;
        while (
          i + match < beforeLines.length &&
          j + match < afterLines.length &&
          beforeLines[i + match] === afterLines[j + match] &&
          match < contextLines
        ) {
          match++;
        }
        if (match >= contextLines) break;
      }

      if (i < beforeLines.length && beforeLines[i] !== afterLines[j]) {
        changed.push(`-${beforeLines[i]}`);
        i++;
      } else if (j < afterLines.length) {
        changed.push(`+${afterLines[j]}`);
        j++;
      }
    }

    if (changed.length > 0) {
      const hunk = `@@ -${hunkStartI + 1},${i - hunkStartI} +${hunkStartJ + 1},${j - hunkStartJ} @@\n` +
        changed.join('\n');
      hunks.push(hunk);
    }
  }

  return header + hunks.join('\n');
}

// ---------------------------------------------------------------------------
// Shared git helpers
// ---------------------------------------------------------------------------

/**
 * Validate that both git refs are safe (no shell injection).
 * Returns an error object if either ref is invalid, otherwise null.
 */
function validateGitRefs(
  before: string,
  after: string,
): { error: string; before: string; after: string } | null {
  const safeRefPattern = /^[a-zA-Z0-9_.\-~/^@{}:]+$/;
  if (!safeRefPattern.test(before) || !safeRefPattern.test(after)) {
    return { error: 'Invalid git ref format', before, after };
  }
  return null;
}

/**
 * Truncate a git diff string at the last clean hunk or file boundary before
 * `maxChars`, and append a note indicating how many bytes were omitted.
 * Returns the original string unchanged if it fits within `maxChars`.
 */
function truncateDiffAtBoundary(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;

  const window = diff.slice(0, maxChars);
  // Prefer cutting at a file boundary
  const fileIdx = window.lastIndexOf('\ndiff --git');
  const hunkIdx = window.lastIndexOf('\n@@');
  const cutAt = fileIdx >= 0 ? fileIdx : hunkIdx >= 0 ? hunkIdx : maxChars;
  const omitted = diff.length - cutAt;
  return diff.slice(0, cutAt) + `\n[...truncated, ${omitted} additional bytes omitted]`;
}

// ---------------------------------------------------------------------------
// Mode: diff
// ---------------------------------------------------------------------------

async function runDiff(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const before = input.before ?? 'HEAD~1';
  const after = input.after ?? 'HEAD';

  const refError = validateGitRefs(before, after);
  if (refError) return refError;

  const git = GitService.getInstance(projectRoot);

  let statOutput: string;
  try {
    statOutput = await git.diffStat(before, after);
  } catch (err) {
    return { error: `git diff failed: ${err instanceof Error ? err.message : String(err)}`, before, after };
  }

  let fullDiff: string;
  try {
    fullDiff = await git.diffBetween(before, after, input.files);
  } catch {
    fullDiff = '';
  }

  // Parse stat output into structured form
  const statLines = statOutput.trim().split('\n');
  const files: Array<{ file: string; insertions: number; deletions: number }> = [];

  for (const line of statLines) {
    // Format: " src/foo.ts | 10 ++--"
    const m = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s+([+\-]+)?/);
    if (m) {
      const plusMinus = m[3] ?? '';
      files.push({
        file: m[1].trim(),
        insertions: (plusMinus.match(/\+/g) ?? []).length,
        deletions: (plusMinus.match(/-/g) ?? []).length,
      });
    }
  }

  return { before, after, stat: statOutput.trim(), files, diff: fullDiff.slice(0, 10000) };
}

// ---------------------------------------------------------------------------
// Mode: breaking
// ---------------------------------------------------------------------------

/**
 * Extract exported function/class signatures from a diff hunk.
 * Returns a map of name -> signature string for changed items.
 *
 * Handles multiline signatures by accumulating continuation lines
 * (lines that start with the same diff marker and do not start a new
 * declaration) until a `{` or `;` terminator is reached.
 */
function extractSignaturesFromDiff(diff: string): {
  before: Map<string, string>;
  after: Map<string, string>;
} {
  const before = new Map<string, string>();
  const after = new Map<string, string>();

  const lines = diff.split('\n');

  // Pattern for the opening line of an exported declaration
  const exportLinePattern =
    /^([+-])\s*export\s+(?:(?:async|default|declare)\s+)*(?:function\*?|class|const|let|var|type|interface|enum)\s+(\w+)(.*)/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(exportLinePattern);
    if (!m) continue;

    const marker = m[1] as '-' | '+';
    const name = m[2];
    let rest = m[3];

    // Accumulate continuation lines until we hit a `{` or `;` terminator
    if (!rest.includes('{') && !rest.includes(';')) {
      for (let j = i + 1; j < lines.length; j++) {
        const contLine = lines[j];
        // Must start with the same diff marker (or a space for context lines)
        if (!contLine.startsWith(marker) && !contLine.startsWith(' ')) break;
        const stripped = contLine.startsWith(marker)
          ? contLine.slice(1)
          : contLine.slice(1);
        rest += ' ' + stripped.trim();
        if (stripped.includes('{') || stripped.includes(';')) break;
      }
    }

    // Strip body content after `{` — we only want the signature
    const braceIdx = rest.indexOf('{');
    const sig = `${name}${braceIdx >= 0 ? rest.slice(0, braceIdx).trimEnd() : rest.replace(/;.*$/, '').trimEnd()}`;

    if (marker === '-') {
      before.set(name, sig);
    } else {
      after.set(name, sig);
    }
  }

  return { before, after };
}

async function runBreaking(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const before = input.before ?? 'HEAD~1';
  const after = input.after ?? 'HEAD';

  const refError = validateGitRefs(before, after);
  if (refError) return refError;

  const git = GitService.getInstance(projectRoot);

  let fullDiff: string;
  try {
    fullDiff = await git.diffBetween(before, after, input.files);
  } catch (err) {
    return { error: `git diff failed: ${err instanceof Error ? err.message : String(err)}`, before, after };
  }

  const { before: beforeSigs, after: afterSigs } = extractSignaturesFromDiff(fullDiff);

  const breaking_changes: Array<{ name: string; before: string; after: string; reason: string }> = [];
  const additions: Array<{ name: string; signature: string }> = [];
  const safe_modifications: Array<{ name: string; before: string; after: string }> = [];

  // Names removed from exports = breaking
  for (const [name, sig] of beforeSigs) {
    if (!afterSigs.has(name)) {
      breaking_changes.push({
        name,
        before: sig,
        after: '(removed)',
        reason: 'export removed',
      });
    } else {
      const newSig = afterSigs.get(name)!;
      if (sig !== newSig) {
        // Signature changed — treat as breaking (caller must update)
        breaking_changes.push({
          name,
          before: sig,
          after: newSig,
          reason: 'signature changed',
        });
      } else {
        safe_modifications.push({ name, before: sig, after: newSig });
      }
    }
  }

  // Names only in after = additions (non-breaking)
  for (const [name, sig] of afterSigs) {
    if (!beforeSigs.has(name)) {
      additions.push({ name, signature: sig });
    }
  }

  return {
    before,
    after,
    breaking_changes,
    additions,
    safe_modifications,
    total_breaking: breaking_changes.length,
    total_additions: additions.length,
  };
}

// ---------------------------------------------------------------------------
// Mode: semantic_diff
// ---------------------------------------------------------------------------

async function runSemanticDiff(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const before = input.before ?? 'HEAD~1';
  const after = input.after ?? 'HEAD';

  const refError = validateGitRefs(before, after);
  if (refError) return refError;

  const git = GitService.getInstance(projectRoot);

  let fullDiff: string;
  let statOutput: string;
  try {
    fullDiff = await git.diffBetween(before, after, input.files);
    statOutput = await git.diffStat(before, after);
  } catch (err) {
    return { error: `git diff failed: ${err instanceof Error ? err.message : String(err)}`, before, after };
  }

  // Parse changed files for impact analysis
  const changedFiles: string[] = [];
  for (const line of statOutput.trim().split('\n')) {
    const m = line.match(/^\s*(.+?)\s+\|/);
    if (m) changedFiles.push(m[1].trim());
  }

  // Build LLM prompt with diff context
  const truncatedDiff = truncateDiffAtBoundary(fullDiff, 6000);
  const prompt =
    `You are a code reviewer. Analyze the following git diff and provide:
1. A concise summary of what changed and why (2-4 sentences)
2. Impact analysis: list the downstream functions/modules/callers that may be affected
3. Risk level: low (pure additions/docs), medium (refactors, optional param changes), or high (API removals, signature changes, behavior changes)

Respond in JSON with fields: summary (string), impact (array of strings), risk ("low"|"medium"|"high")

Diff (${before}..${after}):
${truncatedDiff}`;

  const llmResponse = await toolLLM.chat(prompt, { maxTokens: 512 });

  // Parse LLM JSON response, with fallback for unparseable responses
  let summary = 'LLM unavailable — diff available in raw_diff field.';
  let impact: string[] = changedFiles.map((f) => `Changed file: ${f}`);
  let risk: 'low' | 'medium' | 'high' = 'medium';

  if (llmResponse) {
    try {
      // Strip markdown code fences if present
      const cleaned = llmResponse.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
      const parsed = JSON.parse(cleaned) as {
        summary?: string;
        impact?: unknown[];
        risk?: string;
      };
      if (typeof parsed.summary === 'string') summary = parsed.summary;
      if (Array.isArray(parsed.impact)) {
        impact = parsed.impact.map((i) => String(i));
      }
      if (parsed.risk === 'low' || parsed.risk === 'medium' || parsed.risk === 'high') {
        risk = parsed.risk;
      }
    } catch {
      // LLM returned non-JSON prose — use raw as summary
      summary = llmResponse.slice(0, 500);
    }
  }

  return {
    before,
    after,
    summary,
    impact,
    risk,
    changed_files: changedFiles,
  };
}

// ---------------------------------------------------------------------------
// Mode: upgrade
// ---------------------------------------------------------------------------

/** Parse a semver string like "1.2.3" or "^1.2.3" into [major, minor, patch]. */
function parseSemver(version: string): [number, number, number] {
  const clean = version.replace(/^[^0-9]*/, '');
  const parts = clean.split('.').map((p) => parseInt(p, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Returns true if upgrading from `current` to `latest` is a breaking (major) bump. */
function isBreakingUpgrade(current: string, latest: string): boolean {
  const [currentMajor] = parseSemver(current);
  const [latestMajor] = parseSemver(latest);
  // 0.x.y -> 0.z.y is treated as potentially breaking (semver pre-1.0 convention)
  if (currentMajor === 0 && latestMajor === 0) {
    const [, currentMinor] = parseSemver(current);
    const [, latestMinor] = parseSemver(latest);
    return latestMinor > currentMinor;
  }
  return latestMajor > currentMajor;
}

async function runUpgrade(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  // Determine package list: use input.packages[] or read from package.json
  let packageNames: string[];

  if (input.packages && input.packages.length > 0) {
    packageNames = input.packages;
  } else {
    // Read package.json from projectRoot
    const pkgPath = join(projectRoot, 'package.json');
    if (!existsSync(pkgPath)) {
      return { error: 'No package.json found and no packages specified', projectRoot };
    }
    let pkgJson: Record<string, unknown>;
    try {
      pkgJson = await Bun.file(pkgPath).json();
    } catch {
      return { error: 'Failed to parse package.json' };
    }
    const deps = {
      ...((pkgJson.dependencies as Record<string, string>) ?? {}),
      ...((pkgJson.devDependencies as Record<string, string>) ?? {}),
    };
    packageNames = Object.keys(deps);
    if (packageNames.length === 0) {
      return { packages: [], total: 0, outdated: 0, breaking: 0 };
    }
  }

  // Build a map of current versions from package.json (if available)
  const currentVersions: Record<string, string> = {};
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkgJson = await Bun.file(pkgPath).json() as Record<string, unknown>;
      const allDeps = {
        ...((pkgJson.dependencies as Record<string, string>) ?? {}),
        ...((pkgJson.devDependencies as Record<string, string>) ?? {}),
      };
      for (const [name, ver] of Object.entries(allDeps)) {
        currentVersions[name] = ver;
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Fetch latest versions from npm registry in parallel (cap at 20 to avoid flooding)
  const BATCH_SIZE = 20;
  const batch = packageNames.slice(0, BATCH_SIZE);
  const results: Array<{ name: string; current: string; latest: string; breaking: boolean }> = [];

  await Promise.all(
    batch.map(async (name) => {
      const current = currentVersions[name] ?? 'unknown';
      try {
        const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
          signal: AbortSignal.timeout(8000),
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          results.push({ name, current, latest: 'unknown', breaking: false });
          return;
        }
        const data = await res.json() as { version?: string };
        const latest = data.version ?? 'unknown';
        const breaking = current !== 'unknown' && latest !== 'unknown'
          ? isBreakingUpgrade(current, latest)
          : false;
        results.push({ name, current, latest, breaking });
      } catch {
        results.push({ name, current, latest: 'fetch_failed', breaking: false });
      }
    }),
  );

  // Sort: breaking first, then by name
  results.sort((a, b) => {
    if (a.breaking !== b.breaking) return a.breaking ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    packages: results,
    total: results.length,
    outdated: results.filter((r) => r.latest !== 'unknown' && r.latest !== r.current && r.latest !== 'fetch_failed').length,
    breaking: results.filter((r) => r.breaking).length,
  };
}

// ---------------------------------------------------------------------------
// Mode: permissions
// ---------------------------------------------------------------------------

const DANGEROUS_PATTERNS: Array<{ name: string; regex: RegExp; severity: 'high' | 'medium' | 'low' }> = [
  { name: 'eval', regex: /\beval\s*\(/, severity: 'high' },
  { name: 'new_Function', regex: /\bnew\s+Function\s*\(/, severity: 'high' },
  { name: 'child_process_exec', regex: /\bexec\s*\(|\bexecSync\s*\(|\bspawn\s*\(/, severity: 'high' },
  { name: 'fs_chmod_777', regex: /chmod\s*\([^)]*0?777/, severity: 'high' },
  { name: 'dangerouslySetInnerHTML', regex: /dangerouslySetInnerHTML/, severity: 'medium' },
  { name: 'document_write', regex: /\bdocument\.write\s*\(/, severity: 'medium' },
  { name: 'innerHTML_assign', regex: /\.innerHTML\s*=(?!=)/, severity: 'medium' },
  { name: 'unsafe_regex', regex: /new\s+RegExp\s*\(\s*[^"'`]/, severity: 'low' },
];

async function runPermissions(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const scanRoot =
    input.files && input.files.length > 0
      ? resolve(projectRoot, input.files[0])
      : projectRoot;

  const deadline = Date.now() + MAX_SCAN_MS;
  const files = await collectTextFiles(scanRoot, MAX_SCAN_FILES, deadline);

  const findings: Array<{ file: string; line: number; pattern: string; severity: string; match: string }> = [];

  for (const file of files) {
    if (Date.now() > deadline) break;
    let content: string;
    try {
      content = await Bun.file(file).text();
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { name, regex, severity } of DANGEROUS_PATTERNS) {
        const m = lines[i].match(regex);
        if (m) {
          findings.push({
            file: relative(projectRoot, file),
            line: i + 1,
            pattern: name,
            severity,
            match: lines[i].trim().slice(0, 100),
          });
        }
      }
    }
  }

  const byFile: Record<string, number> = {};
  for (const f of findings) {
    byFile[f.file] = (byFile[f.file] ?? 0) + 1;
  }

  return {
    findings,
    total: findings.length,
    files_affected: Object.keys(byFile).length,
    by_severity: {
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      low: findings.filter((f) => f.severity === 'low').length,
    },
  };
}

// ---------------------------------------------------------------------------
// Mode: env_audit
// ---------------------------------------------------------------------------

/** Parse a .env-style file into a set of key names. */
function parseEnvKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      keys.add(trimmed.slice(0, eqIdx).trim());
    }
  }
  return keys;
}

async function runEnvAudit(
  _input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const ENV_FILENAMES = ['.env', '.env.example', '.env.local', '.env.production', '.env.development', '.env.test'];

  const found: Array<{ name: string; keys: string[] }> = [];

  for (const name of ENV_FILENAMES) {
    const p = join(projectRoot, name);
    if (!existsSync(p)) continue;
    try {
      const content = await Bun.file(p).text();
      const keys = Array.from(parseEnvKeys(content)).sort();
      found.push({ name, keys });
    } catch {
      continue;
    }
  }

  if (found.length === 0) {
    return { files: [], missing: [], extra: [], message: 'No .env files found' };
  }

  // Use .env.example (or first file) as the reference set
  const reference = found.find((f) => f.name === '.env.example') ?? found[0];
  const referenceKeys = new Set(reference!.keys);

  const missing: Array<{ key: string; present_in: string; missing_from: string[] }> = [];
  const extra: Array<{ key: string; only_in: string }> = [];

  for (const file of found) {
    if (file.name === reference!.name) continue;
    const fileKeys = new Set(file.keys);

    // Keys in reference but not in this file
    for (const key of referenceKeys) {
      if (!fileKeys.has(key)) {
        const existing = missing.find((m) => m.key === key);
        if (existing) {
          existing.missing_from.push(file.name);
        } else {
          missing.push({ key, present_in: reference!.name, missing_from: [file.name] });
        }
      }
    }

    // Keys in this file but not in reference
    for (const key of fileKeys) {
      if (!referenceKeys.has(key)) {
        extra.push({ key, only_in: file.name });
      }
    }
  }

  return {
    files: found.map((f) => ({ name: f.name, key_count: f.keys.length })),
    reference: reference!.name,
    missing,
    extra,
  };
}

// ---------------------------------------------------------------------------
// Mode: test_find
// ---------------------------------------------------------------------------

/** Derive candidate test file paths for a given source file. */
function testCandidates(sourceFile: string, projectRoot: string): string[] {
  const rel = relative(projectRoot, resolve(projectRoot, sourceFile));
  const candidates: string[] = [];

  // Strip extension
  const noExt = rel.replace(/\.[^.]+$/, '');
  const basename = noExt.split('/').pop() ?? noExt;
  const dir = noExt.split('/').slice(0, -1).join('/');

  const extensions = ['.test.ts', '.test.tsx', '.test.js', '.spec.ts', '.spec.tsx', '.spec.js'];

  for (const ext of extensions) {
    // Same directory: src/foo.ts -> src/foo.test.ts
    candidates.push(join(projectRoot, noExt + ext));
    // __tests__ subdirectory: src/__tests__/foo.test.ts
    if (dir) {
      candidates.push(join(projectRoot, dir, '__tests__', basename + ext));
    } else {
      candidates.push(join(projectRoot, '__tests__', basename + ext));
    }
    // test/ at project root: test/foo.test.ts
    candidates.push(join(projectRoot, 'test', noExt.replace('src/', '') + ext));
    candidates.push(join(projectRoot, 'test', basename + ext));
    // src/test/: mirrors src/ layout under src/test/
    if (rel.startsWith('src/')) {
      const withoutSrc = rel.replace(/^src\//, '').replace(/\.[^.]+$/, '');
      candidates.push(join(projectRoot, 'src', 'test', withoutSrc + ext));
    }
  }

  // Deduplicate while preserving order
  return [...new Set(candidates)];
}

async function runTestFind(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const sourceFiles = input.files ?? [];

  if (sourceFiles.length === 0) {
    return { error: 'test_find mode requires at least one file in files[]' };
  }

  const mappings: Array<{ source: string; test: string | null; exists: boolean; candidates_checked: number }> = [];

  for (const srcFile of sourceFiles) {
    const candidates = testCandidates(srcFile, projectRoot);
    let foundTest: string | null = null;

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        foundTest = relative(projectRoot, candidate);
        break;
      }
    }

    mappings.push({
      source: srcFile,
      test: foundTest,
      exists: foundTest !== null,
      candidates_checked: candidates.length,
    });
  }

  return {
    mappings,
    total: mappings.length,
    found: mappings.filter((m) => m.exists).length,
    missing: mappings.filter((m) => !m.exists).length,
  };
}

// ---------------------------------------------------------------------------
// Main tool
// ---------------------------------------------------------------------------

export const analyzeTool: Tool = {
  definition: analyzeSchema,

  async execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
      if (!args.mode || typeof args.mode !== 'string') {
        return { success: false, error: 'Missing required "mode" field' };
      }

      const input = args as unknown as AnalyzeInput;

      const projectRoot = input.projectRoot
        ? resolve(input.projectRoot)
        : process.cwd();

      let result: Record<string, unknown>;

      switch (input.mode) {
        case 'impact':
          result = await runImpact(input, projectRoot);
          break;
        case 'dependencies':
          result = await runDependencies(input, projectRoot);
          break;
        case 'dead_code':
          result = await runDeadCode(input, projectRoot);
          break;
        case 'security':
          result = await runSecurity(input, projectRoot);
          break;
        case 'coverage':
          result = await runCoverage(input, projectRoot);
          break;
        case 'bundle':
          result = await runBundle(input, projectRoot);
          break;
        case 'surface':
          result = await runSurface(input, projectRoot);
          break;
        case 'preview':
          result = await runPreview(input, projectRoot);
          break;
        case 'diff':
          result = await runDiff(input, projectRoot);
          break;
        case 'breaking':
          result = await runBreaking(input, projectRoot);
          break;
        case 'semantic_diff':
          result = await runSemanticDiff(input, projectRoot);
          break;
        case 'upgrade':
          result = await runUpgrade(input, projectRoot);
          break;
        case 'permissions':
          result = await runPermissions(input, projectRoot);
          break;
        case 'env_audit':
          result = await runEnvAudit(input, projectRoot);
          break;
        case 'test_find':
          result = await runTestFind(input, projectRoot);
          break;
        default: {
          const exhaustive: never = input.mode;
          return { success: false, error: `Unknown mode: ${exhaustive as string}` };
        }
      }

      return { success: true, output: JSON.stringify(appendSchemaFingerprint(result, 'analyze', input.mode)) };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
