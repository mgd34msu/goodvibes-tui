/**
 * `/update` — a real self-update path for binary installs, mirroring
 * scripts/install.sh's download-verify-swap semantics (that file is the
 * tested reference for release-asset naming and checksum verification; keep
 * this in lockstep with it).
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
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CommandRegistry } from '../command-registry.ts';
import { VERSION } from '../../version.ts';
import { listBuiltinSubscriptionProviders } from '@pellux/goodvibes-sdk/platform/config';
import {
  CHECKSUM_MANIFEST_NAME,
  parseChecksumFile,
  resolveArtifactNames,
  resolveSqliteVecAsset,
  sha256,
  verifyChecksum,
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

async function downloadBuffer(fetchImpl: UpdateFetchLike, url: string): Promise<Buffer> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Suffix under which every swap keeps the file it replaced, right beside the
 * live one. This is what makes rollback a one-command operation instead of a
 * re-download: the version that ran before the last update is always still
 * on disk at `<path>.previous`.
 */
export const PREVIOUS_FILE_SUFFIX = '.previous';

/**
 * Writes the new binary next to the target, then renames over it — an
 * atomic replace on the same filesystem, so a currently-running process
 * that already opened the old file keeps its old inode (POSIX unlink
 * semantics) instead of executing a half-written file. Same approach as
 * scripts/install.sh's `mv -f "$WORKDIR/$artifact" "$target"`.
 *
 * Before the replace, the outgoing file is parked at `<path>.previous`
 * (overwriting any older parked copy) so `/update rollback` can restore it
 * without a network round-trip.
 */
function swapBinaryAtomically(targetPath: string, buffer: Buffer): void {
  const tempPath = `${targetPath}.update-download`;
  writeFileSync(tempPath, buffer);
  if (process.platform !== 'win32') {
    chmodSync(tempPath, 0o755);
  }
  if (existsSync(targetPath)) {
    renameSync(targetPath, `${targetPath}${PREVIOUS_FILE_SUFFIX}`);
  }
  renameSync(tempPath, targetPath);
}

/**
 * Writes the sqlite-vec native addon into place with the same temp-write +
 * atomic-rename discipline as the binaries, so a running process never
 * dlopen()s a half-written extension. The addon's parent directory
 * (`<execDir>/lib/sqlite-vec-<os>-<arch>/`) is created first because a fresh
 * install may not have a `lib/` tree yet. A shared library needs no execute
 * bit, so this uses 0o644 rather than the binaries' 0o755. The outgoing
 * addon is kept at `<path>.previous`, same as the binaries, so a rollback
 * restores the addon that matches the restored binary.
 */
function writeAddonAtomically(targetPath: string, buffer: Buffer): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.update-download`;
  writeFileSync(tempPath, buffer);
  if (process.platform !== 'win32') {
    chmodSync(tempPath, 0o644);
  }
  if (existsSync(targetPath)) {
    renameSync(targetPath, `${targetPath}${PREVIOUS_FILE_SUFFIX}`);
  }
  renameSync(tempPath, targetPath);
}

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
  /** Injectable so tests can observe/skip the actual filesystem swap. */
  readonly swap?: (targetPath: string, buffer: Buffer) => void;
  /** Injectable so tests can observe/skip writing the sqlite-vec addon. */
  readonly writeAddon?: (targetPath: string, buffer: Buffer) => void;
  readonly fileExists?: (path: string) => boolean;
}

/**
 * The real self-update path. For a binary install: resolve the latest tag,
 * compare to the running version, and if newer, download + verify both
 * artifacts BEFORE swapping either one (so a checksum failure on the second
 * artifact never leaves a mismatched pair installed), then atomically swap
 * each in place. For any other install kind, never attempts a swap — it
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

  const latestTag = await resolveLatestReleaseTag(options.fetchImpl, REPO_RELEASES_LATEST_URL);
  if (compareVersions(options.currentVersion, latestTag) >= 0) {
    options.print(`Already current: running v${normalizeVersion(options.currentVersion)}, latest release is ${latestTag}.`);
    return;
  }

  const artifacts = resolveArtifactNames(options.platform, options.arch);
  if (!artifacts) {
    options.print(`No prebuilt binaries are published for ${options.platform}-${options.arch}; cannot self-update. Update with: ${fallbackUpdateCommand('source')}`);
    return;
  }

  options.print(`Update available: ${latestTag} (running v${normalizeVersion(options.currentVersion)}). Downloading and verifying...`);

  const baseUrl = releaseDownloadBaseUrl(latestTag);
  const checksumText = await downloadText(options.fetchImpl, `${baseUrl}/${CHECKSUM_MANIFEST_NAME}`);
  const checksums = parseChecksumFile(checksumText);

  const appBinaryPath = options.execPath;
  const daemonBinaryPath = join(dirname(appBinaryPath), 'goodvibes-daemon');
  const fileExists = options.fileExists ?? existsSync;
  const daemonBinaryPresent = fileExists(daemonBinaryPath);

  const appBuffer = await downloadBuffer(options.fetchImpl, `${baseUrl}/${artifacts.app}`);
  verifyChecksum(artifacts.app, sha256(appBuffer), checksums.get(artifacts.app));

  let daemonBuffer: Buffer | null = null;
  if (daemonBinaryPresent) {
    daemonBuffer = await downloadBuffer(options.fetchImpl, `${baseUrl}/${artifacts.daemon}`);
    verifyChecksum(artifacts.daemon, sha256(daemonBuffer), checksums.get(artifacts.daemon));
  }

  // The sqlite-vec native addon travels with the binaries: refresh it in the
  // same download-verify-swap pass so /update never leaves a new binary beside a
  // stale addon. It lands at <execDir>/lib/sqlite-vec-<os>-<arch>/vec0.<suffix>,
  // exactly where the SDK's loader resolves it. The manifest entry decides
  // whether the target release ships it — an entry that IS present makes the
  // download and checksum mandatory (a mismatch is fatal, verified before any
  // swap), while an absent entry means the target predates the addon and is
  // skipped rather than blocking an otherwise-valid binary update. On macOS the
  // file is refreshed for consistency even though the platform blocks extension
  // loading.
  const addon = resolveSqliteVecAsset(options.platform, options.arch);
  const addonExpected = addon ? checksums.get(addon.assetName) : undefined;
  let addonBuffer: Buffer | null = null;
  if (addon && addonExpected !== undefined) {
    addonBuffer = await downloadBuffer(options.fetchImpl, `${baseUrl}/${addon.assetName}`);
    verifyChecksum(addon.assetName, sha256(addonBuffer), addonExpected);
  }

  // All downloads verified before any write — an update must not apply partially.
  const swap = options.swap ?? swapBinaryAtomically;
  swap(appBinaryPath, appBuffer);
  if (daemonBuffer) {
    swap(daemonBinaryPath, daemonBuffer);
  }
  const addonTargetPath = addon && addonBuffer
    ? join(dirname(appBinaryPath), 'lib', addon.dirName, addon.fileName)
    : null;
  if (addonBuffer && addonTargetPath) {
    const writeAddon = options.writeAddon ?? writeAddonAtomically;
    writeAddon(addonTargetPath, addonBuffer);
  }

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
  /** Injectable so tests observe the renames without touching a real install. */
  readonly rename?: (from: string, to: string) => void;
  readonly fileExists?: (path: string) => boolean;
}

/**
 * One-command rollback to the version that ran before the last update: every
 * installed file (app binary, daemon binary, vector addon) that has a kept
 * `.previous` counterpart is EXCHANGED with it — the previous version becomes
 * live, and the version being rolled back is itself kept at `.previous`, so a
 * second `/update rollback` rolls forward again. Files without a kept
 * counterpart are reported and left untouched; nothing is downloaded.
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

  const fileExists = options.fileExists ?? existsSync;
  const rename = options.rename ?? renameSync;
  const addon = resolveSqliteVecAsset(options.platform, options.arch);
  const targets = [
    { label: 'app binary', path: options.execPath },
    { label: 'daemon binary', path: join(dirname(options.execPath), 'goodvibes-daemon') },
    ...(addon ? [{ label: 'vector addon', path: join(dirname(options.execPath), 'lib', addon.dirName, addon.fileName) }] : []),
  ];

  const restored: string[] = [];
  for (const target of targets) {
    const previousPath = `${target.path}${PREVIOUS_FILE_SUFFIX}`;
    if (!fileExists(previousPath)) continue;
    if (fileExists(target.path)) {
      // Three renames exchange the pair; the parking name keeps every step a
      // same-directory rename (atomic on POSIX), never a copy.
      const parkingPath = `${target.path}.rollback-exchange`;
      rename(target.path, parkingPath);
      rename(previousPath, target.path);
      rename(parkingPath, previousPath);
    } else {
      rename(previousPath, target.path);
    }
    restored.push(`  ${target.label}: ${target.path} (the replaced version is kept at ${previousPath})`);
  }

  if (restored.length === 0) {
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
      ...restored,
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
