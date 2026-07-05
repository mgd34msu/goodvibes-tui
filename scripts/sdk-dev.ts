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
const SDK_PKG_DIST = join(SDK_ROOT, 'packages/sdk/dist');
const SDK_PKG_JSON = join(SDK_ROOT, 'packages/sdk/package.json');
const INSTALLED_PKG = join(TUI_ROOT, 'node_modules/@pellux/goodvibes-sdk');
const MARKER = join(INSTALLED_PKG, '.local-sdk-overlay.json');

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
  if (!existsSync(SDK_PKG_DIST)) fail(`SDK build produced no dist at ${SDK_PKG_DIST}`);

  console.log('sdk-dev: overlaying dist into node_modules/@pellux/goodvibes-sdk...');
  rmSync(join(INSTALLED_PKG, 'dist'), { recursive: true, force: true });
  cpSync(SDK_PKG_DIST, join(INSTALLED_PKG, 'dist'), { recursive: true });
  // package.json too, so new subpath exports added in the local SDK resolve.
  // MUST unlink before copying: bun hardlinks node_modules files to its global
  // cache, and an in-place overwrite writes THROUGH the hardlink — silently
  // poisoning the machine-wide cache entry for the pinned version (found by
  // WO-0B when porting this script; the dist copy above is safe because rmSync
  // breaks the links first).
  rmSync(join(INSTALLED_PKG, 'package.json'), { force: true });
  cpSync(SDK_PKG_JSON, join(INSTALLED_PKG, 'package.json'));

  writeFileSync(MARKER, JSON.stringify({
    sourcePath: SDK_ROOT,
    sdkGit: `${branch}@${sha} (${dirty})`,
    overlaidAt: new Date().toISOString(),
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
  rmSync(INSTALLED_PKG, { recursive: true, force: true });
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
