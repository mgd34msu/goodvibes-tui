/**
 * settings-modal-connections.ts, rendering for the Connections category of the
 * settings workspace.
 *
 * Split out of settings-modal.ts for the 800-line file cap, the same reason
 * settings-modal-helpers.ts exists. Pure rendering: every value shown here was
 * decided by the daemon probe in input/commands/connection-status.ts.
 */

import type { SettingsModal } from '../input/settings-modal.ts';
import { selectedConnectionEntry } from '../input/settings-modal-connections.ts';
import { connectionSurfaceLabel } from '../input/commands/connection-status.ts';
import type { KitRow } from './surface-kit-list.ts';

/**
 * The Connections rows: one row per surface, saying what it actually is.
 *
 * `checking` is rendered as its own state rather than blanked, because a row
 * that showed nothing while the probe was in flight would read as "nothing
 * configured", the one thing this category exists to stop claiming falsely.
 */
export function connectionRows(modal: SettingsModal, selectable: boolean): KitRow[] {
  const items = modal.connectionEntries;
  if (items.length === 0) return [{ label: 'No connection surfaces are known to this build.', muted: true }];
  const selectedIndex = Math.max(0, Math.min(modal.selectedIndex, items.length - 1));
  return items.map((entry, index) => ({
    label: connectionSurfaceLabel(entry.surface),
    desc: entry.detail,
    right: entry.state,
    selected: selectable && index === selectedIndex,
    current: !selectable && index === selectedIndex,
  }));
}

/**
 * The detail for one connection: the state, what it means, and every next
 * step verbatim. The next steps are the daemon's requirements, so they are
 * listed in full rather than summarized, a truncated instruction is a wrong
 * instruction.
 */
export function buildConnectionContext(modal: SettingsModal): string[] {
  const entry = selectedConnectionEntry(modal);
  if (!entry) return ['Connections', 'No connection surface is selected.'];
  return [
    connectionSurfaceLabel(entry.surface),
    `State: ${entry.state}`,
    entry.detail,
    ...(entry.nextActions.length > 0 ? ['', 'Next steps:', ...entry.nextActions] : []),
    '',
    entry.surface === 'mail'
      ? 'Use it from the transcript with /mail (status, list, read, draft, send).'
      : 'Use it from the transcript with /calendar (status, list, get, create).',
  ];
}
