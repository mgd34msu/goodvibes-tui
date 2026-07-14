// ---------------------------------------------------------------------------
// power-keepawake-remote.ts — forward the keep-awake toggle to an adopted
// EXTERNAL daemon over the power.keepAwake.set operator verb.
//
// In the external/adopted-daemon topology the in-process PowerManager is NOT
// the daemon's, so a keep-awake toggle applied only locally dies when the TUI
// closes. The owner ruling is that keep-awake is daemon-held: it must survive
// the TUI closing. The config file does NOT carry it across (power.keepAwake is
// not a cross-surface shared key), so the toggle is forwarded to the daemon
// over the verb instead — best-effort, gated on reachability. Mirrors the
// agent's own power-keep-awake-remote seam.
//
// A single config subscriber carries ALL THREE toggle paths (/power, Alt+A, the
// settings modal): each lands on the power.keepAwake config key — the local
// PowerManager persists it on set, and the settings modal writes it directly —
// so subscribing to that one key catches every origin. In the EMBEDDED topology
// this is a no-op: the in-process manager already IS the daemon.
// ---------------------------------------------------------------------------

import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { PowerState } from '@pellux/goodvibes-sdk/platform/power';
import { resolveOperatorRpc } from '../input/commands/operator-rpc.ts';

export interface KeepAwakeRemoteDeps {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
  /** True only in the external/adopted-daemon topology (the local manager is not the daemon's). */
  readonly isExternalDaemon: () => boolean;
  /** Injectable rpc resolution (tests); defaults to the shared resolveOperatorRpc. */
  readonly resolveRpc?: typeof resolveOperatorRpc;
}

/**
 * Best-effort forward of the keep-awake toggle to the adopted external daemon so
 * the DAEMON holds the inhibitor (surviving the TUI closing). A no-op in the
 * embedded topology and quiet when the daemon is unreachable — a transient
 * daemon hiccup never breaks the local toggle.
 */
export async function forwardKeepAwakeToDaemon(enabled: boolean, deps: KeepAwakeRemoteDeps): Promise<void> {
  if (!deps.isExternalDaemon()) return;
  const rpc = (deps.resolveRpc ?? resolveOperatorRpc)({ configManager: deps.configManager, homeDirectory: deps.homeDirectory });
  if (!rpc.available) return;
  try {
    await rpc.sdk.operator.invoke('power.keepAwake.set', { enabled });
  } catch {
    // Best-effort by design; the local toggle already applied.
  }
}

/**
 * Install a config subscriber that forwards every power.keepAwake change to the
 * adopted external daemon. Returns an unsubscribe handle. Because all three
 * toggle origins land on the same config key, this one seam carries them all.
 */
export function installKeepAwakeRemoteForward(deps: KeepAwakeRemoteDeps): () => void {
  return deps.configManager.subscribe('power.keepAwake', (newValue) => {
    void forwardKeepAwakeToDaemon(newValue === true, deps);
  });
}

/**
 * Fetch the adopted DAEMON's power.status.get (null when unreachable or not in
 * the external topology). The chip's external-mode poll source — the adopted
 * wire is plain HTTP with no event bridge, so the chip syncs by polling.
 */
export async function fetchDaemonPowerState(deps: KeepAwakeRemoteDeps): Promise<PowerState | null> {
  if (!deps.isExternalDaemon()) return null;
  const rpc = (deps.resolveRpc ?? resolveOperatorRpc)({ configManager: deps.configManager, homeDirectory: deps.homeDirectory });
  if (!rpc.available) return null;
  try {
    return await rpc.sdk.operator.invoke('power.status.get', {}) as unknown as PowerState;
  } catch {
    return null;
  }
}
