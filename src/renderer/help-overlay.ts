/**
 * renderHelpOverlay — renders the help command list as Line[].
 * Keyboard shortcuts are in /shortcuts (separate command).
 *
 * Toggle with `?` key or `/help` command.
 */

import { type Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import type { SlashCommand } from '../input/command-registry.ts';
import { getKeybindingsManager } from '../input/keybindings.ts';

/**
 * Render the help overlay as Line[].
 * Shows only slash commands. Keyboard shortcuts are in /shortcuts.
 *
 * @param width      Terminal width.
 * @param commands   List of registered slash commands.
 * @param scrollOffset  Number of lines scrolled (for navigation).
 */
export function renderHelpOverlay(
  width: number,
  commands?: SlashCommand[],
  scrollOffset = 0,
): Line[] {
  const commandRows: string[] = [];

  if (commands && commands.length > 0) {
    const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));
    for (const cmd of sorted) {
      const nameCol = `/${cmd.name}`.padEnd(18);
      const aliases = (cmd.aliases ?? []).length > 0 ? ` (${(cmd.aliases ?? []).map(a => '/' + a).join(', ')})` : '';
      commandRows.push(`  ${nameCol}  ${cmd.description}${aliases}`);
    }
  } else {
    commandRows.push('  No commands registered');
  }

  // Apply scroll offset — show a window of rows
  const maxVisible = Math.max(10, Math.floor((process.stdout.rows || 24) - 10));
  const clampedOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, commandRows.length - maxVisible)));
  const visibleRows = commandRows.slice(clampedOffset, clampedOffset + maxVisible);

  const scrollInfo = commandRows.length > maxVisible
    ? `  [${clampedOffset + 1}-${clampedOffset + visibleRows.length} of ${commandRows.length}]`
    : '';

  return ModalFactory.createModal(
    {
      title: 'Help — Slash Commands',
      width: 80,
      sections: [
        {
          type: 'text',
          content: '  Type /shortcuts for keyboard shortcut reference',
          style: { fg: '244', dim: true },
        },
        { type: 'separator' },
        ...visibleRows.map((row) => ({ type: 'text' as const, content: row })),
        ...(scrollInfo ? [{ type: 'separator' as const }, { type: 'text' as const, content: scrollInfo, style: { fg: '244', dim: true } }] : []),
      ],
      hints: ['? or Esc Close', '\u2191\u2193 Scroll', '/shortcuts Keys'],
    },
    width,
  );
}

/**
 * renderShortcutsOverlay — renders keyboard shortcuts as Line[].
 * Accessed via /shortcuts command. Reflects live keybindings (user overrides included).
 */
export function renderShortcutsOverlay(
  width: number,
  scrollOffset = 0,
): Line[] {
  const km = getKeybindingsManager();

  function row(key: string, desc: string): string {
    const keyCol = key.length > 20 ? key.slice(0, 19) + '\u2026' : key.padEnd(20);
    return `  ${keyCol}  ${desc}`;
  }

  // Helper: get the label for a bindable action, falling back to literal string.
  const kb = (action: Parameters<typeof km.getComboLabel>[0]) => km.getComboLabel(action);

  const allRows: string[] = [
    '  Navigation',
    '  ' + '\u2500'.repeat(40),
    row('\u2191 / \u2193', 'Scroll / history recall'),
    row('PageUp / PageDn', 'Scroll by full page'),
    row('Home / End', 'Jump to start / end of line'),
    row(kb('search'), 'Search conversation'),
    row('Mouse wheel', 'Scroll conversation'),
    '',
    '  Editing',
    '  ' + '\u2500'.repeat(40),
    row('Enter', 'Submit message'),
    row('Shift+Enter', 'Insert newline'),
    row('@', 'Open file picker'),
    row('/', 'Slash command mode'),
    row(kb('paste'), 'Paste (image priority)'),
    row(`${kb('undo')} / ${kb('redo')}`, 'Undo / redo'),
    row(kb('clear-prompt'), 'Clear prompt'),
    row(kb('delete-word'), 'Delete word backward'),
    row(kb('kill-line'), 'Kill to end of line'),
    row(kb('apply-diff-line-start'), 'Apply diff / line start'),
    row(kb('next-error-line-end'), 'Next error / line end'),
    '',
    '  Actions',
    '  ' + '\u2500'.repeat(40),
    row('Tab', 'Collapse/expand block'),
    row(kb('bookmark'), 'Bookmark block'),
    row(kb('block-copy'), 'Copy block to clipboard'),
    row(kb('block-save'), 'Save block to file'),
    row(kb('copy-selection'), 'Copy selection'),
    row('F2', 'Process monitor'),
    row('?', 'Help overlay'),
    row(`${kb('clear-cancel')} x2`, 'Exit'),
    '',
    '  Panels',
    '  ' + '\u2500'.repeat(40),
    row(kb('panel-picker'), 'Toggle panel sidebar'),
    row(kb('panel-tab-next'), 'Next panel tab'),
    row(kb('panel-tab-prev'), 'Previous panel tab'),
    '',
    `  Config: /keybindings to list and customize`,
  ];

  const maxVisible = Math.max(10, Math.floor((process.stdout.rows || 24) - 10));
  const clampedOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, allRows.length - maxVisible)));
  const visibleRows = allRows.slice(clampedOffset, clampedOffset + maxVisible);

  return ModalFactory.createModal(
    {
      title: 'Keyboard Shortcuts',
      width: 70,
      sections: [
        ...visibleRows.map((r) => (
          r.startsWith('  \u2500') ? { type: 'separator' as const }
          : r === '' ? { type: 'separator' as const }
          : r.startsWith('  ') && !r.includes('  ') ? { type: 'text' as const, content: r, style: { fg: '#00ffff', bold: true } }
          : { type: 'text' as const, content: r }
        )),
      ],
      hints: ['Esc Close', '\u2191\u2193 Scroll'],
    },
    width,
  );
}
