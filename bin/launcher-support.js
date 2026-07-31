import { accessSync, chmodSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const SUPPORTED_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];

// Platform package names, mirrored from scripts/platform-packages.ts. This file
// is plain JS shipped in the tarball and cannot import that TS module; keep the
// two in sync. Keyed by `${process.platform}-${node-arch}`.
const PLATFORM_PACKAGE_NAMES = {
  'linux-x64': '@pellux/goodvibes-tui-linux-x64',
  'linux-arm64': '@pellux/goodvibes-tui-linux-arm64',
  'darwin-x64': '@pellux/goodvibes-tui-darwin-x64',
  'darwin-arm64': '@pellux/goodvibes-tui-darwin-arm64',
};

/**
 * Resolve the prebuilt binary from the installed platform package
 * (@pellux/goodvibes-tui-<os>-<arch>), if present. The package manager installs
 * it with registry integrity and no lifecycle script, so this path needs no
 * trust step and no post-install download. Returns null when the package is not
 * installed (e.g. an unsupported platform, or optional-dep resolution skipped).
 */
export function resolvePlatformPackageBinary(platform, arch, fromDir) {
  const artifactName = resolveArtifactName(platform, arch);
  if (!artifactName) return null;
  const pkgName = PLATFORM_PACKAGE_NAMES[`${platform}-${arch}`];
  if (!pkgName) return null;
  try {
    const require = createRequire(join(fromDir, 'package.json'));
    const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
    const binPath = join(dirname(pkgJsonPath), 'bin', artifactName);
    return isExecutable(binPath) ? binPath : null;
  } catch {
    return null;
  }
}

export function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function run(command, args) {
  const child = spawnSync(command, args, { stdio: 'inherit' });
  if (child.error) {
    throw child.error;
  }
  process.exit(child.status ?? 1);
}

export function isSourceCheckout(packageRoot) {
  return isExecutable(join(packageRoot, 'node_modules', '.bin', 'bun')) ||
    isExecutable(join(packageRoot, 'node_modules', '.bin', 'tsc')) ||
    fileExists(join(packageRoot, 'tsconfig.json'));
}

export function supportedTargetsText() {
  return SUPPORTED_TARGETS.join(', ');
}

// One binary, so no artifact KIND to choose between any more: this package
// shipped `goodvibes-daemon` alongside `goodvibes` while one repository built
// both, and the daemon is its own product with its own package and its own
// launcher now.
export function resolveArtifactName(platform, arch) {
  const prefix = 'goodvibes';
  if (platform === 'linux' && arch === 'x64') return `${prefix}-linux-x64`;
  if (platform === 'linux' && arch === 'arm64') return `${prefix}-linux-arm64`;
  if (platform === 'darwin' && arch === 'x64') return `${prefix}-macos-x64`;
  if (platform === 'darwin' && arch === 'arm64') return `${prefix}-macos-arm64`;
  return null;
}

export async function ensureVendoredBinary({ packageRoot, artifactName }) {
  const vendorDir = join(packageRoot, 'vendor');
  const destination = join(vendorDir, artifactName);
  if (isExecutable(destination)) {
    return destination;
  }

  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const releaseBaseUrl =
    process.env.GOODVIBES_RELEASE_BASE_URL?.trim() ||
    `${resolveRepositoryBaseUrl(pkg)}/releases/download/v${pkg.version}`;

  mkdirSync(vendorDir, { recursive: true });

  const checksumText = await downloadText(`${releaseBaseUrl}/SHA256SUMS.txt`);
  writeFileSync(join(vendorDir, 'SHA256SUMS.txt'), checksumText);
  const checksums = parseChecksumFile(checksumText);

  const tempDestination = `${destination}.download`;
  rmSync(tempDestination, { force: true });

  try {
    const binary = await downloadBuffer(`${releaseBaseUrl}/${artifactName}`);
    const actual = sha256(binary);
    const expected = checksums.get(artifactName);
    if (expected && expected !== actual) {
      throw new Error(`checksum mismatch for ${artifactName}: expected ${expected}, got ${actual}`);
    }
    writeFileSync(tempDestination, binary);
    prepareBinary(tempDestination);
    rmSync(destination, { force: true });
    writeFileSync(destination, readFileSync(tempDestination));
    prepareBinary(destination);
  } finally {
    rmSync(tempDestination, { force: true });
  }

  return destination;
}

function fileExists(path) {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function prepareBinary(path) {
  if (process.platform !== 'win32') {
    chmodSync(path, 0o755);
  }
}

function resolveRepositoryBaseUrl(pkg) {
  const repositoryUrl = typeof pkg.repository?.url === 'string' ? pkg.repository.url : '';
  const normalized = repositoryUrl
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  if (!normalized.startsWith('https://github.com/')) {
    throw new Error(`unsupported repository URL for binary downloads: ${repositoryUrl || '(missing)'}`);
  }
  return normalized;
}

async function downloadText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  return await response.text();
}

async function downloadBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseChecksumFile(contents) {
  const checksums = new Map();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match) continue;
    checksums.set(match[2], match[1].toLowerCase());
  }
  return checksums;
}
