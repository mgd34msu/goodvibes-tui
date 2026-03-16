import { resolve, relative, join, dirname } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Tool } from '../../types/tools.ts';
import { analyzeSchema } from './schema.ts';
import { CodeIntelligence } from '../../intelligence/facade.ts';
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
    | 'surface';
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
  output?: {
    format?: 'summary' | 'detailed' | 'json';
    max_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// File walking utilities (self-contained, mirrors find tool)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '.nuxt', '.cache', '__pycache__']);
const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
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

async function* walkDir(dirPath: string): AsyncGenerator<string> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(fullPath);
    } else if (entry.isFile()) {
      try {
        const info = await stat(fullPath);
        if (info.size > MAX_FILE_SIZE) continue;
      } catch {
        continue;
      }
      yield fullPath;
    }
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
// Mode: diff
// ---------------------------------------------------------------------------

async function runDiff(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const before = input.before ?? 'HEAD~1';
  const after = input.after ?? 'HEAD';

  // Validate ref format to prevent argument injection (allow alphanumeric, dots, slashes, dashes, tildes, carets)
  const safeRefPattern = /^[a-zA-Z0-9_.\-~/^@{}:]+$/;
  if (!safeRefPattern.test(before) || !safeRefPattern.test(after)) {
    return { error: 'Invalid git ref format', before, after };
  }

  const proc = Bun.spawn(
    ['git', 'diff', '--stat', before, after],
    { cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' },
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    return { error: `git diff failed: ${stderr.trim()}`, before, after };
  }

  // Also get the full diff
  const fullProc = Bun.spawn(
    ['git', 'diff', '--', before, after, '--', ...(input.files ?? [])],
    { cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' },
  );

  const fullDiff = await new Response(fullProc.stdout).text();
  await fullProc.exited;

  // Parse stat output into structured form
  const statLines = stdout.trim().split('\n');
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

  return { before, after, stat: stdout.trim(), files, diff: fullDiff.slice(0, 10000) };
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
        default: {
          const exhaustive: never = input.mode;
          return { success: false, error: `Unknown mode: ${exhaustive as string}` };
        }
      }

      return { success: true, output: JSON.stringify(result) };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
