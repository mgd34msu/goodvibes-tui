import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { CodeIntelligence } from '../../intelligence/facade.ts';
import type { AnalyzeInput, ExportedSymbol } from './types.ts';
import {
  MAX_SCAN_FILES,
  MAX_SCAN_MS,
  collectExistingPaths,
  collectInputFiles,
  collectTextFiles,
  escapeRegex,
  findEntryPoint,
  parseEnvKeys,
  readJsonFile,
  readTextFile,
  resolveScanRoot,
  testCandidates,
  validatePath,
} from './shared.ts';

function extractExportedSymbols(content: string): Array<{ name: string; kind: string; line: number }> {
  const symbols: Array<{ name: string; kind: string; line: number }> = [];
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
        symbols.push({ name: m[1], kind, line: i + 1 });
        break;
      }
    }
  }

  return symbols;
}

async function collectExportedSymbols(
  files: string[],
  intelligence: CodeIntelligence,
): Promise<ExportedSymbol[]> {
  const exported: ExportedSymbol[] = [];

  for (const file of files) {
    const content = await readTextFile(file);
    if (content === null) continue;

    const symbols = await intelligence.getSymbols(file, content);
    if (symbols.length > 0) {
      for (const sym of symbols) {
        if (sym.exported) {
          exported.push({ name: sym.name, file, line: sym.line ?? 0, kind: sym.kind ?? 'unknown' });
        }
      }
      continue;
    }

    for (const sym of extractExportedSymbols(content)) {
      exported.push({ ...sym, file });
    }
  }

  return exported;
}

export async function runImpact(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const targetFiles = input.files ?? [];
  if (targetFiles.length === 0) {
    return { error: 'impact mode requires at least one file in files[]' };
  }

  const deadline = Date.now() + MAX_SCAN_MS;
  const intelligence = new CodeIntelligence();
  const exportedNames = await collectExportedSymbols(
    targetFiles
      .map((rawFile) => validatePath(rawFile, projectRoot))
      .filter((resolved): resolved is string => typeof resolved === 'string'),
    intelligence,
  );

  if (exportedNames.length === 0) {
    return { affected_files: [], exported_names: [], message: 'No exported symbols found in target files' };
  }

  const allProjectFiles = await collectTextFiles(projectRoot, MAX_SCAN_FILES, deadline);
  const targetSet = new Set(exportedNames.map((e) => e.file));
  const affected = new Map<string, Array<{ name: string; line: number }>>();

  for (const file of allProjectFiles) {
    if (targetSet.has(file)) continue;
    if (Date.now() > deadline) break;

    const content = await readTextFile(file);
    if (content === null) continue;

    const lines = content.split('\n');
    for (const exported of exportedNames) {
      const nameRegex = new RegExp(`\\b${escapeRegex(exported.name)}\\b`);
      for (let i = 0; i < lines.length; i++) {
        if (nameRegex.test(lines[i])) {
          const entry = affected.get(file) ?? [];
          entry.push({ name: exported.name, line: i + 1 });
          affected.set(file, entry);
          break;
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

interface DepGraph {
  [file: string]: string[];
}

async function buildDepGraph(
  files: string[],
  projectRoot: string,
): Promise<DepGraph> {
  const graph: DepGraph = {};
  for (const file of files) {
    const content = await readTextFile(file);
    if (content === null) {
      graph[file] = [];
      continue;
    }

    const imports: string[] = [];
    const fileDir = dirname(file);
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
        const base = resolve(fileDir, spec);
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

export async function runDependencies(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const submode = input.submode ?? 'analyze';
  const targetFiles = await collectInputFiles(input.files, projectRoot, { expandDirectories: true });
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
    const externals = new Set<string>();
    for (const deps of Object.values(graph)) {
      for (const dep of deps) {
        if (!dep.startsWith('.') && !dep.startsWith('/')) {
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

export async function runDeadCode(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + MAX_SCAN_MS;
  const intelligence = new CodeIntelligence();
  const scanRoot =
    input.files && input.files.length > 0
      ? resolve(projectRoot, input.files[0])
      : projectRoot;

  const allFiles = await collectTextFiles(scanRoot, MAX_SCAN_FILES, deadline);
  const exports = await collectExportedSymbols(allFiles, intelligence);

  const fileContentCache = new Map<string, string>();
  for (const file of allFiles) {
    if (Date.now() > deadline) break;
    const content = await readTextFile(file);
    if (content !== null) fileContentCache.set(file, content);
  }

  const dead: Array<{ name: string; file: string; line: number }> = [];
  for (const exp of exports) {
    if (Date.now() > deadline) break;
    let hasReference = false;

    for (const file of allFiles) {
      if (file === exp.file) continue;
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

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'api_key_prefix', regex: /['"](?:sk-|pk_|ak_|AKIA)[a-zA-Z0-9]{20,}['"]/ },
  { name: 'token_assignment', regex: /(?:token|secret|password|api_key)\s*[:=]\s*['"][^'"]{8,}['"]/i },
  { name: 'aws_access_key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'private_key', regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
];

export async function runSecurity(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const scope = input.securityScope ?? 'all';
  const results: Record<string, unknown> = {};
  const scanRoot = resolveScanRoot(input, projectRoot);

  if (scope === 'secrets' || scope === 'all') {
    const findings: Array<{ file: string; line: number; pattern: string; match: string }> = [];
    const files = await collectTextFiles(scanRoot);

    for (const file of files) {
      const content = await readTextFile(file);
      if (content === null) continue;

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        for (const { name, regex } of SECRET_PATTERNS) {
          const m = lines[i].match(regex);
          if (m) {
            findings.push({
              file: relative(projectRoot, file),
              line: i + 1,
              pattern: name,
              match: m[0].slice(0, 60),
            });
          }
        }
      }
    }

    results.secrets = { findings, count: findings.length };
  }

  if (scope === 'env' || scope === 'all') {
    results.env = {
      files_found: collectExistingPaths(projectRoot, ['.env', '.env.local', '.env.development', '.env.production']),
    };
  }

  if (scope === 'permissions' || scope === 'all') {
    const suspicious: string[] = [];
    const files = await collectTextFiles(scanRoot);
    for (const file of files) {
      try {
        const info = await stat(file);
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

export async function runCoverage(
  _input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const summaryPath = join(projectRoot, 'coverage', 'coverage-summary.json');
  if (existsSync(summaryPath)) {
    const raw = await readJsonFile(summaryPath);
    const total = raw?.total as
      | { lines?: unknown; statements?: unknown; branches?: unknown; functions?: unknown }
      | undefined;
    if (total) {
      return {
        source: 'coverage-summary.json',
        lines: total.lines,
        statements: total.statements,
        branches: total.branches,
        functions: total.functions,
      };
    }
  }

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

export async function runBundle(
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
    const raw = await readJsonFile(path);
    if (raw !== null) {
      return { source: relative(projectRoot, path), data: raw };
    }
  }

  return {
    error: 'No bundle stats found',
    searched: candidates.map((c) => relative(projectRoot, c)),
  };
}

export async function runSurface(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const intelligence = new CodeIntelligence();
  const targetFiles: string[] = [];

  if (input.files && input.files.length > 0) {
    for (const f of input.files) {
      const resolved = resolve(projectRoot, f);
      try {
        const info = await stat(resolved);
        if (info.isDirectory()) {
          const idx = findEntryPoint(resolved, ['index.ts', 'index.tsx', 'index.js', 'mod.ts']);
          if (idx) targetFiles.push(idx);
        } else {
          targetFiles.push(resolved);
        }
      } catch {
        continue;
      }
    }
  } else {
    const rootEntry = findEntryPoint(projectRoot, ['index.ts', 'index.tsx', 'index.js', 'src/index.ts', 'src/index.js']);
    if (rootEntry) targetFiles.push(rootEntry);
  }

  if (targetFiles.length === 0) {
    return { error: 'No entry point files found', files_checked: input.files ?? [] };
  }

  const surface: Array<{
    file: string;
    exports: Array<{ name: string; kind: string; line: number }>;
  }> = [];

  for (const file of targetFiles) {
    const fileExports = await collectExportedSymbols([file], intelligence);

    surface.push({
      file: relative(projectRoot, file),
      exports: fileExports.map(({ name, kind, line }) => ({ name, kind: kind ?? 'unknown', line })),
    });
  }

  return {
    surface,
    total_exports: surface.reduce((n, f) => n + f.exports.length, 0),
  };
}

export async function runPreview(
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
  const diff = generateUnifiedDiff(relPath, original, modified);

  return {
    file: relPath,
    find: findStr,
    replace: replaceStr,
    diff,
    changed_lines: diff.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-')).length,
  };
}

function generateUnifiedDiff(filename: string, before: string, after: string): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  const header = `--- ${filename}\n+++ ${filename} (modified)\n`;
  const hunks: string[] = [];
  let i = 0;
  let j = 0;

  while (i < beforeLines.length || j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      i++;
      j++;
      continue;
    }

    const hunkStartI = i;
    const hunkStartJ = j;
    const contextLines = 3;
    const changed: string[] = [];

    while (i < beforeLines.length || j < afterLines.length) {
      if (i < beforeLines.length && j < afterLines.length && beforeLines[i] === afterLines[j]) {
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

export async function runPermissions(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const scanRoot = resolveScanRoot(input, projectRoot);
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

export async function runEnvAudit(
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

  const reference = found.find((f) => f.name === '.env.example') ?? found[0];
  const referenceKeys = new Set(reference!.keys);
  const missing: Array<{ key: string; present_in: string; missing_from: string[] }> = [];
  const extra: Array<{ key: string; only_in: string }> = [];

  for (const file of found) {
    if (file.name === reference!.name) continue;
    const fileKeys = new Set(file.keys);

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

export async function runTestFind(
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
