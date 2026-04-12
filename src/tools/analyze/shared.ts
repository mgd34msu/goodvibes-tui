import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { walkDir } from '../../utils/walk-dir.ts';
import type { AnalyzeInput, JsonObject, DiffStatFile } from './types.ts';

export const BINARY_CHECK_BYTES = 8192;
export const MAX_SCAN_FILES = 500;
export const MAX_SCAN_MS = 5000;
export const ANALYZE_SUMMARY_SAMPLE_LIMIT = 5;

export async function isBinary(filePath: string): Promise<boolean> {
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

export async function collectTextFiles(
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

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function validatePath(inputPath: string, root: string): string | { error: string } {
  try {
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

export async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await Bun.file(filePath).text();
  } catch {
    return null;
  }
}

export async function collectInputFiles(
  inputFiles: string[] | undefined,
  projectRoot: string,
  options: {
    expandDirectories?: boolean;
    limit?: number;
    deadline?: number;
  } = {},
): Promise<string[]> {
  const expandDirectories = options.expandDirectories ?? false;
  const limit = options.limit ?? MAX_SCAN_FILES;
  const deadline = options.deadline;

  if (!inputFiles || inputFiles.length === 0) {
    return collectTextFiles(projectRoot, limit, deadline);
  }

  const files: string[] = [];
  for (const inputFile of inputFiles) {
    if (files.length >= limit) break;
    if (deadline && Date.now() > deadline) break;

    const resolved = resolve(projectRoot, inputFile);
    try {
      const info = await stat(resolved);
      if (info.isDirectory()) {
        if (expandDirectories) {
          const remaining = limit - files.length;
          const collected = await collectTextFiles(resolved, remaining, deadline);
          files.push(...collected);
        }
        continue;
      }
      files.push(resolved);
    } catch {
      // Skip missing or unreadable paths.
    }
  }

  return files;
}

export function sampleArray<T>(value: unknown, limit = ANALYZE_SUMMARY_SAMPLE_LIMIT): T[] {
  return Array.isArray(value) ? (value as T[]).slice(0, limit) : [];
}

export function summarizeAnalyzeResult(mode: AnalyzeInput['mode'], result: Record<string, unknown>): Record<string, unknown> {
  switch (mode) {
    case 'dependencies':
      return {
        mode,
        has_cycles: result.has_cycles ?? false,
        fileCount: result.graph && typeof result.graph === 'object' ? Object.keys(result.graph as Record<string, unknown>).length : 0,
        cycleCount: Array.isArray(result.cycles) ? result.cycles.length : 0,
        cycles: sampleArray<string[]>(result.cycles),
      };
    case 'dead_code':
      return {
        mode,
        total_exports: result.total_exports ?? 0,
        dead_export_count: Array.isArray(result.dead_exports) ? result.dead_exports.length : 0,
        dead_exports: sampleArray<Record<string, unknown>>(result.dead_exports).map((entry) => ({
          name: entry.name ?? null,
          file: entry.file ?? null,
        })),
      };
    case 'security': {
      const secrets = (result.secrets as Record<string, unknown> | undefined) ?? {};
      const env = (result.env as Record<string, unknown> | undefined) ?? {};
      const permissions = (result.permissions as Record<string, unknown> | undefined) ?? {};
      return {
        mode,
        secretFindingCount: Array.isArray(secrets.findings) ? secrets.findings.length : 0,
        envFileCount: Array.isArray(env.files_found) ? env.files_found.length : 0,
        permissionFindingCount: Array.isArray(permissions.findings) ? permissions.findings.length : 0,
        topSecretFindings: sampleArray<Record<string, unknown>>(secrets.findings).map((finding) => ({
          pattern: finding.pattern ?? null,
          file: finding.file ?? null,
          line: finding.line ?? null,
        })),
      };
    }
    case 'surface':
      return {
        mode,
        fileCount: Array.isArray(result.surface) ? result.surface.length : 0,
        total_exports: result.total_exports ?? 0,
        surface: sampleArray<Record<string, unknown>>(result.surface).map((entry) => ({
          file: entry.file ?? null,
          exportCount: Array.isArray(entry.exports) ? entry.exports.length : 0,
          exports: sampleArray<Record<string, unknown>>(entry.exports).map((exp) => exp.name ?? null),
        })),
      };
    case 'impact':
      return {
        mode,
        summary: result.summary ?? null,
        changed_files: sampleArray<string>(result.changed_files),
        affected: sampleArray<Record<string, unknown>>(result.affected).map((entry) => ({
          file: entry.file ?? null,
          reason: entry.reason ?? null,
        })),
      };
    case 'diff':
    case 'semantic_diff':
      return {
        mode,
        summary: result.summary ?? null,
        risk: result.risk ?? null,
        impact: sampleArray<string>(result.impact),
        changed_files: sampleArray<string>(result.changed_files),
      };
    case 'coverage':
      return {
        mode,
        source: result.source ?? null,
        line_pct: result.line_pct ?? null,
        branch_pct: result.branch_pct ?? null,
        function_pct: result.function_pct ?? null,
        statement_pct: result.statement_pct ?? null,
      };
    case 'bundle':
      return {
        mode,
        source: result.source ?? null,
        assetCount: Array.isArray(result.assets) ? result.assets.length : 0,
        chunkCount: Array.isArray(result.chunks) ? result.chunks.length : 0,
        assets: sampleArray<Record<string, unknown>>(result.assets).map((asset) => ({
          name: asset.name ?? null,
          size: asset.size ?? null,
        })),
      };
    case 'upgrade':
      return {
        mode,
        packageCount: Array.isArray(result.packages) ? result.packages.length : 0,
        outdated: sampleArray<Record<string, unknown>>(result.packages).filter((pkg) => pkg.current !== pkg.latest).map((pkg) => ({
          name: pkg.name ?? null,
          current: pkg.current ?? null,
          latest: pkg.latest ?? null,
        })),
      };
    case 'permissions':
    case 'env_audit':
    case 'test_find':
    case 'preview':
    case 'breaking':
      return {
        mode,
        summary: result.summary ?? null,
        count: result.count ?? null,
        findings: sampleArray<Record<string, unknown>>(result.findings),
      };
    default:
      return result;
  }
}

export function applyAnalyzeTokenBudget(output: string, maxTokens: number | undefined): string {
  if (typeof maxTokens !== 'number' || maxTokens <= 0) return output;
  const maxChars = Math.max(32, maxTokens * 4);
  if (output.length <= maxChars) return output;
  return `${output.slice(0, maxChars - 1)}…`;
}

export async function readJsonFile<T extends JsonObject = JsonObject>(filePath: string): Promise<T | null> {
  try {
    return (await Bun.file(filePath).json()) as T;
  } catch {
    return null;
  }
}

export function resolveScanRoot(input: AnalyzeInput, projectRoot: string): string {
  return input.files && input.files.length > 0 ? resolve(projectRoot, input.files[0]) : projectRoot;
}

export function collectExistingPaths(projectRoot: string, names: string[]): string[] {
  const found: string[] = [];
  for (const name of names) {
    const candidate = join(projectRoot, name);
    if (existsSync(candidate)) {
      found.push(name);
    }
  }
  return found;
}

export function loadDependencyVersions(pkgJson: JsonObject): Record<string, string> {
  return {
    ...((pkgJson.dependencies as Record<string, string>) ?? {}),
    ...((pkgJson.devDependencies as Record<string, string>) ?? {}),
  };
}

export function parseDiffStats(statOutput: string): DiffStatFile[] {
  const files: DiffStatFile[] = [];
  for (const line of statOutput.trim().split('\n')) {
    const m = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s+([+\-]+)?/);
    if (!m) continue;
    const plusMinus = m[3] ?? '';
    files.push({
      file: m[1].trim(),
      insertions: (plusMinus.match(/\+/g) ?? []).length,
      deletions: (plusMinus.match(/-/g) ?? []).length,
    });
  }
  return files;
}

export function findEntryPoint(targetDir: string, candidates: string[]): string | null {
  for (const name of candidates) {
    const candidate = join(targetDir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function validateGitRefs(
  before: string,
  after: string,
): { error: string; before: string; after: string } | null {
  const safeRefPattern = /^[a-zA-Z0-9_.\-~/^@{}:]+$/;
  if (!safeRefPattern.test(before) || !safeRefPattern.test(after)) {
    return { error: 'Invalid git ref format', before, after };
  }
  return null;
}

export function truncateDiffAtBoundary(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;

  const window = diff.slice(0, maxChars);
  const fileIdx = window.lastIndexOf('\ndiff --git');
  const hunkIdx = window.lastIndexOf('\n@@');
  const cutAt = fileIdx >= 0 ? fileIdx : hunkIdx >= 0 ? hunkIdx : maxChars;
  const omitted = diff.length - cutAt;
  return diff.slice(0, cutAt) + `\n[...truncated, ${omitted} additional bytes omitted]`;
}

export function parseSemver(version: string): [number, number, number] {
  const clean = version.replace(/^[^0-9]*/, '');
  const parts = clean.split('.').map((p) => parseInt(p, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

export function isBreakingUpgrade(current: string, latest: string): boolean {
  const [currentMajor] = parseSemver(current);
  const [latestMajor] = parseSemver(latest);
  if (currentMajor === 0 && latestMajor === 0) {
    const [, currentMinor] = parseSemver(current);
    const [, latestMinor] = parseSemver(latest);
    return latestMinor > currentMinor;
  }
  return latestMajor > currentMajor;
}

export function parseEnvKeys(content: string): Set<string> {
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

export function testCandidates(sourceFile: string, projectRoot: string): string[] {
  const rel = relative(projectRoot, resolve(projectRoot, sourceFile));
  const candidates: string[] = [];

  const noExt = rel.replace(/\.[^.]+$/, '');
  const basename = noExt.split('/').pop() ?? noExt;
  const dir = noExt.split('/').slice(0, -1).join('/');
  const extensions = ['.test.ts', '.test.tsx', '.test.js', '.spec.ts', '.spec.tsx', '.spec.js'];

  for (const ext of extensions) {
    candidates.push(join(projectRoot, noExt + ext));
    if (dir) {
      candidates.push(join(projectRoot, dir, '__tests__', basename + ext));
    } else {
      candidates.push(join(projectRoot, '__tests__', basename + ext));
    }
    candidates.push(join(projectRoot, 'test', noExt.replace('src/', '') + ext));
    candidates.push(join(projectRoot, 'test', basename + ext));
    if (rel.startsWith('src/')) {
      const withoutSrc = rel.replace(/^src\//, '').replace(/\.[^.]+$/, '');
      candidates.push(join(projectRoot, 'src', 'test', withoutSrc + ext));
    }
  }

  return [...new Set(candidates)];
}
