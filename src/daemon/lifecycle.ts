/**
 * lifecycle.ts — the daemon self-update loop for THIS repo's daemon binary,
 * plus the shim that suppresses the SDK facade's version-blind copy of it.
 *
 * BACKGROUND. The SDK's DaemonServer facade now wires a lifecycle sidecar
 * internally: a clean-shutdown marker (crash detection), a persisted receipt
 * store surfaced on /status, and an hourly auto-updater (download all
 * artifacts, checksum-verify all, atomically swap with the outgoing file kept
 * at `<path>.previous`). The marker and receipts are version-independent and
 * stay active. The facade's auto-updater, however, compares the SDK
 * PACKAGE'S own version constant against `update.releasesUrl` — which
 * defaults to THIS repo's releases page. Inside a binary built from this
 * repo, that comparison is permanently "behind" (the sdk version never
 * matches this repo's release tags), so the facade's loop would find an
 * "update" every hour, re-download the same binaries, swap them, and restart
 * the daemon — an hourly restart loop. Until the sdk facade accepts the host
 * binary's version, every DaemonServer this repo composes calls
 * {@link suppressVersionBlindFacadeAutoUpdater} and the STANDALONE daemon
 * runs {@link startDaemonAutoUpdate} instead: the same SDK update mechanism
 * (DaemonAutoUpdater — one mechanism everywhere), fed this binary's real
 * version.
 *
 * SAFETY. The loop only ever starts for a compiled binary install
 * (detectInstallKind): a dev `bun run daemon` must never swap the bun
 * executable. A swap only happens at a no-active-work moment (the session
 * broker's real busy count), and every applied update leaves a receipt in
 * the same store the facade serves on /status.
 */
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DaemonAutoUpdater } from '@pellux/goodvibes-sdk/platform/daemon/auto-updater';
import { DaemonReceiptStore } from '@pellux/goodvibes-sdk/platform/daemon/receipts';
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { VERSION } from '../version.ts';
import { detectInstallKind } from '../runtime/update-check.ts';
import {
  buildManagedDaemonServiceManager,
  resolveConfiguredServiceName,
} from '../runtime/legacy-daemon-migration.ts';

/**
 * The slice of the facade's private lifecycle sidecar this shim touches.
 * Deliberately structural: the fields are plain (non-#private) class members
 * in the shipped module, and {@link suppressVersionBlindFacadeAutoUpdater}
 * returns false — loudly logged — if the shape ever changes.
 */
interface FacadeLifecycleSlice {
  autoUpdater?: { stop(): void } | null;
  startAutoUpdater?: (() => void) | undefined;
}

/**
 * Stop — and keep stopped, across facade-internal restart cycles — the SDK
 * facade's version-blind internal auto-updater. Marker and receipts stay
 * active. Returns false when the facade no longer exposes the expected
 * lifecycle shape (the signal to revisit this shim against the sdk).
 *
 * DELETE when the sdk facade takes the host binary's version (tracked as an
 * sdk follow-up alongside the export-map additions on the dev-link).
 */
export function suppressVersionBlindFacadeAutoUpdater(daemon: object): boolean {
  const lifecycle = (daemon as { lifecycle?: FacadeLifecycleSlice | null }).lifecycle;
  if (!lifecycle || typeof lifecycle !== 'object') {
    logger.warn('daemon lifecycle: facade lifecycle shape not found; the version-blind facade auto-updater may still be active');
    return false;
  }
  try {
    lifecycle.autoUpdater?.stop();
  } catch {
    // Already stopped — nothing to unwind.
  }
  lifecycle.autoUpdater = null;
  // Shadow the prototype method so onStarted() after a facade-internal
  // restart cycle cannot re-create the version-blind loop.
  lifecycle.startAutoUpdater = () => {};
  return true;
}

/** The result of {@link startDaemonAutoUpdate}: honest about why it did not start. */
export interface DaemonAutoUpdateHandle {
  readonly started: boolean;
  /** Human-readable reason when not started ('' when started). */
  readonly reason: string;
  stop(): void;
}

export interface StartDaemonAutoUpdateOptions {
  readonly configManager: ConfigManager;
  /** The daemon's real activity signal: true only when NO work is in flight. */
  readonly isIdle: () => boolean;
  readonly homeDirectory: string;
  readonly workingDirectory: string;
  readonly execPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  /** Injectable so tests pin a fixture version — never the live build VERSION. */
  readonly currentVersion?: string;
  /** Injectable updater seam so tests observe wiring without timers/network. */
  readonly createUpdater?: (options: ConstructorParameters<typeof DaemonAutoUpdater>[0]) => Pick<DaemonAutoUpdater, 'start' | 'stop'>;
}

const notStarted = (reason: string): DaemonAutoUpdateHandle => ({ started: false, reason, stop: () => {} });

/**
 * Start the hourly self-update loop for the standalone daemon, fed THIS
 * binary's version. Mirrors the SDK facade's own wiring (same gates:
 * `update.auto`, `update.releasesUrl`, `update.intervalMinutes`;
 * same service adoption/restart semantics) with two host-identity
 * corrections: the version compared is this repo's, and the loop refuses to
 * start unless this process runs from a compiled binary install.
 */
export function startDaemonAutoUpdate(options: StartDaemonAutoUpdateOptions): DaemonAutoUpdateHandle {
  const configManager = options.configManager;
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  const installKind = detectInstallKind(execPath);
  if (installKind !== 'binary') {
    return notStarted(`not a compiled binary install (detected: ${installKind}); self-update never swaps a ${installKind} install`);
  }
  if (configManager.get('update.auto') !== true) {
    return notStarted('update.auto is off');
  }
  const releasesUrl = String(configManager.get('update.releasesUrl') ?? '').trim();
  if (!releasesUrl) {
    return notStarted('update.releasesUrl is empty');
  }

  const intervalMinutes = Number(configManager.get('update.intervalMinutes') ?? 60);
  const serviceName = resolveConfiguredServiceName(configManager);
  const receipts = new DaemonReceiptStore(
    join(configManager.getControlPlaneConfigDir(), 'control-plane', 'daemon-receipts.json'),
  );
  const host = String(process.env.GOODVIBES_DAEMON_HOST ?? configManager.get('controlPlane.host') ?? '127.0.0.1');
  const port = Number(configManager.get('controlPlane.port'));
  const serviceManager = buildManagedDaemonServiceManager({
    binaryPath: execPath,
    homeDir: options.homeDirectory,
    host,
    port,
    workingDirectory: options.workingDirectory,
    configManager,
  });
  const spawnDetached = (argv: readonly string[]): void => {
    try {
      const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (error) {
      logger.warn('daemon lifecycle: service-manager command failed to spawn', { argv, error: summarizeError(error) });
    }
  };
  const createUpdater = options.createUpdater ?? ((updaterOptions) => new DaemonAutoUpdater(updaterOptions));
  const updater = createUpdater({
    currentVersion: options.currentVersion ?? VERSION,
    execPath,
    platform,
    arch,
    releasesLatestUrl: releasesUrl,
    checkIntervalMs: Math.max(5, intervalMinutes) * 60 * 1000,
    isIdle: options.isIdle,
    receipts,
    serviceActions: {
      isSupervised: () => {
        try {
          const status = serviceManager.status();
          return status.installed && status.running;
        } catch {
          return false;
        }
      },
      adoptIntoService: () => {
        // Adoption: write the unit (with the survival contract) and enqueue a
        // start. The old process exits right after; if the first start races
        // the dying listener, Restart=on-failure retries until the port is free.
        try {
          const installed = serviceManager.install();
          if (installed.lingerNote) logger.info(`daemon lifecycle: ${installed.lingerNote}`);
        } catch (error) {
          logger.warn('daemon lifecycle: service unit install failed during update adoption', { error: summarizeError(error) });
          return;
        }
        if (platform === 'linux') {
          spawnDetached(['systemctl', '--user', 'daemon-reload']);
          spawnDetached(['systemctl', '--user', '--no-block', 'enable', '--now', `${serviceName}.service`]);
        }
      },
      restartService: () => {
        if (platform === 'linux') {
          // Non-blocking: the restart job outlives this process, which
          // systemd stops as part of the restart.
          spawnDetached(['systemctl', '--user', '--no-block', 'restart', `${serviceName}.service`]);
          return;
        }
        // launchd (KeepAlive=true) and manual supervision both respawn the
        // (already-swapped) binary when this process exits cleanly.
        process.exit(0);
      },
    },
  });
  updater.start();
  return { started: true, reason: '', stop: () => updater.stop() };
}
