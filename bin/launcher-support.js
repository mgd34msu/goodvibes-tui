import { accessSync, chmodSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SUPPORTED_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];

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

export function resolveArtifactName(kind, platform, arch) {
  const prefix = kind === 'daemon' ? 'goodvibes-daemon' : 'goodvibes';
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
