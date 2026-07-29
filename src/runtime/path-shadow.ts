/**
 * path-shadow.ts — decide whether the copy of a command the updater maintains
 * is actually the copy the user's shell runs.
 *
 * OWNERSHIP: this is a verbatim copy of the SDK's canonical module,
 * `@pellux/goodvibes-sdk/platform/runtime/path-shadow`, which is where the
 * policy lives because more than one surface needs it (this TUI, the agent,
 * and the installer's POSIX sh statement of the same rules). The copy exists
 * only because the SDK release carrying that module has not been published
 * yet and this package pins an exact published version. When it publishes,
 * replace this file's body with a re-export of the SDK subpath — exactly the
 * shape update-check.ts already uses for the update policy — and delete
 * nothing else; the wiring in path-shadow-startup.ts and the tests in
 * src/test/runtime/path-shadow.test.ts keep working unchanged.
 *
 * The platform's update guarantee is "one verified swap mechanism, nothing
 * ever drifts". That guarantee holds only while there is exactly one copy of
 * each command reachable on PATH. When a second, older copy sits in a
 * directory that comes EARLIER on PATH than the install directory, the
 * updater keeps upgrading a file the user never reaches: `goodvibes-agent`
 * reports itself current, an older build answers the typing, and the product
 * looks like it is lying about its own capabilities. That is exactly what
 * happened with a leftover `~/.bun/bin/goodvibes-agent` link (1.18.1) sitting
 * at PATH position 2 while `~/.local/bin/goodvibes-agent` (1.21.0) sat at
 * position 21.
 *
 * This module is the one place that decides those facts. It is pure: every
 * filesystem and subprocess touch (does this file exist and is it runnable,
 * where does this symlink actually point, what does `<path> --version` say)
 * is injected, so the policy is provable under test with fake paths and no
 * real install. The surfaces wire the real I/O:
 *   - a client's startup check reports a shadow before anything else renders;
 *   - the installer's shell implementation (goodvibes-tui scripts/install.sh)
 *     mirrors these same rules in POSIX sh, because an installer cannot
 *     import TypeScript.
 *
 * Removal is deliberately conservative. A copy is only ever offered for
 * removal when it is recognisably one of OUR programs — a link into an
 * installed `@pellux/goodvibes-*` package, or a file that answers
 * `--version` with `<command> <semver>` — and only when it lives inside the
 * user's own home directory. Everything else is reported and left alone.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * How confident we are that a copy found on PATH is one of our own programs,
 * and therefore whether it is safe to offer to remove it.
 *
 *   - `install-target`: the copy living in the directory the installer and
 *     the auto-updater maintain. Never a removal candidate.
 *   - `package-link`: an entry that resolves into an installed
 *     `@pellux/goodvibes-*` package (a `bun add -g` / `npm i -g` link, or a
 *     project-local dependency link). Removed by uninstalling that package.
 *   - `our-binary`: a standalone file that answers `--version` with
 *     `<command> <semver>`, i.e. a previous standalone install of the same
 *     program. Removed by deleting the file.
 *   - `unknown`: anything we cannot positively identify, including anything
 *     outside the user's home directory. Reported, never removed.
 */
export type ShadowOwnership = 'install-target' | 'package-link' | 'our-binary' | 'unknown';

/** How a recognised copy is removed, and by what command. */
export interface ShadowRemoval {
  /** `package` = uninstall the owning package; `file` = delete the PATH entry itself. */
  readonly kind: 'package' | 'file';
  /** The `@pellux/...` package name, when `kind` is `package`. */
  readonly packageName?: string | undefined;
  /** The exact command a user (or the installer) runs to remove this copy. */
  readonly command: string;
}

/** One copy of a command found on PATH. */
export interface CommandCopy {
  /** The command name, e.g. `goodvibes-agent`. */
  readonly command: string;
  /** The PATH directory the copy was found in. */
  readonly directory: string;
  /** `<directory>/<command>` — the path the shell would execute. */
  readonly path: string;
  /** Zero-based position of `directory` in PATH. Lower wins. */
  readonly pathIndex: number;
  /** The symlink-resolved path, or `path` when it is not a link. */
  readonly resolvedPath: string;
  /** What `<path> --version` reported, when it could be probed. */
  readonly version?: string | undefined;
  readonly ownership: ShadowOwnership;
  /** Present only when `ownership` is `package-link` or `our-binary`. */
  readonly removal?: ShadowRemoval | undefined;
}

/** The reachability verdict for one command. */
export interface CommandShadowReport {
  readonly command: string;
  /** Every copy found, in PATH order. */
  readonly copies: readonly CommandCopy[];
  /** The copy the shell actually runs — the first on PATH. Absent when the command is not on PATH at all. */
  readonly winner?: CommandCopy | undefined;
  /** The copy in the install directory. Absent when the install directory is not on PATH. */
  readonly installed?: CommandCopy | undefined;
  /**
   * Copies that come earlier on PATH than the install directory's copy. A
   * non-empty list means the maintained install is unreachable by name.
   */
  readonly shadowing: readonly CommandCopy[];
  /** True when the install directory holds this command but is not on PATH at all. */
  readonly installDirNotOnPath: boolean;
}

/** The whole-install verdict across every command the installer maintains. */
export interface ShadowScanResult {
  readonly reports: readonly CommandShadowReport[];
  /** Commands whose maintained copy loses to an earlier PATH entry. */
  readonly shadowed: readonly CommandShadowReport[];
  /** True when any command is shadowed or the install directory is missing from PATH. */
  readonly hasProblem: boolean;
}

export interface ShadowScanInput {
  /** Command names the installer/updater maintains, e.g. `['goodvibes', 'goodvibes-daemon', 'goodvibes-agent']`. */
  readonly commands: readonly string[];
  /** The directory the installer writes to and the auto-updater swaps in place. */
  readonly installDir: string;
  /** PATH split into directories, in order, exactly as the shell would search them. */
  readonly pathEntries: readonly string[];
  /** The user's home directory. Nothing outside it is ever a removal candidate. */
  readonly homeDir: string;
  /** True when `path` exists and is a runnable file. */
  readonly isExecutableFile: (path: string) => boolean;
  /** Resolves a symlink chain; returns `path` unchanged when it is not a link or cannot be resolved. */
  readonly realPath: (path: string) => string;
  /**
   * Runs `<path> --version` and returns its first line, or undefined when it
   * cannot be run. Optional: without it, `our-binary` can never be
   * established and such copies stay `unknown` (reported, never removed).
   */
  readonly probeVersion?: ((path: string) => string | undefined) | undefined;
}

// ---------------------------------------------------------------------------
// PATH handling
// ---------------------------------------------------------------------------

/**
 * Splits a raw PATH string into directories in search order.
 *
 * Empty entries (from a leading, trailing, or doubled separator) mean "the
 * current directory" to a POSIX shell. They are dropped rather than resolved:
 * a cwd-relative hit is not a stable install anyone can reason about, and
 * treating it as one would produce a different verdict per directory.
 * Duplicated directories collapse to their first occurrence, which is the
 * only position that can ever win.
 */
export function splitPathEntries(rawPath: string | undefined, separator = ':'): string[] {
  if (!rawPath) return [];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const raw of rawPath.split(separator)) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    const normalized = stripTrailingSeparators(entry);
    if (normalized.length === 0) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    entries.push(normalized);
  }
  return entries;
}

/** Drops trailing `/` (or `\`) so `~/.local/bin` and `~/.local/bin/` are one directory. */
function stripTrailingSeparators(value: string): string {
  let end = value.length;
  while (end > 1 && (value[end - 1] === '/' || value[end - 1] === '\\')) end -= 1;
  return value.slice(0, end);
}

function joinPath(directory: string, name: string): string {
  return `${stripTrailingSeparators(directory)}/${name}`;
}

function segmentsOf(path: string): string[] {
  return path.split(/[\\/]/).filter((segment) => segment.length > 0);
}

/** True when `path` is `root` itself or lives underneath it. */
export function isWithinDirectory(path: string, root: string): boolean {
  const normalizedRoot = stripTrailingSeparators(root);
  if (normalizedRoot.length === 0) return false;
  const normalizedPath = stripTrailingSeparators(path);
  if (normalizedPath === normalizedRoot) return true;
  return normalizedPath.startsWith(`${normalizedRoot}/`);
}

// ---------------------------------------------------------------------------
// Ownership classification
// ---------------------------------------------------------------------------

/** The npm scope every package this platform publishes lives under. */
const PACKAGE_SCOPE = '@pellux';
/** Only `@pellux/goodvibes-*` packages are ours; a same-scope stranger is not assumed. */
const PACKAGE_PREFIX = 'goodvibes-';

/**
 * Extracts the owning `@pellux/goodvibes-*` package name from a resolved
 * path, by finding the LAST `node_modules` segment and reading the scoped
 * package directory that follows it. The last occurrence is the one that
 * owns the file: a nested `node_modules/a/node_modules/b/bin/x` belongs to
 * `b`, not `a`.
 */
export function owningPackageName(resolvedPath: string): string | undefined {
  const segments = segmentsOf(resolvedPath);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i] !== 'node_modules') continue;
    const scope = segments[i + 1];
    const name = segments[i + 2];
    if (scope !== PACKAGE_SCOPE || name === undefined) return undefined;
    if (!name.startsWith(PACKAGE_PREFIX)) return undefined;
    return `${scope}/${name}`;
  }
  return undefined;
}

/**
 * Picks the uninstall command for a package link, from where the package
 * actually lives. A bun global install lives under `.bun/install/global`;
 * everything else is treated as npm-managed, which is also the correct
 * advice for a `bun add -g` that used an npm-style prefix.
 */
function packageRemoval(packageName: string, resolvedPath: string): ShadowRemoval {
  const isBunGlobal = /[\\/]\.bun[\\/]install[\\/]global[\\/]/.test(resolvedPath)
    || segmentsOf(resolvedPath).includes('.bun');
  return {
    kind: 'package',
    packageName,
    command: isBunGlobal ? `bun remove -g ${packageName}` : `npm rm -g ${packageName}`,
  };
}

/**
 * True when a `--version` line is one of ours: `<command> <dotted numbers>`,
 * which is the exact shape every goodvibes command prints. Anything else —
 * an unrelated program that happens to share the name, a wrapper script, a
 * `--version` that errors — fails, and the copy stays `unknown`.
 */
export function versionLineIdentifiesCommand(line: string | undefined, command: string): string | undefined {
  if (!line) return undefined;
  const match = /^([A-Za-z0-9._-]+)[ \t]+v?(\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)\s*$/.exec(line.trim());
  if (!match) return undefined;
  if (match[1] !== command) return undefined;
  return match[2];
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

function classify(input: ShadowScanInput, copy: {
  readonly command: string;
  readonly directory: string;
  readonly path: string;
  readonly pathIndex: number;
  readonly resolvedPath: string;
}): { ownership: ShadowOwnership; removal?: ShadowRemoval | undefined; version?: string | undefined } {
  if (isWithinDirectory(copy.path, input.installDir)) {
    return { ownership: 'install-target', version: probe(input, copy.path, copy.command) };
  }

  const version = probe(input, copy.path, copy.command);

  // Nothing outside the user's own home is ever a removal candidate, however
  // confidently we recognise it: a system-wide copy is somebody else's to
  // manage, and this code must never reach outside the user's directories.
  const insideHome = isWithinDirectory(copy.path, input.homeDir)
    && isWithinDirectory(copy.resolvedPath, input.homeDir);

  const packageName = owningPackageName(copy.resolvedPath);
  if (packageName && insideHome) {
    return { ownership: 'package-link', removal: packageRemoval(packageName, copy.resolvedPath), version };
  }
  if (packageName) {
    return { ownership: 'unknown', version };
  }
  if (version !== undefined && insideHome) {
    return { ownership: 'our-binary', removal: { kind: 'file', command: `rm ${copy.path}` }, version };
  }
  return { ownership: 'unknown', version };
}

function probe(input: ShadowScanInput, path: string, command: string): string | undefined {
  if (!input.probeVersion) return undefined;
  try {
    return versionLineIdentifiesCommand(input.probeVersion(path), command);
  } catch {
    return undefined;
  }
}

function resolve(input: ShadowScanInput, path: string): string {
  try {
    return input.realPath(path);
  } catch {
    return path;
  }
}

function exists(input: ShadowScanInput, path: string): boolean {
  try {
    return input.isExecutableFile(path);
  } catch {
    return false;
  }
}

/** Scans PATH for every copy of every maintained command and decides which one wins. */
export function scanCommandShadows(input: ShadowScanInput): ShadowScanResult {
  const entries = input.pathEntries.map(stripTrailingSeparators).filter((entry) => entry.length > 0);
  const installDir = stripTrailingSeparators(input.installDir);
  const installDirOnPath = entries.some((entry) => entry === installDir);

  const reports: CommandShadowReport[] = [];
  for (const command of input.commands) {
    const copies: CommandCopy[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const directory = entries[index] as string;
      const path = joinPath(directory, command);
      if (!exists(input, path)) continue;
      const resolvedPath = resolve(input, path);
      const partial = { command, directory, path, pathIndex: index, resolvedPath };
      copies.push({ ...partial, ...classify(input, partial) });
    }

    const installedOnPath = copies.find((copy) => copy.ownership === 'install-target');
    // The install directory may hold the command while being absent from
    // PATH; that install is just as unreachable as a shadowed one.
    const installedOffPath = !installDirOnPath && exists(input, joinPath(installDir, command));

    const shadowing = installedOnPath
      ? copies.filter((copy) => copy.pathIndex < installedOnPath.pathIndex)
      : [];

    reports.push({
      command,
      copies,
      winner: copies[0],
      installed: installedOnPath,
      shadowing,
      installDirNotOnPath: installedOffPath,
    });
  }

  const shadowed = reports.filter((report) => report.shadowing.length > 0 || report.installDirNotOnPath);
  return { reports, shadowed, hasProblem: shadowed.length > 0 };
}

// ---------------------------------------------------------------------------
// Plain-words reporting
// ---------------------------------------------------------------------------

function describeVersion(copy: CommandCopy): string {
  return copy.version ? `version ${copy.version}` : 'version unknown';
}

/**
 * Renders one shadowed command as plain lines: which path wins, what version
 * each copy is, and the exact command that fixes it. No jargon, no severity
 * words — the user needs to know which file answers when they type the name.
 */
export function describeShadowReport(report: CommandShadowReport): string[] {
  const lines: string[] = [];
  if (report.installDirNotOnPath) {
    lines.push(
      `${report.command} is installed but its directory is not on your PATH, so typing "${report.command}" does not reach it.`,
    );
    return lines;
  }
  const winner = report.winner;
  const installed = report.installed;
  if (!winner || !installed) return lines;

  lines.push(
    `Typing "${report.command}" runs ${winner.path} (${describeVersion(winner)}), `
    + `not the copy this installer maintains at ${installed.path} (${describeVersion(installed)}).`,
  );
  for (const copy of report.shadowing) {
    if (copy.removal) {
      lines.push(`  ${copy.path} is a copy of our own program. Remove it with: ${copy.removal.command}`);
    } else {
      lines.push(
        `  ${copy.path} is not something we can identify as ours, so it will not be touched. `
        + `Remove or reorder it yourself, or put ${installed.directory} earlier on your PATH.`,
      );
    }
  }
  return lines;
}

/** Renders every problem in a scan, in command order. Empty when the scan is clean. */
export function describeShadowScan(result: ShadowScanResult): string[] {
  return result.shadowed.flatMap((report) => describeShadowReport(report));
}

/**
 * The copies a caller may offer to remove: recognised copies of our own
 * program that are shadowing the maintained install. Deduplicated by path,
 * since one leftover package install typically provides several commands.
 */
export function removableShadows(result: ShadowScanResult): CommandCopy[] {
  const byPath = new Map<string, CommandCopy>();
  for (const report of result.shadowed) {
    for (const copy of report.shadowing) {
      if (!copy.removal) continue;
      if (!byPath.has(copy.path)) byPath.set(copy.path, copy);
    }
  }
  return [...byPath.values()];
}
