#!/usr/bin/env bun
/**
 * sdk-dev — rapid local SDK development for the TUI.
 *
 * `link`    Build the local SDK checkout (~/Projects/goodvibes-sdk) and overlay
 *           its packages/sdk/dist (and package.json) into this repo's
 *           node_modules/@pellux/goodvibes-sdk, so SDK changes are testable in
 *           the TUI immediately — no npm release round-trip.
 * `status`  Report whether the overlay is active and what it was built from.
 * `restore` Remove the overlay and reinstall the pinned npm version byte-exact.
 *
 * The overlay writes a marker file (.local-sdk-overlay.json) inside the
 * package directory. Release tooling (scripts/release.ts preflight and
 * scripts/publish-check.ts) hard-fails while the marker exists or while the
 * package.json dependency is anything but an exact semver — so the fast path
 * cannot leak into a release. CI is immune regardless: it fresh-installs from
 * the lockfile.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const TUI_ROOT = process.cwd();
const SDK_ROOT = process.env.GOODVIBES_SDK_PATH ?? resolve(homedir(), 'Projects/goodvibes-sdk');
const INSTALLED_PKG = join(TUI_ROOT, 'node_modules/@pellux/goodvibes-sdk');
const MARKER = join(INSTALLED_PKG, '.local-sdk-overlay.json');

// The local SDK is a monorepo; the TUI consumes the main package AND several
// sibling contract/transport packages. The overlay MUST refresh ALL of them
// together. Refreshing only goodvibes-sdk leaves the sibling packages at their
// stale published build — so any test that drives the REAL HTTP client
// (@pellux/goodvibes-operator-sdk, whose JSON-schema validator reads the
// generated contract from @pellux/goodvibes-contracts) validates the local
// SDK's records against an OLD wire schema. Found in S3b: transport-parity
// rejected the Wave-1 `project` field because only goodvibes-sdk was overlaid.
// Each entry maps a node_modules basename to its packages/<dir> in the SDK.
const OVERLAY_PACKAGES: ReadonlyArray<{ readonly nm: string; readonly dir: string }> = [
  { nm: 'goodvibes-sdk', dir: 'sdk' },
  { nm: 'goodvibes-contracts', dir: 'contracts' },
  { nm: 'goodvibes-errors', dir: 'errors' },
  { nm: 'goodvibes-operator-sdk', dir: 'operator-sdk' },
  { nm: 'goodvibes-peer-sdk', dir: 'peer-sdk' },
  { nm: 'goodvibes-daemon-sdk', dir: 'daemon-sdk' },
  { nm: 'goodvibes-transport-core', dir: 'transport-core' },
  { nm: 'goodvibes-transport-http', dir: 'transport-http' },
  { nm: 'goodvibes-transport-realtime', dir: 'transport-realtime' },
];

// Overlay one monorepo package's dist + package.json into node_modules.
// MUST unlink package.json before copying: bun hardlinks node_modules files to
// its global cache, and an in-place overwrite writes THROUGH the hardlink —
// silently poisoning the machine-wide cache entry for the pinned version (found
// by WO-0B). The dist rmSync above breaks those links first, so the dist copy
// is safe. Returns false when the package is not installed / not built (skip).
function overlayPackage(pkg: { readonly nm: string; readonly dir: string }): boolean {
  const installed = join(TUI_ROOT, 'node_modules/@pellux', pkg.nm);
  const dist = join(SDK_ROOT, 'packages', pkg.dir, 'dist');
  const pkgJson = join(SDK_ROOT, 'packages', pkg.dir, 'package.json');
  if (!existsSync(installed) || !existsSync(dist)) return false;
  rmSync(join(installed, 'dist'), { recursive: true, force: true });
  cpSync(dist, join(installed, 'dist'), { recursive: true });
  rmSync(join(installed, 'package.json'), { force: true });
  cpSync(pkgJson, join(installed, 'package.json'));
  return true;
}

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function fail(msg: string): never {
  console.error(`sdk-dev: ${msg}`);
  process.exit(1);
}

function link(): void {
  if (!existsSync(SDK_ROOT)) fail(`local SDK checkout not found at ${SDK_ROOT} (set GOODVIBES_SDK_PATH to override)`);
  if (!existsSync(INSTALLED_PKG)) fail('node_modules/@pellux/goodvibes-sdk missing — run bun install first');

  const sha = sh('git rev-parse --short HEAD', SDK_ROOT);
  const branch = sh('git rev-parse --abbrev-ref HEAD', SDK_ROOT);
  const dirty = sh('git status --porcelain', SDK_ROOT) ? 'dirty' : 'clean';

  console.log(`sdk-dev: building local SDK (${branch}@${sha}, ${dirty} tree)...`);
  execSync('bun run build && bun run prepare:sdk', { cwd: SDK_ROOT, stdio: 'inherit' });
  if (!existsSync(join(SDK_ROOT, 'packages/sdk/dist'))) fail('SDK build produced no dist at packages/sdk/dist');

  const overlaid: string[] = [];
  for (const pkg of OVERLAY_PACKAGES) {
    if (overlayPackage(pkg)) overlaid.push(pkg.nm);
  }
  if (!overlaid.includes('goodvibes-sdk')) fail('goodvibes-sdk overlay failed — is node_modules populated?');
  console.log(`sdk-dev: overlaid ${overlaid.length} package(s): ${overlaid.join(', ')}`);

  writeFileSync(MARKER, JSON.stringify({
    sourcePath: SDK_ROOT,
    sdkGit: `${branch}@${sha} (${dirty})`,
    overlaidAt: new Date().toISOString(),
    overlaidPackages: overlaid,
    note: 'Local SDK overlay active. Run `bun scripts/sdk-dev.ts restore` before releasing; release gates fail while this file exists.',
  }, null, 2));

  console.log(`sdk-dev: LINKED — TUI now runs the local SDK (${branch}@${sha}, ${dirty}).`);
  console.log('sdk-dev: run `bun scripts/sdk-dev.ts restore` to return to the pinned npm version.');
}

function status(): void {
  if (existsSync(MARKER)) {
    const m = JSON.parse(readFileSync(MARKER, 'utf8'));
    console.log(`sdk-dev: OVERLAY ACTIVE — ${m.sdkGit}, overlaid ${m.overlaidAt} from ${m.sourcePath}`);
    process.exit(2);
  }
  const pkg = JSON.parse(readFileSync(join(INSTALLED_PKG, 'package.json'), 'utf8'));
  console.log(`sdk-dev: clean — npm @pellux/goodvibes-sdk@${pkg.version} installed.`);
}

function restore(): void {
  if (!existsSync(MARKER)) {
    console.log('sdk-dev: no overlay active; nothing to restore.');
    return;
  }
  console.log('sdk-dev: removing overlay and reinstalling from lockfile...');
  // Remove every package the overlay may have touched (the marker records what
  // was overlaid; fall back to the full set for markers written before this
  // field existed) so no sibling is left at the local build after restore.
  let overlaidPackages: string[];
  try {
    const parsed = JSON.parse(readFileSync(MARKER, 'utf8')) as { overlaidPackages?: unknown };
    overlaidPackages = Array.isArray(parsed.overlaidPackages)
      ? parsed.overlaidPackages.filter((v): v is string => typeof v === 'string')
      : OVERLAY_PACKAGES.map((p) => p.nm);
  } catch {
    overlaidPackages = OVERLAY_PACKAGES.map((p) => p.nm);
  }
  for (const nm of overlaidPackages) {
    rmSync(join(TUI_ROOT, 'node_modules/@pellux', nm), { recursive: true, force: true });
  }
  execSync('bun install', { cwd: TUI_ROOT, stdio: 'inherit' });
  if (existsSync(MARKER)) fail('marker still present after reinstall — restore failed');
  const pkg = JSON.parse(readFileSync(join(INSTALLED_PKG, 'package.json'), 'utf8'));
  const pinned = JSON.parse(readFileSync(join(TUI_ROOT, 'package.json'), 'utf8')).dependencies['@pellux/goodvibes-sdk'];
  if (pkg.version !== pinned) fail(`restored version ${pkg.version} does not match pinned ${pinned}`);
  console.log(`sdk-dev: RESTORED — npm @pellux/goodvibes-sdk@${pkg.version}.`);
}

const cmd = process.argv[2];
if (cmd === 'link') link();
else if (cmd === 'status') status();
else if (cmd === 'restore') restore();
else {
  console.log('usage: bun scripts/sdk-dev.ts <link|status|restore>');
  process.exit(cmd ? 1 : 0);
}
