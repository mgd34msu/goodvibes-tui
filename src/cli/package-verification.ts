import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface PackageCliBinVerification {
  readonly command: 'goodvibes';
  readonly target: string;
  readonly exists: boolean;
  readonly executable: boolean;
  readonly usesBunShebang: boolean;
  readonly hasLocalPlatformBuildFallback: boolean;
  readonly hasLocalBuildFallback: boolean;
  readonly hasVendoredBinaryFallback: boolean;
  readonly hasSourceFallback: boolean;
}

export interface PackageCliVerificationReport {
  readonly packageName: string;
  readonly version: string;
  readonly bins: readonly PackageCliBinVerification[];
  readonly tarball: {
    readonly entryCount: number;
    readonly unpackedSize: number;
    readonly requiredPathsPresent: readonly string[];
    readonly forbiddenPaths: readonly string[];
  };
  readonly issues: readonly string[];
}

// One bin, one entry point. The daemon ships as its own package with its own
// binary; this package carrying a second wrapper is what let two daemons exist
// on one machine, built from one tree and drifting apart.
const REQUIRED_BIN_COMMANDS = ['goodvibes'] as const;
const REQUIRED_TARBALL_PATHS = [
  'README.md',
  'CHANGELOG.md',
  'package.json',
  'src/main.ts',
  'bin/goodvibes',
  'scripts/check-bun.sh',
  'scripts/postinstall.js',
  '.goodvibes/GOODVIBES.md',
] as const;
const FORBIDDEN_TARBALL_PREFIXES = ['.github/', 'src/test/', 'src/.test/', '.goodvibes/memory/', 'vendor/'] as const;

function readPackageJson(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as Record<string, unknown>;
}

function hasExecutableBit(path: string): boolean {
  return existsSync(path) && (statSync(path).mode & 0o111) !== 0;
}

function verifyBin(root: string, command: typeof REQUIRED_BIN_COMMANDS[number], target: string | undefined): PackageCliBinVerification {
  const binPath = target ? join(root, target) : '';
  const source = target && existsSync(binPath) ? readFileSync(binPath, 'utf-8') : '';
  const expectedLocalBuild = "dist', 'goodvibes'";
  const expectedSource = "src', 'main.ts'";
  return {
    command,
    target: target ?? '',
    exists: Boolean(target) && existsSync(binPath),
    executable: Boolean(target) && hasExecutableBit(binPath),
    usesBunShebang: source.startsWith('#!/usr/bin/env bun'),
    hasLocalPlatformBuildFallback: source.includes("dist', artifactName"),
    hasLocalBuildFallback: source.includes(expectedLocalBuild),
    hasVendoredBinaryFallback: source.includes('vendor'),
    hasSourceFallback: source.includes(expectedSource) && source.includes("'bun'"),
  };
}

export interface NpmPackDryRunResult {
  readonly files: readonly string[];
  readonly entryCount: number;
  readonly unpackedSize: number;
}

interface NpmPackJsonEntry {
  readonly files?: ReadonlyArray<{ readonly path?: string } | null>;
  readonly entryCount?: number;
  readonly unpackedSize?: number;
}

function describeNpmPackOutput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'no output at all';
  const preview = trimmed.length > 400 ? `${trimmed.slice(0, 400)}...` : trimmed;
  return `${trimmed.length} characters of output beginning: ${preview}`;
}

// npm wrappers (version-manager shims, "npm notice" lines) sometimes print plain text
// on stdout alongside the JSON document. Take the first balanced JSON value and ignore
// whatever surrounds it, tracking string literals so braces inside paths do not confuse
// the depth count.
function extractJsonDocument(raw: string): string | undefined {
  const start = raw.search(/[[{]/);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return undefined;
}

function looksLikePackEntry(value: unknown): value is NpmPackJsonEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.files) || typeof candidate.entryCount === 'number' || typeof candidate.unpackedSize === 'number';
}

function selectPackEntry(parsed: unknown): NpmPackJsonEntry | undefined {
  // npm 10/11 emit `[{ files, entryCount, unpackedSize }]`.
  if (Array.isArray(parsed)) return parsed.find(looksLikePackEntry);
  // npm 12 emits `{ "<package-name>": { files, entryCount, unpackedSize } }`.
  if (looksLikePackEntry(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return Object.values(parsed as Record<string, unknown>).find(looksLikePackEntry);
  return undefined;
}

export function parseNpmPackJson(raw: string): NpmPackDryRunResult {
  const document = extractJsonDocument(raw);
  if (document === undefined) {
    throw new Error(`npm pack --json --dry-run printed no JSON document; npm emitted ${describeNpmPackOutput(raw)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`npm pack --json --dry-run printed JSON that could not be parsed (${reason}); npm emitted ${describeNpmPackOutput(raw)}`);
  }
  const entry = selectPackEntry(parsed);
  if (!entry) {
    throw new Error(
      `npm pack --json --dry-run returned an unrecognized JSON shape; expected an array of pack results or an object keyed by package name, but npm emitted ${describeNpmPackOutput(raw)}`,
    );
  }
  return {
    files: Array.isArray(entry.files) ? entry.files.map((file) => String(file?.path ?? '')) : [],
    entryCount: Number(entry.entryCount ?? 0),
    unpackedSize: Number(entry.unpackedSize ?? 0),
  };
}

function npmPackDryRun(root: string): NpmPackDryRunResult {
  const raw = execSync('npm pack --json --dry-run', {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return parseNpmPackJson(raw);
}

export function verifyPackageCliInstall(root: string): PackageCliVerificationReport {
  const pkg = readPackageJson(root);
  const bin = pkg.bin && typeof pkg.bin === 'object' ? pkg.bin as Record<string, string | undefined> : {};
  const bins = REQUIRED_BIN_COMMANDS.map((command) => verifyBin(root, command, bin[command]));
  const pack = npmPackDryRun(root);
  const requiredPathsPresent = REQUIRED_TARBALL_PATHS.filter((path) => pack.files.includes(path));
  const forbiddenPaths = pack.files.filter((path) => FORBIDDEN_TARBALL_PREFIXES.some((prefix) => path.startsWith(prefix)));
  const issues: string[] = [];

  for (const item of bins) {
    if (!item.target) issues.push(`package.json bin is missing ${item.command}.`);
    if (!item.exists) issues.push(`bin target does not exist: ${item.command} -> ${item.target}`);
    if (!item.executable) issues.push(`bin target is not executable: ${item.command} -> ${item.target}`);
    if (!item.usesBunShebang) issues.push(`bin target does not use Bun shebang: ${item.command} -> ${item.target}`);
    if (!item.hasLocalPlatformBuildFallback) issues.push(`bin target lacks local platform dist fallback: ${item.command}`);
    if (!item.hasLocalBuildFallback) issues.push(`bin target lacks local dist fallback: ${item.command}`);
    if (!item.hasVendoredBinaryFallback) issues.push(`bin target lacks vendored binary fallback: ${item.command}`);
    if (!item.hasSourceFallback) issues.push(`bin target lacks Bun source fallback: ${item.command}`);
  }
  for (const path of REQUIRED_TARBALL_PATHS) {
    if (!pack.files.includes(path)) issues.push(`npm tarball missing required path: ${path}`);
  }
  for (const path of forbiddenPaths) {
    issues.push(`npm tarball includes forbidden path: ${path}`);
  }

  return {
    packageName: String(pkg.name ?? ''),
    version: String(pkg.version ?? ''),
    bins,
    tarball: {
      entryCount: pack.entryCount,
      unpackedSize: pack.unpackedSize,
      requiredPathsPresent,
      forbiddenPaths,
    },
    issues,
  };
}
