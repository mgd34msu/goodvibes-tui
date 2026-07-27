/**
 * goodvibes-home.ts — where this process's GoodVibes tree lives, resolved in
 * ONE place for every entry point.
 *
 * ## The defect this closes
 *
 * `GOODVIBES_HOME` relocates the tree root. It was read by exactly one file —
 * `src/daemon/cli.ts` — and the CLIENT entry point (`src/main.ts`) called
 * `homedir()` unconditionally, on the same object literal where it did honour
 * `GOODVIBES_WORKING_DIR`. So a harness that set `GOODVIBES_HOME` to a
 * throwaway directory and then ran a client command got a process that read and
 * wrote the REAL tree: settings, workspace state, and — because the daemon-tier
 * secret store is derived from the tree root — `~/.goodvibes/daemon/secrets.enc`.
 *
 * That is not hypothetical. An isolated round stored two throwaway credentials
 * and they landed in the owner's live secret store, where they had to be
 * removed by hand. An isolation boundary a process can walk out of is not a
 * boundary; the honest fix is that no entry point resolves a home of its own.
 *
 * ## What each variable means
 *
 *  - `GOODVIBES_HOME` — the tree ROOT, the directory `.goodvibes/` sits under.
 *    Setting it relocates settings, workspace, discovery roots, and every tier
 *    of the secret store. This is what an isolated harness or a service unit
 *    sets.
 *  - `GOODVIBES_DAEMON_HOME` — the daemon's own IDENTITY directory (auth users,
 *    operator tokens, daemon settings). It falls under the tree root unless set
 *    separately, and it names only that directory: it is not a second way to
 *    move the tree. Both entry points resolve it the same way now, so a client
 *    given only this variable no longer computes the daemon-tier secret path
 *    from the real home while everything else points at a sandbox.
 *
 * Both readers take `env` as an argument rather than reaching for
 * `process.env`, so the resolution is exercisable without a test having to
 * mutate the environment of the process running it.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** The two roots every surface derives its storage from. */
export interface GoodVibesHomeOwnership {
  /** The tree root: the directory `.goodvibes/` sits under. */
  readonly homeDirectory: string;
  /** The daemon's own identity directory, under the tree root by default. */
  readonly daemonHomeDirectory: string;
}

/**
 * The tree root for this process.
 *
 * A blank or whitespace-only value is treated as absent rather than as the
 * empty path, because `GOODVIBES_HOME=` in a unit file or a shell wrapper means
 * "unset", and resolving it to `''` would put the whole tree at the filesystem
 * root.
 */
export function resolveGoodVibesHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['GOODVIBES_HOME']?.trim();
  if (override) return isAbsolute(override) ? override : resolve(process.cwd(), override);
  // The login home comes from the injected env first so the whole resolution is
  // exercisable without a test mutating the environment it is running in. This
  // is not a behaviour change: on Linux and macOS `homedir()` already prefers
  // $HOME, and where it does not (Windows, where HOME is usually unset) the
  // fallback below is what answers.
  const loginHome = env['HOME']?.trim();
  return loginHome ? loginHome : homedir();
}

/**
 * The daemon's identity directory.
 *
 * @param homeDirectory - The already-resolved tree root, so a caller cannot
 *   accidentally combine an overridden root with a default daemon home.
 */
export function resolveGoodVibesDaemonHome(
  homeDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env['GOODVIBES_DAEMON_HOME']?.trim();
  if (!override) return join(homeDirectory, '.goodvibes', 'daemon');
  return isAbsolute(override) ? override : resolve(process.cwd(), override);
}

/** Both roots at once — what an entry point wants. */
export function resolveGoodVibesHomeOwnership(
  env: NodeJS.ProcessEnv = process.env,
): GoodVibesHomeOwnership {
  const homeDirectory = resolveGoodVibesHome(env);
  return {
    homeDirectory,
    daemonHomeDirectory: resolveGoodVibesDaemonHome(homeDirectory, env),
  };
}
