/**
 * renderHelpOverlay — renders the help overlay with keyboard shortcuts and slash commands.
 *
 * Toggle with `?` key or `/help` command.
 */

import { type Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import type { SlashCommand } from '../input/command-registry.ts';
import { getKeybindingsManager } from '../input/keybindings.ts';

/**
 * Render the help overlay as Line[].
 * Shows keyboard shortcuts summary and slash commands.
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
  const km = getKeybindingsManager();
  const kb = (action: Parameters<typeof km.getComboLabel>[0]) => km.getComboLabel(action);

  // Keyboard shortcut sections
  const shortcutRows: string[] = [
    '  Navigation',
    '  ' + '\u2500'.repeat(40),
    `  ${'\u2191 / \u2193'.padEnd(20)}  Scroll / history recall`,
    `  ${'PageUp / PageDn'.padEnd(20)}  Scroll by full page`,
    `  ${kb('search').padEnd(20)}  Search conversation (Ctrl+F)`,
    '',
    '  Editing',
    '  ' + '\u2500'.repeat(40),
    `  ${'Enter'.padEnd(20)}  Submit message`,
    `  ${'Shift+Enter'.padEnd(20)}  Insert newline`,
    `  ${kb('paste').padEnd(20)}  Paste (image priority)`,
    `  ${(kb('undo') + ' / ' + kb('redo')).padEnd(20)}  Undo / redo`,
    '',
    '  Modals',
    '  ' + '\u2500'.repeat(40),
    `  ${'?'.padEnd(20)}  Toggle help`,
    `  ${'/shortcuts'.padEnd(20)}  Full keyboard shortcuts`,
    '',
  ];

  // Commands section
  const commandRows: string[] = ['  Commands', '  ' + '\u2500'.repeat(40)];
  if (commands && commands.length > 0) {
    const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));
    for (const cmd of sorted) {
      const nameCol = `/${cmd.name}`.padEnd(18);
      const aliases = (cmd.aliases ?? []).length > 0 ? ` (${(cmd.aliases ?? []).map(a => '/' + a).join(', ')})` : '';
      commandRows.push(`  ${nameCol}  ${cmd.description}${aliases}`);
    }
  } else {
    // Fallback: show known built-in commands
    commandRows.push('  /help             Show this help overlay');
    commandRows.push('  /shortcuts        Keyboard shortcut reference');
    commandRows.push('  /model            Select LLM model');
    commandRows.push('  /clear            Clear conversation');
  }

  const allRows = [...shortcutRows, ...commandRows];

  // Apply scroll offset — show a window of rows
  const maxVisible = Math.max(10, Math.floor((process.stdout.rows || 80) - 10));
  const clampedOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, allRows.length - maxVisible)));
  const visibleRows = allRows.slice(clampedOffset, clampedOffset + maxVisible);

  const scrollInfo = allRows.length > maxVisible
    ? `  [${clampedOffset + 1}-${clampedOffset + visibleRows.length} of ${allRows.length}]`
    : '';

  return ModalFactory.createModal(
    {
      title: 'Help',
      width: 80,
      sections: [
        ...visibleRows.map((row) => (
          row.startsWith('  \u2500') ? { type: 'separator' as const }
          : row === '' ? { type: 'separator' as const }
          : { type: 'text' as const, content: row }
        )),
        ...(scrollInfo ? [{ type: 'separator' as const }, { type: 'text' as const, content: scrollInfo, style: { fg: '244', dim: true } }] : []),
      ],
      hints: ['? or Esc Close', '\u2191\u2193 Scroll'],
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
