/**
 * settings-modal-connections.ts — the Connections category of the settings
 * workspace: whether mail and calendar are actually usable, and if not, the
 * exact next step.
 *
 * This category exists because a capability reachable only by typing a slash
 * command is not, as far as someone clicking through the workspace is
 * concerned, wired up at all. `/mail status` and `/calendar status` answer the
 * same question; a person opening `/settings` to see what is connected should
 * not have to already know those commands exist.
 *
 * ## Why the rows arrive asynchronously
 *
 * Every other settings category reads a value out of config and renders it.
 * This one cannot: "is mail connected?" is only answerable by asking the
 * daemon's handler, which is real I/O. The workspace renders synchronously, so
 * the rows start in `checking` — which is true — and the refresh replaces them
 * and asks for a re-render, the same contract the Services surface uses for its
 * inspections. Nothing is ever shown as "not configured" merely because an
 * answer has not arrived yet; that would be a guess rendered as a fact.
 *
 * No credential is read, held, or rendered here. The probe asks each surface
 * for one item and keeps only whether it failed and why.
 */

import type { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import {
  connectionSurfaceLabel,
  probeConnection,
  type ConnectionStatus,
  type ConnectionSurface,
} from './commands/connection-status.ts';

/** The surfaces this category covers, in display order. */
export const CONNECTION_SURFACES: readonly ConnectionSurface[] = ['mail', 'calendar'];

/**
 * The pre-probe rows.
 *
 * Stated as `checking` rather than blank so the category is never empty and
 * never asserts a state it has not established.
 */
export function initialConnectionEntries(): ConnectionStatus[] {
  return CONNECTION_SURFACES.map((surface) => ({
    surface,
    state: 'checking' as const,
    detail: `Asking the daemon whether ${connectionSurfaceLabel(surface).toLowerCase()} is reachable…`,
    nextActions: [],
  }));
}

/**
 * Probe every surface. Returns rows in `CONNECTION_SURFACES` order so the
 * category never reorders itself under the cursor between refreshes.
 */
export async function buildConnectionEntries(
  gateway: GatewayMethodCatalog | undefined,
): Promise<ConnectionStatus[]> {
  return Promise.all(CONNECTION_SURFACES.map((surface) => probeConnection(gateway, surface)));
}

/**
 * The mutable slice of the settings workspace this module drives. Declared
 * structurally rather than importing the class, so the split stays a file-size
 * split and does not become an import cycle.
 */
export interface ConnectionsHost {
  active: boolean;
  selectedIndex: number;
  connectionEntries: ConnectionStatus[];
  connectionsRefreshing: boolean;
  gatewayMethods: GatewayMethodCatalog | null;
  requestRender: (() => void) | null;
}

/**
 * Refresh the rows from the daemon and repaint.
 *
 * A second call while one is in flight is dropped: entering the tab repeatedly
 * should not queue a probe per keystroke. A probe that lands after the
 * workspace closed is discarded rather than written, so reopening starts from
 * `checking` instead of resurrecting an answer about a finished session.
 */
export async function refreshConnectionEntries(host: ConnectionsHost): Promise<void> {
  if (host.connectionsRefreshing) return;
  host.connectionsRefreshing = true;
  try {
    const entries = await buildConnectionEntries(host.gatewayMethods ?? undefined);
    if (!host.active) return;
    host.connectionEntries = entries;
    host.requestRender?.();
  } finally {
    host.connectionsRefreshing = false;
  }
}

/** The selected row, clamped, or null when the category is empty. */
export function selectedConnectionEntry(host: ConnectionsHost): ConnectionStatus | null {
  const entries = host.connectionEntries;
  if (entries.length === 0) return null;
  return entries[Math.max(0, Math.min(entries.length - 1, host.selectedIndex))] ?? null;
}
