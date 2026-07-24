/**
 * `/update` — a real self-update path for binary installs. The
 * download-verify-swap mechanics are the SDK's canonical update policy
 * module (platform/runtime/self-update — hoisted from this file's
 * semantics), the same mechanism the daemon's hourly loop and
 * scripts/install.sh follow: one update mechanism everywhere. This file owns
 * only the /update UX: install-kind gating, target selection, and the
 * printed report.
 *
 * Subcommands:
 *   /update [check]           — resolve the latest release tag and report
 *                                whether this build is already current.
 *   /update apply              — for a binary install (scripts/install.sh),
 *                                download + verify + atomically swap the
 *                                app and daemon binaries, and refresh the
 *                                sqlite-vec native addon in lockstep so the
 *                                vector index never goes stale beside a new
 *                                binary. Every swap parks the outgoing file
 *                                at `<path>.previous`, so the replaced
 *                                version is always kept. For any other
 *                                install kind, prints the exact command to
 *                                run instead — it never attempts a swap it
 *                                can't do safely.
 *   /update rollback           — exchange each installed file with its kept
 *                                `.previous` counterpart: one command back to
 *                                the version that ran before the last update
 *                                (and, being an exchange, one more command
 *                                forward again).
 *   /update review              — install/subscription/sandbox posture,
 *                                unrelated to the update mechanics above.
 *   /update bundle export|inspect <path> — portable posture bundle, as before.
 *
 * The former `/update channel <stable|preview>` subcommand wrote a
 * release.channel config value that nothing downstream ever read — it only
 * ever changed what a later `/update review` printed back to you. It has
 * been removed rather than kept decorative; this repo's release process
 * (scripts/release.ts) does not publish separate stable/preview channels,
 * so there is no real channel selection to wire it to.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  applyVerifiedUpdate,
  realUpdateFileIo,
  rollbackKeptPrevious,
  type UpdateFileIo,
  type UpdateTarget,
} from '@pellux/goodvibes-sdk/platform/runtime/self-update';
import type { CommandRegistry } from '../command-registry.ts';
import { VERSION } from '../../version.ts';
import { listBuiltinSubscriptionProviders } from '@pellux/goodvibes-sdk/platform/config';
import {
  CHECKSUM_MANIFEST_NAME,
  parseChecksumFile,
  resolveArtifactNames,
  resolveSqliteVecAsset,
} from '../../runtime/release-artifacts.ts';
import {
  compareVersions,
  detectInstallKind,
  fallbackUpdateCommand,
  normalizeVersion,
  resolveLatestReleaseTag,
  type InstallKind,
  type UpdateFetchLike,
} from '../../runtime/update-check.ts';
import { resolveConfiguredServiceName } from '../../runtime/legacy-daemon-migration.ts';
import { requireShellPaths, requireSubscriptionManager } from './runtime-services.ts';

const REPO_RELEASES_LATEST_URL = 'https://github.com/mgd34msu/goodvibes-tui/releases/latest';

function releaseDownloadBaseUrl(tag: string): string {
  return `https://github.com/mgd34msu/goodvibes-tui/releases/download/${tag}`;
}

async function downloadText(fetchImpl: UpdateFetchLike, url: string): Promise<string> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  return await response.text();
}

/**
 * Where cancellation stops being allowed. An update is genuinely abortable up
 * to and including the moment BEFORE the first file is written: every fetch on
 * the way there carries the caller's signal, and every await boundary re-checks
 * it. From the first write onward the swap owns the installed files and always
 * runs to completion — a half-applied swap is the one outcome worse than a slow
 * one.
 *
 * This record makes that boundary readable from outside the call. The launch
 * updater gives `applyUpdate` a budget and abandons the promise when it runs
 * out, so it cannot learn from the return value which side of the line the work
 * was on — it reads these flags instead, and prints the receipt that is
 * actually true (see src/cli/launch-auto-update.ts).
 */
export interface UpdateSwapProgress {
  /** True from the first file write of the swap phase; from here the swap is never interrupted. */
  begun: boolean;
  /** True once every target file has been swapped into place and the update is fully installed. */
  committed: boolean;
  /** The release tag being installed, set as soon as the target is resolved (before any download). */
  targetTag: string | null;
}

export function createUpdateSwapProgress(): UpdateSwapProgress {
  return { begun: false, committed: false, targetTag: null };
}

/** The failure an aborted update ends with — raised only while nothing has been written yet. */
export const UPDATE_ABORTED_MESSAGE = 'update cancelled before any file was replaced';

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error(UPDATE_ABORTED_MESSAGE);
  }
}

/**
 * The shared UpdateFetchLike init shape predates cancellation, so the signal
 * rides on a widened version of it: the real `fetch` reads it — which is what
 * makes the DOWNLOAD itself cancellable rather than merely abandoned — and a
 * test stub that ignores the extra field behaves exactly as it did before.
 */
type AbortableFetchInit = NonNullable<Parameters<UpdateFetchLike>[1]> & { signal?: AbortSignal };

function abortableFetch(fetchImpl: UpdateFetchLike, signal: AbortSignal | undefined): UpdateFetchLike {
  if (!signal) return fetchImpl;
  const withSignal = fetchImpl as (url: string, init?: AbortableFetchInit) => ReturnType<UpdateFetchLike>;
  return async (url, init) => {
    throwIfAborted(signal);
    return await withSignal(url, { ...init, signal });
  };
}

/**
 * Wraps the filesystem seam so the first MUTATING call flips `begun`. The swap
 * phase is the only part of the apply path that writes anything, so that first
 * write is exactly the point after which cancellation must no longer be
 * honoured. Reads (the daemon-present probe, the target-exists check inside the
 * swap) leave the flag alone.
 */
function trackSwapProgress(io: UpdateFileIo, progress: UpdateSwapProgress): UpdateFileIo {
  const begin = (): void => {
    progress.begun = true;
  };
  return {
    writeFile: (path, data) => {
      begin();
      io.writeFile(path, data);
    },
    rename: (from, to) => {
      begin();
      io.rename(from, to);
    },
    chmod: (path, mode) => {
      begin();
      io.chmod(path, mode);
    },
    mkdir: (path) => {
      begin();
      io.mkdir(path);
    },
    exists: (path) => io.exists(path),
  };
}

/**
 * Suffix under which every swap keeps the file it replaced — re-exported
 * from the SDK's canonical update policy module so rollback and swap share
 * one definition everywhere.
 */
export { PREVIOUS_FILE_SUFFIX } from '@pellux/goodvibes-sdk/platform/runtime/self-update';
import { PREVIOUS_FILE_SUFFIX } from '@pellux/goodvibes-sdk/platform/runtime/self-update';

export interface DaemonServiceRestartInfo {
  readonly managed: boolean;
  readonly unitName: string;
  readonly restartCommand: string;
}

/** Injectable so tests never shell out to a real systemctl. */
export type RunCommand = (command: string, args: string[]) => { readonly status: number | null; readonly stdout: string };

const defaultRunCommand: RunCommand = (command, args) => {
  try {
    const result = spawnSync(command, args, { stdio: 'pipe', encoding: 'utf-8' });
    return { status: result.status, stdout: result.stdout ?? '' };
  } catch {
    return { status: null, stdout: '' };
  }
};

/**
 * Detects, honestly, whether the daemon is currently running as a systemd
 * user service — so the post-update message can tell the user the real
 * restart command instead of assuming one. Only Linux/systemd is checked
 * (this repo's PlatformServiceManager also supports launchd on macOS and
 * Scheduled Tasks on Windows, but those aren't restarted with `systemctl`,
 * so on those platforms this honestly reports "not managed here" rather
 * than printing a command that would not work).
 */
export function detectDaemonServiceManaged(
  platform: NodeJS.Platform,
  configManager: { get(key: string): unknown },
  runCommand: RunCommand = defaultRunCommand,
): DaemonServiceRestartInfo {
  const unitName = resolveConfiguredServiceName(configManager);
  if (platform !== 'linux') {
    return { managed: false, unitName, restartCommand: '' };
  }
  const result = runCommand('systemctl', ['--user', 'is-active', `${unitName}.service`]);
  const managed = result.status === 0 && result.stdout.trim() === 'active';
  return { managed, unitName, restartCommand: `systemctl --user restart ${unitName}.service` };
}

export interface CheckForUpdateResult {
  readonly latestTag: string;
  readonly isCurrent: boolean;
}

export async function checkForUpdate(fetchImpl: UpdateFetchLike, currentVersion: string): Promise<CheckForUpdateResult> {
  const latestTag = await resolveLatestReleaseTag(fetchImpl, REPO_RELEASES_LATEST_URL);
  const isCurrent = compareVersions(currentVersion, latestTag) >= 0;
  return { latestTag, isCurrent };
}

export interface ApplyUpdateOptions {
  readonly fetchImpl: UpdateFetchLike;
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly currentVersion: string;
  readonly print: (line: string) => void;
  readonly configManager: { get(key: string): unknown };
  readonly runCommand?: RunCommand;
  /** Injectable filesystem seam (the SDK's UpdateFileIo) so tests observe swaps in memory. */
  readonly io?: UpdateFileIo;
  /**
   * Cancels the update — for real: it is passed to every fetch in the path and
   * re-checked at every await boundary, so an abort stops the download instead
   * of leaving it running unwatched. Honoured only up to the moment before the
   * swap begins; from the first file write onward it is deliberately ignored
   * (see UpdateSwapProgress).
   */
  readonly signal?: AbortSignal;
  /** Shared record letting the caller tell a cancelled update apart from one whose swap had already started. */
  readonly progress?: UpdateSwapProgress;
}

/**
 * The real self-update path, delegating the download-verify-swap mechanics
 * to the SDK's canonical update policy module (applyVerifiedUpdate — the
 * same mechanism the daemon's hourly loop uses). For a binary install:
 * resolve the latest tag, compare to the running version, and if newer,
 * download + checksum-verify EVERY artifact before swapping any one (so a
 * checksum failure never leaves a mismatched pair installed), then
 * atomically swap each in place with the outgoing file kept at
 * `<path>.previous`. For any other install kind, never attempts a swap — it
 * prints the exact command for that install method instead.
 */
export async function applyUpdate(options: ApplyUpdateOptions): Promise<void> {
  const installKind: InstallKind = detectInstallKind(options.execPath);
  if (installKind !== 'binary') {
    options.print(
      [
        `This install is not a self-updatable binary install (detected: ${installKind === 'bun-global-package' ? 'bun/npm package install' : 'running from source'}).`,
        `Update with: ${fallbackUpdateCommand(installKind)}`,
      ].join('\n'),
    );
    return;
  }

  // Every network call from here carries the caller's signal, so an abort
  // cancels the request in flight rather than orphaning it.
  const signal = options.signal;
  const progress = options.progress;
  const fetchImpl = abortableFetch(options.fetchImpl, signal);

  throwIfAborted(signal);
  const latestTag = await resolveLatestReleaseTag(fetchImpl, REPO_RELEASES_LATEST_URL);
  if (compareVersions(options.currentVersion, latestTag) >= 0) {
    options.print(`Already current: running v${normalizeVersion(options.currentVersion)}, latest release is ${latestTag}.`);
    return;
  }

  const artifacts = resolveArtifactNames(options.platform, options.arch);
  if (!artifacts) {
    options.print(`No prebuilt binaries are published for ${options.platform}-${options.arch}; cannot self-update. Update with: ${fallbackUpdateCommand('source')}`);
    return;
  }

  // Named before the first download, so a caller that gives up on a slow apply
  // can still report WHICH version the work was installing.
  if (progress) progress.targetTag = latestTag;

  options.print(`Update available: ${latestTag} (running v${normalizeVersion(options.currentVersion)}). Downloading and verifying...`);

  const baseUrl = releaseDownloadBaseUrl(latestTag);
  const io = options.io ?? realUpdateFileIo;
  const appBinaryPath = options.execPath;
  const daemonBinaryPath = join(dirname(appBinaryPath), 'goodvibes-daemon');
  const daemonBinaryPresent = io.exists(daemonBinaryPath);

  // The sqlite-vec native addon travels with the binaries: refresh it in the
  // same download-verify-swap pass so /update never leaves a new binary beside a
  // stale addon. It lands at <execDir>/lib/sqlite-vec-<os>-<arch>/vec0.<suffix>,
  // exactly where the SDK's loader resolves it. The manifest entry decides
  // whether the target release ships it — an entry that IS present makes the
  // download and checksum mandatory (a mismatch is fatal, verified before any
  // swap), while an absent entry means the target predates the addon and is
  // skipped rather than blocking an otherwise-valid binary update. On macOS the
  // file is refreshed for consistency even though the platform blocks extension
  // loading. This inclusion decision needs one manifest pre-read; the swap
  // itself re-verifies every included artifact inside applyVerifiedUpdate.
  throwIfAborted(signal);
  const checksumText = await downloadText(fetchImpl, `${baseUrl}/${CHECKSUM_MANIFEST_NAME}`);
  const checksums = parseChecksumFile(checksumText);
  const addon = resolveSqliteVecAsset(options.platform, options.arch);
  const addonIncluded = addon !== null && checksums.get(addon.assetName) !== undefined;
  const addonTargetPath = addon && addonIncluded
    ? join(dirname(appBinaryPath), 'lib', addon.dirName, addon.fileName)
    : null;

  const targets: UpdateTarget[] = [
    { label: 'app binary', path: appBinaryPath, assetName: artifacts.app, executable: true },
    ...(daemonBinaryPresent
      ? [{ label: 'daemon binary', path: daemonBinaryPath, assetName: artifacts.daemon, executable: true }]
      : []),
    ...(addon && addonTargetPath
      ? [{ label: 'vector addon', path: addonTargetPath, assetName: addon.assetName, executable: false }]
      : []),
  ];

  // One mechanism everywhere: downloads + verifies ALL targets before any
  // write, then swaps each atomically with the outgoing file kept at
  // `<path>.previous`.
  //
  // This is the last point at which the update can be called off. The
  // downloads inside applyVerifiedUpdate are still cancellable (the signal
  // rides on every request), but its swap loop is synchronous and runs to
  // completion once its first write lands — which is precisely what
  // `progress.begun` records, and why nothing below this call re-checks the
  // signal.
  throwIfAborted(signal);
  await applyVerifiedUpdate({
    fetchImpl,
    downloadBaseUrl: baseUrl,
    targets,
    io: progress ? trackSwapProgress(io, progress) : io,
    platform: options.platform,
  });
  if (progress) progress.committed = true;

  const serviceInfo = detectDaemonServiceManaged(options.platform, options.configManager, options.runCommand);

  options.print(
    [
      `Updated to ${latestTag}.`,
      `  app binary:    ${appBinaryPath}`,
      daemonBinaryPresent
        ? `  daemon binary: ${daemonBinaryPath}`
        : `  daemon binary: not found at ${daemonBinaryPath} — left untouched`,
      ...(addonTargetPath ? [`  vector addon:  ${addonTargetPath}`] : []),
      '',
      'Restart goodvibes to run the new version.',
      serviceInfo.managed
        ? `The daemon is managed by systemd — restart it with: ${serviceInfo.restartCommand}`
        : 'The daemon restarts automatically the next time goodvibes launches.',
    ].join('\n'),
  );
}

export interface RollbackUpdateOptions {
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly print: (line: string) => void;
  readonly configManager: { get(key: string): unknown };
  readonly runCommand?: RunCommand;
  /** Injectable filesystem seam (the SDK's UpdateFileIo) so tests observe renames in memory. */
  readonly io?: UpdateFileIo;
}

/**
 * One-command rollback to the version that ran before the last update,
 * delegating the exchange mechanics to the SDK's rollbackKeptPrevious (the
 * same module the swap uses): every installed file (app binary, daemon
 * binary, vector addon) that has a kept `.previous` counterpart is EXCHANGED
 * with it — the previous version becomes live, and the version being rolled
 * back is itself kept at `.previous`, so a second `/update rollback` rolls
 * forward again. Files without a kept counterpart are reported and left
 * untouched; nothing is downloaded.
 */
export function rollbackUpdate(options: RollbackUpdateOptions): void {
  const installKind: InstallKind = detectInstallKind(options.execPath);
  if (installKind !== 'binary') {
    options.print(
      [
        `This install is not a self-updatable binary install (detected: ${installKind === 'bun-global-package' ? 'bun/npm package install' : 'running from source'}), so there is no kept previous binary to roll back to.`,
        `Install a specific version with your package manager instead, e.g.: ${fallbackUpdateCommand(installKind)}`,
      ].join('\n'),
    );
    return;
  }

  const io = options.io ?? realUpdateFileIo;
  const addon = resolveSqliteVecAsset(options.platform, options.arch);
  const targets = [
    { label: 'app binary', path: options.execPath },
    { label: 'daemon binary', path: join(dirname(options.execPath), 'goodvibes-daemon') },
    ...(addon ? [{ label: 'vector addon', path: join(dirname(options.execPath), 'lib', addon.dirName, addon.fileName) }] : []),
  ];

  const result = rollbackKeptPrevious(targets, io);
  if (result.restored.length === 0) {
    options.print(
      `No previous version is kept beside this install (nothing at ${options.execPath}${PREVIOUS_FILE_SUFFIX}). ` +
      'The previous version is kept from the next update onward.',
    );
    return;
  }

  const serviceInfo = detectDaemonServiceManaged(options.platform, options.configManager, options.runCommand);
  options.print(
    [
      'Rolled back to the previously installed version.',
      ...result.restored.map((target) => `  ${target.label}: ${target.path} (the replaced version is kept at ${target.path}${PREVIOUS_FILE_SUFFIX})`),
      '',
      'Restart goodvibes to run the restored version.',
      serviceInfo.managed
        ? `The daemon is managed by systemd — restart it with: ${serviceInfo.restartCommand}`
        : 'The daemon restarts automatically the next time goodvibes launches.',
    ].join('\n'),
  );
}

interface UpdateBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly appVersion: string;
  readonly installKind: InstallKind;
  readonly subscriptionProviders: readonly string[];
  readonly sandboxProfile: string;
  readonly notes: readonly string[];
}

function inspectUpdateBundle(bundle: UpdateBundle): string {
  return [
    'Update Bundle Review',
    `  appVersion: ${bundle.appVersion}`,
    `  installKind: ${bundle.installKind}`,
    `  subscriptionProviders: ${bundle.subscriptionProviders.length}`,
    `  sandboxProfile: ${bundle.sandboxProfile}`,
    `  notes: ${bundle.notes.length}`,
  ].join('\n');
}

export function registerUpdateCommand(registry: CommandRegistry): void {
  registry.register({
    name: 'update',
    aliases: ['upgrade'],
    description: 'Check for a newer GoodVibes release and, for binary installs, download/verify/apply it or roll back to the kept previous version',
    usage: '[check|apply|rollback|review|bundle export <path>|bundle inspect <path>]',
    async handler(args, ctx) {
      const sub = args[0] ?? 'check';

      if (sub === 'check') {
        try {
          const result = await checkForUpdate(fetch, VERSION);
          ctx.print(
            result.isCurrent
              ? `Already current: running v${normalizeVersion(VERSION)} (latest release is ${result.latestTag}).`
              : `Update available: ${result.latestTag} (running v${normalizeVersion(VERSION)}). Run /update apply to install it.`,
          );
        } catch (error) {
          ctx.print(`Could not check for updates: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }

      if (sub === 'apply') {
        try {
          await applyUpdate({
            fetchImpl: fetch,
            execPath: process.execPath,
            platform: process.platform,
            arch: process.arch,
            currentVersion: VERSION,
            print: ctx.print,
            configManager: ctx.platform.configManager,
          });
        } catch (error) {
          ctx.print(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }

      if (sub === 'rollback') {
        try {
          rollbackUpdate({
            execPath: process.execPath,
            platform: process.platform,
            arch: process.arch,
            print: ctx.print,
            configManager: ctx.platform.configManager,
          });
        } catch (error) {
          ctx.print(`Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }

      if (sub === 'review') {
        const installKind = detectInstallKind(process.execPath);
        const subscriptions = requireSubscriptionManager(ctx);
        const builtinProviders = listBuiltinSubscriptionProviders().map((entry) => entry.provider);
        const activeSubscriptions = subscriptions.list().map((entry) => entry.provider);
        const sandboxProfile = [
          `${ctx.platform.configManager.get('sandbox.replIsolation')}`,
          `${ctx.platform.configManager.get('sandbox.mcpIsolation')}`,
          `${ctx.platform.configManager.get('sandbox.vmBackend')}`,
        ].join('/');
        ctx.print(
          [
            'Update Review',
            `  version: ${VERSION}`,
            `  install kind: ${installKind}`,
            `  built-in subscription providers: ${builtinProviders.length}${builtinProviders.length > 0 ? ` (${builtinProviders.join(', ')})` : ''}`,
            `  active subscriptions: ${activeSubscriptions.length}${activeSubscriptions.length > 0 ? ` (${activeSubscriptions.join(', ')})` : ''}`,
            `  sandbox profile: ${sandboxProfile}`,
            '  use /update check to look for a newer release, /update apply to install it, /update rollback to return to the kept previous version',
          ].join('\n'),
        );
        return;
      }

      if (sub === 'bundle') {
        const shellPaths = requireShellPaths(ctx);
        const mode = args[1];
        const pathArg = args[2];
        if ((mode === 'export' || mode === 'inspect') && !pathArg) {
          ctx.print(`Usage: /update bundle ${mode} <path>`);
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg!);
        if (mode === 'export') {
          const subscriptions = requireSubscriptionManager(ctx);
          const builtinProviders = listBuiltinSubscriptionProviders().map((entry) => entry.provider);
          const activeSubscriptions = subscriptions.list().map((entry) => entry.provider);
          const sandboxProfile = [
            `${ctx.platform.configManager.get('sandbox.replIsolation')}`,
            `${ctx.platform.configManager.get('sandbox.mcpIsolation')}`,
            `${ctx.platform.configManager.get('sandbox.vmBackend')}`,
          ].join('/');
          const bundle: UpdateBundle = {
            version: 1,
            exportedAt: Date.now(),
            appVersion: VERSION,
            installKind: detectInstallKind(process.execPath),
            subscriptionProviders: [...new Set([...builtinProviders, ...activeSubscriptions])],
            sandboxProfile,
            notes: [
              'installKind reflects how THIS running process was launched, detected from process.execPath.',
              'OAuth-backed provider subscriptions survive updates and continue to apply to supported provider surfaces.',
            ],
          };
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
          ctx.print(`Update bundle exported to ${targetPath}`);
          return;
        }
        if (mode === 'inspect') {
          const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as UpdateBundle;
          ctx.print(inspectUpdateBundle(bundle));
          return;
        }
      }

      ctx.print('Usage: /update [check|apply|rollback|review|bundle export <path>|bundle inspect <path>]');
    },
  });
}
