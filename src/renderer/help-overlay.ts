/**
 * renderHelpOverlay — renders the help command list as Line[].
 * Keyboard shortcuts are in /shortcuts (separate command).
 *
 * Toggle with `?` key or `/help` command.
 */

import { type Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import type { SlashCommand } from '../input/command-registry.ts';

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
 * Accessed via /shortcuts command.
 */
export function renderShortcutsOverlay(
  width: number,
  scrollOffset = 0,
): Line[] {
  function row(key: string, desc: string): string {
    const keyCol = key.length > 20 ? key.slice(0, 19) + '\u2026' : key.padEnd(20);
    return `  ${keyCol}  ${desc}`;
  }

  const allRows: string[] = [
    '  Navigation',
    '  ' + '\u2500'.repeat(40),
    row('\u2191 / \u2193', 'Scroll / history recall'),
    row('PageUp / PageDn', 'Scroll by full page'),
    row('Home / End', 'Jump to start / end of line'),
    row('Ctrl+F', 'Search conversation'),
    row('Mouse wheel', 'Scroll conversation'),
    '',
    '  Editing',
    '  ' + '\u2500'.repeat(40),
    row('Enter', 'Submit message'),
    row('Shift+Enter', 'Insert newline'),
    row('@', 'Open file picker'),
    row('/', 'Slash command mode'),
    row('Ctrl+V', 'Paste (image priority)'),
    row('Ctrl+Z / Shift+Z', 'Undo / redo'),
    row('Ctrl+U', 'Clear prompt'),
    row('Ctrl+W', 'Delete word backward'),
    row('Ctrl+K', 'Kill to end of line'),
    row('Ctrl+A', 'Apply diff / line start'),
    row('Ctrl+E', 'Next error / line end'),
    '',
    '  Actions',
    '  ' + '\u2500'.repeat(40),
    row('Tab', 'Collapse/expand block'),
    row('Ctrl+B', 'Bookmark block'),
    row('Ctrl+Y', 'Copy block to clipboard'),
    row('Ctrl+S', 'Save block to file'),
    row('Ctrl+Shift+C', 'Copy selection'),
    row('F2', 'Process monitor'),
    row('?', 'Help overlay'),
    row('Ctrl+C x2', 'Exit'),
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
