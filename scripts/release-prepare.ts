#!/usr/bin/env bun
/**
 * release:prepare, the one command that makes a version bump complete.
 *
 * Every file that is generated from source, or that carries a version or a
 * pinned SHA, is rewritten here, at the bump, instead of being policed by a red
 * CI run on every push. A stale generated file is fixed by regenerating it; it
 * is not a regression.
 *
 * Usage:
 *   bun run release:prepare --patch | --minor | --major
 *   bun run release:prepare --version 2.2.0     bump to an exact version
 *   bun run release:prepare --no-bump           regenerate at the current version
 *   bun run release:prepare --no-bump --no-changelog
 *                                               the toolchain release-cut sync
 *                                               command (release-cut bumps the
 *                                               manifests and writes the
 *                                               changelog section itself)
 *   --no-install   skip the relock (offline, or the lockfile is already current)
 *   --no-pins      skip the workflow pin rewrite (offline)
 *
 * Steps, in dependency order:
 *   1. package.json version (unless --no-bump)
 *   2. relock: `bun install`, so bun.lock and node_modules resolve the pinned
 *      SDK, daemon and toolchain versions from package.json
 *   3. project surfaces, in a fresh process so they import the SDK the relock
 *      just installed (scripts/prebuild.ts): the src/version.ts fallback, the
 *      README badge, docs/foundation-artifacts, docs/commands-reference.md
 *   4. workflow pins: every `mgd34msu/goodvibes-sdk/.github/workflows/*.yml@<sha>`
 *      reference moves to the commit the pinned SDK version's tag points at,
 *      and every `@pellux/goodvibes-toolchain@<version>` moves to the
 *      devDependencies pin
 *   5. a `## [X.Y.Z] - YYYY-MM-DD` CHANGELOG section scaffold at the first
 *      `---` separator, when none exists for the version (unless --no-changelog)
 *
 * It never commits, tags or pushes. Review `git diff` afterwards and write the
 * release notes into the scaffolded section.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SDK_REPO_URL = 'https://github.com/mgd34msu/goodvibes-sdk';

export type BumpKind = 'patch' | 'minor' | 'major';

/** The next semver for a bump kind. Pre-release suffixes are dropped. */
export function bumpVersion(current: string, kind: BumpKind): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!match) throw new Error(`package.json version is not semver: ${current}`);
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Rewrites only the top-level "version" field, leaving the rest of the file's bytes alone. */
export function setManifestVersionText(text: string, version: string): string {
  const next = text.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`);
  if (next === text && !text.includes(`"version": "${version}"`)) {
    throw new Error('package.json has no top-level "version" field');
  }
  return next;
}

/**
 * CHANGELOG text with a section for `version` inserted directly under the first
 * `---` separator (this changelog's insert marker, the same one the toolchain
 * release-cut uses), or above the newest `## ` heading when there is no
 * separator. Unchanged when a section for the version already exists.
 */
export function scaffoldChangelogText(changelog: string, version: string, date: string): string {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^##\\s*\\[${escaped}\\]`, 'm').test(changelog)) return changelog;
  const section = `## [${version}] - ${date}\n\n### Changed\n\n- \n\n`;
  const separator = /^---[ \t]*\n/m.exec(changelog);
  if (separator) {
    const after = separator.index + separator[0].length;
    const blank = changelog.slice(after).match(/^\n*/)?.[0].length ?? 0;
    const at = after + blank;
    return `${changelog.slice(0, after)}\n${section}${changelog.slice(at)}`;
  }
  const first = changelog.search(/^## /m);
  if (first === -1) return `${changelog.trimEnd()}\n\n${section}`;
  return `${changelog.slice(0, first)}${section}${changelog.slice(first)}`;
}

/**
 * A workflow file with every SDK reusable-workflow reference pointed at
 * `sha` (the commit the SDK's `v<sdkVersion>` tag points at, with its trailing
 * `# sdk <version> release` note kept in step), and every pinned toolchain spec
 * set to `toolchainVersion`.
 */
export function rewriteWorkflowPins(
  text: string,
  pins: { readonly sdkVersion: string; readonly sdkSha: string | null; readonly toolchainVersion: string },
): string {
  let next = text.replace(
    /(@pellux\/goodvibes-toolchain@)\d+\.\d+\.\d+/g,
    `$1${pins.toolchainVersion}`,
  );
  if (pins.sdkSha !== null) {
    next = next.replace(
      /(mgd34msu\/goodvibes-sdk\/\.github\/workflows\/[\w.-]+\.ya?ml@)[0-9a-f]{40}( # sdk )\d+\.\d+\.\d+( release)?/g,
      `$1${pins.sdkSha}$2${pins.sdkVersion} release`,
    );
  }
  return next;
}

/** The commit a tag points at, from `git ls-remote` output (the peeled `^{}` line wins). */
export function peeledTagSha(lsRemoteOutput: string, tag: string): string | null {
  let direct: string | null = null;
  for (const line of lsRemoteOutput.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref || !/^[0-9a-f]{40}$/.test(sha)) continue;
    if (ref === `refs/tags/${tag}^{}`) return sha;
    if (ref === `refs/tags/${tag}`) direct = sha;
  }
  return direct;
}

interface PrepareArgs {
  readonly bump: BumpKind | { readonly exact: string } | null;
  readonly changelog: boolean;
  readonly install: boolean;
  readonly pins: boolean;
}

function parseArgs(argv: readonly string[]): PrepareArgs {
  const kinds = (['patch', 'minor', 'major'] as const).filter((kind) => argv.includes(`--${kind}`));
  const versionIdx = argv.indexOf('--version');
  const exact = versionIdx >= 0 ? argv[versionIdx + 1] : undefined;
  const noBump = argv.includes('--no-bump');
  const chosen = kinds.length + (versionIdx >= 0 ? 1 : 0) + (noBump ? 1 : 0);
  if (chosen !== 1 || (versionIdx >= 0 && (exact === undefined || !/^\d+\.\d+\.\d+$/.test(exact)))) {
    throw new Error('Usage: bun run release:prepare (--patch | --minor | --major | --version X.Y.Z | --no-bump) [--no-changelog] [--no-install] [--no-pins]');
  }
  return {
    bump: noBump ? null : exact !== undefined ? { exact } : kinds[0]!,
    changelog: !argv.includes('--no-changelog'),
    install: !argv.includes('--no-install'),
    pins: !argv.includes('--no-pins'),
  };
}

function run(label: string, command: string, args: readonly string[]): void {
  console.log(`[release:prepare] ${label}: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status ?? 'signal'})`);
}

function resolveSdkTagSha(sdkVersion: string): string {
  const tag = `v${sdkVersion}`;
  const result = spawnSync('git', ['ls-remote', SDK_REPO_URL, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  const sha = result.status === 0 ? peeledTagSha(result.stdout, tag) : null;
  if (!sha) {
    throw new Error(`could not resolve ${SDK_REPO_URL} tag ${tag}; rerun with network, or pass --no-pins and update the SHAs by hand`);
  }
  return sha;
}

function main(argv: readonly string[]): void {
  const args = parseArgs(argv);
  const pkgPath = join(ROOT, 'package.json');
  const pkgText = readFileSync(pkgPath, 'utf8');
  const current = (JSON.parse(pkgText) as { version: string }).version;

  let version = current;
  if (args.bump !== null) {
    version = typeof args.bump === 'string' ? bumpVersion(current, args.bump) : args.bump.exact;
    writeFileSync(pkgPath, setManifestVersionText(pkgText, version));
    console.log(`[release:prepare] package.json ${current} -> ${version}`);
  }

  if (args.install) run('relock', 'bun', ['install']);
  run('project surfaces', 'bun', ['run', 'scripts/prebuild.ts']);

  if (args.pins) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const sdkVersion = pkg.dependencies?.['@pellux/goodvibes-sdk'];
    const toolchainVersion = pkg.devDependencies?.['@pellux/goodvibes-toolchain'];
    if (!sdkVersion || !/^\d+\.\d+\.\d+$/.test(sdkVersion)) throw new Error(`@pellux/goodvibes-sdk is not pinned to an exact version: ${String(sdkVersion)}`);
    if (!toolchainVersion || !/^\d+\.\d+\.\d+$/.test(toolchainVersion)) throw new Error(`@pellux/goodvibes-toolchain is not pinned to an exact version: ${String(toolchainVersion)}`);
    const sdkSha = resolveSdkTagSha(sdkVersion);
    const workflowsDir = join(ROOT, '.github', 'workflows');
    for (const name of readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f))) {
      const path = join(workflowsDir, name);
      const before = readFileSync(path, 'utf8');
      const after = rewriteWorkflowPins(before, { sdkVersion, sdkSha, toolchainVersion });
      if (after !== before) {
        writeFileSync(path, after);
        console.log(`[release:prepare] .github/workflows/${name}: sdk ${sdkVersion} (${sdkSha.slice(0, 12)}), toolchain ${toolchainVersion}`);
      }
    }
  }

  if (args.changelog) {
    const changelogPath = join(ROOT, 'CHANGELOG.md');
    const before = readFileSync(changelogPath, 'utf8');
    const after = scaffoldChangelogText(before, version, new Date().toISOString().slice(0, 10));
    if (after !== before) {
      writeFileSync(changelogPath, after);
      console.log(`[release:prepare] CHANGELOG.md: scaffolded ## [${version}]; write the notes before pushing.`);
    } else {
      console.log(`[release:prepare] CHANGELOG.md already has a ## [${version}] section.`);
    }
  }
  console.log('[release:prepare] done; review `git diff`.');
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[release:prepare] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
