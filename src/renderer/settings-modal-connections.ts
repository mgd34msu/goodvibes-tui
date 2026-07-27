/**
 * settings-modal-connections.ts — rendering for the Connections category of the
 * settings workspace.
 *
 * Split out of settings-modal.ts for the 800-line file cap, the same reason
 * settings-modal-helpers.ts exists. Pure rendering: every value shown here was
 * decided by the daemon probe in input/commands/connection-status.ts.
 */

import type { SettingsModal } from '../input/settings-modal.ts';
import { selectedConnectionEntry } from '../input/settings-modal-connections.ts';
import { connectionSurfaceLabel, type ConnectionStatus } from '../input/commands/connection-status.ts';
import { GLYPHS } from './ui-primitives.ts';
import { clamp, padDisplay, stableWindow } from './fullscreen-workspace.ts';

/**
 * The Connections rows: one line per surface, saying what it actually is.
 *
 * `checking` is rendered as its own state rather than blanked, because a row
 * that showed nothing while the probe was in flight would read as "nothing
 * configured" — the one thing this category exists to stop claiming falsely.
 */
export function renderConnectionRows(modal: SettingsModal, width: number, height: number): string[] {
  const rows: string[] = [];
  const items = modal.connectionEntries;
  if (items.length === 0) return ['No connection surfaces are known to this build.'];
  const selectedIndex = clamp(modal.selectedIndex, 0, items.length - 1);
  const surfaceWidth = clamp(Math.floor(width * 0.16), 10, 20);
  const stateWidth = 12;
  const detailWidth = Math.max(16, width - surfaceWidth - stateWidth - 8);
  rows.push(`  ${padDisplay('Surface', surfaceWidth)}  ${padDisplay('State', stateWidth)}  ${padDisplay('Detail', detailWidth)}`);
  const window = stableWindow(items.length, selectedIndex, Math.max(1, height - 2));
  if (window.start > 0) rows.push(`${GLYPHS.navigation.moreAbove} ${window.start} more connection(s) above`);
  for (let index = window.start; index < window.end; index += 1) {
    const entry = items[index]!;
    const selected = index === selectedIndex;
    const marker = selected ? (modal.focusPane === 'settings' ? GLYPHS.navigation.selected : '\u2022') : ' ';
    rows.push(`${marker} ${padDisplay(connectionSurfaceLabel(entry.surface), surfaceWidth)}  ${padDisplay(entry.state, stateWidth)}  ${padDisplay(entry.detail, detailWidth)}`);
  }
  if (window.end < items.length) rows.push(`${GLYPHS.navigation.moreBelow} ${items.length - window.end} more connection(s) below`);
  return rows.slice(0, height);
}

/**
 * The detail pane for one connection: the state, what it means, and every next
 * step verbatim. The next steps are the daemon's requirements, so they are
 * listed in full rather than summarized — a truncated instruction is a wrong
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
