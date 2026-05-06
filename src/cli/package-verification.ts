import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface PackageCliBinVerification {
  readonly command: 'goodvibes' | 'goodvibes-daemon';
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

const REQUIRED_BIN_COMMANDS = ['goodvibes', 'goodvibes-daemon'] as const;
const REQUIRED_TARBALL_PATHS = [
  'README.md',
  'CHANGELOG.md',
  'package.json',
  'src/main.ts',
  'src/daemon/cli.ts',
  'bin/goodvibes',
  'bin/goodvibes-daemon',
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
  const expectedLocalBuild = command === 'goodvibes' ? "dist', 'goodvibes'" : "dist', 'goodvibes-daemon'";
  const expectedSource = command === 'goodvibes' ? "src', 'main.ts'" : "src', 'daemon', 'cli.ts'";
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

function npmPackDryRun(root: string): { readonly files: readonly string[]; readonly entryCount: number; readonly unpackedSize: number } {
  const raw = execSync('npm pack --json --dry-run', {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [packResult] = JSON.parse(raw) as Array<{ files?: Array<{ path?: string }>; entryCount?: number; unpackedSize?: number }>;
  return {
    files: Array.isArray(packResult?.files) ? packResult.files.map((entry) => String(entry.path ?? '')) : [],
    entryCount: Number(packResult?.entryCount ?? 0),
    unpackedSize: Number(packResult?.unpackedSize ?? 0),
  };
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
