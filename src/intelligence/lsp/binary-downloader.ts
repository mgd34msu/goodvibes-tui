/**
 * BinaryDownloader — downloads and caches platform-specific LSP server binaries.
 *
 * Binaries are cached in .goodvibes/bin/ relative to the project root.
 * Downloads happen lazily on first use and are skipped if the binary already exists.
 * Never throws — returns null on any failure so callers can fall back gracefully.
 */

import { existsSync, mkdirSync, chmodSync, unlinkSync, renameSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger.ts';

function getBinDir(): string {
  return join(process.cwd(), '.goodvibes', 'bin');
}

/** Platform + arch key for download URL resolution. */
type PlatformKey = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';

function getPlatformKey(): PlatformKey | null {
  const platform = process.platform;
  const arch = process.arch;
  // Windows is not supported — goodvibes-tui targets Linux and macOS only.
  // Windows users would need WSL.

  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  return null;
}

interface BinarySpec {
  /** Binary name (used as filename in .goodvibes/bin/) */
  name: string;
  /** GitHub repo in owner/repo format */
  repo: string;
  /** Map from PlatformKey to the asset filename pattern in GitHub releases */
  assets: Record<PlatformKey, string>;
  /** Whether the downloaded asset is a gzip file that needs decompression */
  gzip?: boolean;
}

/**
 * rust-analyzer: Downloads from rust-lang/rust-analyzer GitHub releases.
 * Assets are gzipped single binaries with SHA256 sidecar files for verification.
 *
 * gopls: Not available as prebuilt binary. Installed via `go install` if Go is
 * on PATH — see ensureGopls(). If Go is not installed, gopls is unavailable.
 */
const BINARY_SPECS: BinarySpec[] = [
  {
    name: 'rust-analyzer',
    repo: 'rust-lang/rust-analyzer',
    assets: {
      'linux-x64': 'rust-analyzer-x86_64-unknown-linux-gnu.gz',
      'linux-arm64': 'rust-analyzer-aarch64-unknown-linux-gnu.gz',
      'darwin-x64': 'rust-analyzer-x86_64-apple-darwin.gz',
      'darwin-arm64': 'rust-analyzer-aarch64-apple-darwin.gz',
    },
    gzip: true,
  },
];

// gopls is handled separately via `go install` — see ensureGopls()

/**
 * Get the path where a binary would be cached.
 */
export function getBinaryPath(name: string): string {
  return join(getBinDir(), name);
}

/**
 * Check if a binary is already downloaded and cached.
 */
export function isBinaryCached(name: string): boolean {
  return existsSync(getBinaryPath(name));
}

/**
 * Download a binary from GitHub releases (latest).
 * Returns the path to the downloaded binary, or null on failure.
 */
export async function downloadBinary(name: string): Promise<string | null> {
  const spec = BINARY_SPECS.find(s => s.name === name);
  if (!spec) {
    logger.debug(`BinaryDownloader: unknown binary '${name}'`);
    return null;
  }

  const platformKey = getPlatformKey();
  if (!platformKey) {
    logger.debug(`BinaryDownloader: unsupported platform ${process.platform}/${process.arch}`);
    return null;
  }

  const assetName = spec.assets[platformKey];
  if (!assetName) {
    logger.debug(`BinaryDownloader: no asset for ${name} on ${platformKey}`);
    return null;
  }

  const destPath = getBinaryPath(name);

  // Already cached
  if (existsSync(destPath)) {
    return destPath;
  }

  logger.info(`BinaryDownloader: downloading ${name} for ${platformKey}...`);

  try {
    // Fetch latest release from GitHub API
    const releaseUrl = `https://api.github.com/repos/${spec.repo}/releases/latest`;
    const releaseRes = await fetch(releaseUrl, {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'goodvibes-tui' },
      signal: AbortSignal.timeout(15000),
    });

    if (!releaseRes.ok) {
      if (releaseRes.status === 403) {
        logger.info('BinaryDownloader: GitHub API rate limited (60 req/hr unauthenticated). Set GITHUB_TOKEN env var for higher limits.', { name });
      } else {
        logger.debug(`BinaryDownloader: GitHub API returned ${releaseRes.status} for ${name}`);
      }
      return null;
    }

    const release = await releaseRes.json() as { assets?: Array<{ name: string; browser_download_url: string }> };
    if (!release || !Array.isArray(release.assets)) {
      logger.debug('BinaryDownloader: unexpected GitHub API response shape', { name });
      return null;
    }
    const asset = release.assets.find(a => a.name === assetName);

    if (!asset) {
      logger.debug(`BinaryDownloader: asset '${assetName}' not found in latest release of ${spec.repo}`);
      return null;
    }

    // Download the asset
    const downloadRes = await fetch(asset.browser_download_url, {
      signal: AbortSignal.timeout(120000), // 2 min for large binaries
      headers: { 'User-Agent': 'goodvibes-tui' },
    });

    if (!downloadRes.ok) {
      logger.debug(`BinaryDownloader: download failed with ${downloadRes.status}`);
      return null;
    }

    // Fetch the raw bytes first so we can verify SHA256 before decompression
    const rawBytes = await downloadRes.arrayBuffer();

    // SHA256 verification — rust-analyzer publishes .sha256 sidecar files
    const sha256Asset = release.assets?.find(a => a.name === assetName + '.sha256');
    if (sha256Asset) {
      const sha256Res = await fetch(sha256Asset.browser_download_url, {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'goodvibes-tui' },
      });
      if (sha256Res.ok) {
        const expectedHash = (await sha256Res.text()).trim().split(/\s+/)[0]; // format: "hash  filename"
        if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
          logger.info('BinaryDownloader: SHA256 sidecar has malformed hash, skipping verification', { name, raw: expectedHash?.slice(0, 80) });
        } else {
          const hasher = new Bun.CryptoHasher('sha256');
          hasher.update(new Uint8Array(rawBytes));
          const actualHash = hasher.digest('hex');
          if (actualHash !== expectedHash) {
            logger.error('BinaryDownloader: SHA256 mismatch — download may be corrupted or tampered', {
              name, expected: expectedHash, actual: actualHash,
            });
            return null;
          }
          logger.debug('BinaryDownloader: SHA256 verified', { name });
        }
      } else {
        logger.info('BinaryDownloader: SHA256 sidecar not available, proceeding without verification', { name });
      }
    } else {
      logger.info('BinaryDownloader: no SHA256 sidecar in release, proceeding without verification', { name });
    }

    // Ensure bin directory exists
    mkdirSync(getBinDir(), { recursive: true });

    const tmpPath = `${destPath}.tmp`;

    if (spec.gzip) {
      // Note: gunzipSync is used here intentionally. This code only runs once per binary
      // (on first use, not during normal operation). The ~1-2 second block during
      // decompression is acceptable for a one-time download that produces a cached result.
      const decompressed = Bun.gunzipSync(new Uint8Array(rawBytes));
      await Bun.write(tmpPath, decompressed);
    } else {
      // Write directly
      await Bun.write(tmpPath, rawBytes);
    }

    // Make executable
    chmodSync(tmpPath, 0o755);

    // Atomic rename
    renameSync(tmpPath, destPath);

    logger.info(`BinaryDownloader: ${name} downloaded to ${destPath}`);
    return destPath;
  } catch (err) {
    logger.debug(`BinaryDownloader: failed to download ${name}`, { error: String(err) });
    // Clean up partial download
    const tmpPath = `${destPath}.tmp`;
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Ensure gopls is available by running `go install` if `go` is on PATH.
 * Installs to .goodvibes/bin/ by setting GOBIN.
 * Returns the path to gopls, or null if go is not installed or install fails.
 */
export async function ensureGopls(): Promise<string | null> {
  const destPath = getBinaryPath('gopls');

  // Already cached
  if (existsSync(destPath)) {
    return destPath;
  }

  // Check if go is available
  const goPath = Bun.which('go');
  if (!goPath) {
    logger.debug('BinaryDownloader: go not found on PATH, cannot install gopls');
    return null;
  }

  logger.info('BinaryDownloader: installing gopls via go install...');

  try {
    mkdirSync(getBinDir(), { recursive: true });

    const proc = Bun.spawn(['go', 'install', 'golang.org/x/tools/gopls@latest'], {
      env: { ...process.env, GOBIN: getBinDir() },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      logger.debug('BinaryDownloader: gopls install failed', { exitCode, stderr: stderr.slice(0, 500) });
      return null;
    }

    if (existsSync(destPath)) {
      logger.info(`BinaryDownloader: gopls installed to ${destPath}`);
      return destPath;
    }

    return null;
  } catch (err) {
    logger.debug('BinaryDownloader: gopls install error', { error: String(err) });
    return null;
  }
}

/**
 * Ensure a binary is available — download if needed.
 * Returns the path to the binary, or null if unavailable.
 */
export async function ensureBinary(name: string): Promise<string | null> {
  // Check cache first
  const cached = getBinaryPath(name);
  if (existsSync(cached)) return cached;

  // Special handling for gopls
  if (name === 'gopls') {
    return ensureGopls();
  }

  // Download from GitHub
  return downloadBinary(name);
}
