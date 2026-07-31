#!/usr/bin/env bun
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKSUM_MANIFEST_NAME, parseChecksumFile, resolveArtifactNames, sha256, verifyChecksum } from '../src/runtime/release-artifacts.ts';

// Platform package names, mirrored from scripts/platform-packages.ts, keyed by
// `${process.platform}-${node-arch}`.
const PLATFORM_PACKAGE_NAMES = {
  'linux-x64': '@pellux/goodvibes-tui-linux-x64',
  'linux-arm64': '@pellux/goodvibes-tui-linux-arm64',
  'darwin-x64': '@pellux/goodvibes-tui-darwin-x64',
  'darwin-arm64': '@pellux/goodvibes-tui-darwin-arm64',
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const home = homedir();
const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const noDownload = process.argv.includes('--no-download') || process.env.GOODVIBES_SKIP_BINARY_DOWNLOAD === '1';

function isSourceCheckout() {
  return existsSync(join(projectRoot, '.git')) || existsSync(join(projectRoot, 'bun.lock'));
}

function prepareBinary(path) {
  if (process.platform !== 'win32') {
    chmodSync(path, 0o755);
  }
}

function resolveRepositoryBaseUrl() {
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

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

async function downloadText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  return await response.text();
}

/**
 * Copy the prebuilt binary (and sqlite-vec addon, if present) out of the
 * installed platform package into vendor/. Returns true when it handled the
 * install, false when no platform package is available (fall back to download).
 *
 * The daemon binary is NOT here any more. The daemon is its own product with
 * its own npm package (`goodvibes-daemon`), which this package declares as a
 * dependency — so an npm install still brings the whole suite, and the daemon's
 * own postinstall places the daemon's own binary. Two packages each placing
 * a copy of `goodvibes-daemon` is exactly how a machine ends up with two.
 */
function installFromPlatformPackage(artifacts, vendorDir) {
  const pkgName = PLATFORM_PACKAGE_NAMES[`${process.platform}-${process.arch}`];
  if (!pkgName) return false;

  let pkgBinDir;
  try {
    const require = createRequire(join(projectRoot, 'package.json'));
    const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
    pkgBinDir = join(dirname(pkgJsonPath), 'bin');
  } catch {
    return false;
  }

  const app = join(pkgBinDir, artifacts.app);
  if (!existsSync(app)) {
    return false;
  }

  const destination = join(vendorDir, artifacts.app);
  rmSync(destination, { force: true });
  copyFileSync(app, destination);
  prepareBinary(destination);

  // Carry the sqlite-vec native addon (bin/lib/...) beside the vendored binary
  // so semantic memory keeps working (resolved as <execDir>/lib/...).
  const libSrc = join(pkgBinDir, 'lib');
  if (existsSync(libSrc)) {
    cpSync(libSrc, join(vendorDir, 'lib'), { recursive: true });
  }

  console.log(`postinstall: installed binaries from ${pkgName} (registry integrity, no download)`);
  return true;
}

async function installPlatformBinaries() {
  const artifacts = resolveArtifactNames(process.platform, process.arch);
  if (!artifacts) {
    console.log(`postinstall: no prebuilt binaries for ${process.platform}-${process.arch}; skipping binary install`);
    return;
  }

  if (noDownload) {
    console.log('postinstall: skipping binary install (--no-download)');
    return;
  }

  if (isSourceCheckout()) {
    console.log('postinstall: source checkout detected; skipping release-binary install');
    return;
  }

  const vendorDir = join(projectRoot, 'vendor');
  mkdirSync(vendorDir, { recursive: true });

  const localSourceDir = process.env.GOODVIBES_ASSET_SOURCE_DIR?.trim();
  if (localSourceDir) {
    const sourcePath = join(localSourceDir, artifacts.app);
    if (!existsSync(sourcePath)) {
      throw new Error(`missing local release artifact for postinstall smoke: ${sourcePath}`);
    }
    const destination = join(vendorDir, artifacts.app);
    copyFileSync(sourcePath, destination);
    prepareBinary(destination);
    console.log(`postinstall: installed the local smoke-test binary for ${process.platform}-${process.arch}`);
    return;
  }

  // Prefer the platform package (@pellux/goodvibes-tui-<os>-<arch>): the package
  // manager installed it with registry integrity and no lifecycle script, so its
  // binaries need no checksum download here. Copy them into vendor/ so the bin/
  // launchers find them on the fast path.
  if (installFromPlatformPackage(artifacts, vendorDir)) {
    return;
  }

  const releaseBaseUrl =
    process.env.GOODVIBES_RELEASE_BASE_URL?.trim() ||
    `${resolveRepositoryBaseUrl()}/releases/download/v${pkg.version}`;

  const checksumUrl = `${releaseBaseUrl}/SHA256SUMS.txt`;
  const checksumText = await downloadText(checksumUrl);
  writeFileSync(join(vendorDir, 'SHA256SUMS.txt'), checksumText);
  const checksums = parseChecksumFile(checksumText);

  const artifactName = artifacts.app;
  const destination = join(vendorDir, artifactName);
  const tempDestination = `${destination}.download`;
  rmSync(tempDestination, { force: true });
  await downloadFile(`${releaseBaseUrl}/${artifactName}`, tempDestination);
  const actual = sha256(readFileSync(tempDestination));
  const expected = checksums.get(artifactName);
  try {
    verifyChecksum(artifactName, actual, expected);
  } catch (error) {
    rmSync(tempDestination, { force: true });
    throw error;
  }
  rmSync(destination, { force: true });
  copyFileSync(tempDestination, destination);
  rmSync(tempDestination, { force: true });
  prepareBinary(destination);

  console.log(`postinstall: installed the release binary for ${process.platform}-${process.arch}`);
}

function deployBundledFiles() {
  const targets = [
    { src: join(projectRoot, '.goodvibes', 'skills'), dest: join(home, '.goodvibes', 'tui', 'skills') },
    { src: join(projectRoot, '.goodvibes', 'agents'), dest: join(home, '.goodvibes', 'tui', 'agents') },
  ];

  let installed = 0;
  let skipped = 0;

  for (const { src, dest } of targets) {
    if (!existsSync(src)) continue;

    const entries = readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);

      if (existsSync(destPath)) {
        skipped++;
        continue;
      }

      mkdirSync(dest, { recursive: true });

      if (entry.isDirectory()) {
        cpSync(srcPath, destPath, { recursive: true });
        console.log(`  installed: ${entry.name}/`);
        installed++;
      } else if (entry.name.endsWith('.md')) {
        cpSync(srcPath, destPath);
        console.log(`  installed: ${entry.name}`);
        installed++;
      }
    }
  }

  const goodvibesSrc = join(projectRoot, '.goodvibes', 'GOODVIBES.md');
  const goodvibesDest = join(home, '.goodvibes', 'GOODVIBES.md');
  if (existsSync(goodvibesSrc) && !existsSync(goodvibesDest)) {
    mkdirSync(join(home, '.goodvibes'), { recursive: true });
    copyFileSync(goodvibesSrc, goodvibesDest);
    console.log(`  installed: ${basename(goodvibesDest)}`);
    installed++;
  } else if (existsSync(goodvibesDest)) {
    skipped++;
  }

  if (installed > 0 || skipped > 0) {
    console.log(`postinstall: ${installed} installed, ${skipped} already exist (skipped)`);
  } else {
    console.log('postinstall: nothing to deploy');
  }
}

/**
 * Put the wake-word model on the machine as part of installing.
 *
 * Everything needed to detect "hey goodvibes" already shipped, and provisioning
 * was reachable only by typing `/voice wake setup` — so the ordinary outcome of
 * installing was a wake word that could not start. The pins (URLs, byte counts,
 * checksums) live in the SDK's wake-word manifest and stay there; this calls the
 * SDK's install policy, which:
 *
 *   - never throws (an absent network, DNS, a proxy serving HTML, an unwritable
 *     home directory and a provisioner that itself threw all come back as an
 *     outcome), so a failed download CANNOT fail this install;
 *   - reaps a torn artifact before retrying, so a killed attempt converges;
 *   - reports one plain line, printed below either way.
 *
 * A failure degrades to exactly the previous behaviour: the feature reports
 * not-provisioned by content, `/voice wake setup` fetches it, and a running
 * daemon retries at every boot.
 *
 * It honours the same skip switches as the binary install (`--no-download`,
 * GOODVIBES_SKIP_BINARY_DOWNLOAD) plus its own
 * GOODVIBES_SKIP_WAKE_MODEL_DOWNLOAD, and it stays out of a source checkout for
 * the same reason the binary install does — a repo clone is a development tree,
 * not an installation.
 */
async function installWakeWordModel() {
  if (noDownload) {
    console.log('postinstall: skipping the wake-word model (--no-download)');
    return;
  }
  if (isSourceCheckout()) {
    console.log('postinstall: source checkout detected; skipping the wake-word model install');
    return;
  }
  try {
    const { provisionWakeWordModelsAtInstall, resolveManagedVoiceRoot } =
      await import('@pellux/goodvibes-sdk/platform/voice');
    const outcome = await provisionWakeWordModelsAtInstall({
      managedRoot: resolveManagedVoiceRoot(home),
      recoveryHint: '/voice wake setup',
    });
    console.log(`postinstall: ${outcome.message}`);
  } catch (error) {
    // The policy is contracted not to throw, so reaching here means the import
    // itself failed (a partially installed dependency tree, most likely). Even
    // that is not a reason to fail the install of everything else.
    console.log(
      'postinstall: the wake-word model could not be installed '
      + `(${error instanceof Error ? error.message : String(error)}); everything else installed normally. `
      + 'Run /voice wake setup to fetch it, or leave it and the next daemon start tries again.',
    );
  }
}

async function main() {
  await installPlatformBinaries();
  deployBundledFiles();
  // Last, and never fatal: a wake-word model is not worth failing an install over.
  await installWakeWordModel();
}

// Guarded so this module can be imported by tests (to exercise
// verifyChecksum, parseChecksumFile, etc.) without triggering a real
// network install as a side effect of the import.
if (import.meta.main) {
  await main();
}

export { verifyChecksum, parseChecksumFile, sha256, resolveArtifactNames, CHECKSUM_MANIFEST_NAME, installWakeWordModel };
