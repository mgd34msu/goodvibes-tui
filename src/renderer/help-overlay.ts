/**
 * renderHelpOverlay — renders the full-screen help/shortcuts overlay as Line[].
 *
 * Organized by category:
 *   - Navigation
 *   - Editing & Input
 *   - Modals & Selection
 *   - Commands (sampled from key commands)
 *
 * Toggle with `?` key or `/help` command.
 */

import { type Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import type { SlashCommand } from '../input/command-registry.ts';

// ---------------------------------------------------------------------------
// Section definitions
// ---------------------------------------------------------------------------

const NAVIGATION_SHORTCUTS: Array<{ key: string; desc: string }> = [
  { key: '\u2191 / \u2193', desc: 'Scroll / history recall (when prompt is single-line)' },
  { key: 'PageUp / PageDn', desc: 'Scroll by full viewport page' },
  { key: 'Home / End', desc: 'Jump to start / end of prompt line' },
  { key: 'Ctrl+F', desc: 'Toggle search mode (type to search, Enter/Tab locks)' },
  { key: 'Mouse wheel', desc: 'Scroll conversation' },
];

const EDITING_SHORTCUTS: Array<{ key: string; desc: string }> = [
  { key: 'Enter', desc: 'Submit message' },
  { key: 'Shift+Enter', desc: 'Insert newline in prompt' },
  { key: '@', desc: 'Open file picker (at word start)' },
  { key: '/', desc: 'Enter slash-command mode' },
  { key: 'Ctrl+V', desc: 'Paste (image from clipboard first, then text)' },
  { key: 'Ctrl+Z', desc: 'Undo last prompt edit' },
  { key: 'Ctrl+Shift+Z', desc: 'Redo prompt edit' },
  { key: 'Ctrl+U', desc: 'Clear prompt line' },
  { key: 'Ctrl+W', desc: 'Delete word backward' },
  { key: 'Ctrl+K', desc: 'Kill to end of line' },
  { key: 'Ctrl+A', desc: 'Apply nearest diff block / move to line start' },
  { key: 'Ctrl+E', desc: 'Move to end of current line' },
];

const MODAL_SHORTCUTS: Array<{ key: string; desc: string }> = [
  { key: 'Tab', desc: 'Toggle collapse / cycle path completion' },
  { key: 'Ctrl+B', desc: 'Bookmark / unbookmark nearest block' },
  { key: 'Ctrl+Y', desc: 'Copy nearest code/tool block to clipboard' },
  { key: 'Ctrl+S', desc: 'Save nearest block content to file' },
  { key: 'Ctrl+Shift+C', desc: 'Copy text selection to clipboard' },
  { key: 'Click drag', desc: 'Select text in conversation' },
  { key: 'Middle click', desc: 'Paste from clipboard' },
  { key: 'F2', desc: 'Open background process monitor' },
  { key: '?', desc: 'Toggle this help overlay' },
  { key: 'Ctrl+C \u00d72', desc: 'Exit application' },
];

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render the help overlay as Line[].
 *
 * @param width   Terminal width.
 * @param commands  Optional list of registered slash commands to show.
 */
export function renderHelpOverlay(
  width: number,
  commands?: SlashCommand[],
): Line[] {
  // Build rows for each shortcut section
  function shortcutRow(key: string, desc: string): string {
    const keyCol = key.length > 20 ? key.slice(0, 19) + '\u2026' : key.padEnd(20);
    return `  ${keyCol}  ${desc}`;
  }

  const navRows = NAVIGATION_SHORTCUTS.map(s => shortcutRow(s.key, s.desc));
  const editRows = EDITING_SHORTCUTS.map(s => shortcutRow(s.key, s.desc));
  const modalRows = MODAL_SHORTCUTS.map(s => shortcutRow(s.key, s.desc));

  // Commands section — list all registered slash commands with descriptions
  const commandRows: string[] = [];
  if (commands && commands.length > 0) {
    const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));
    for (const cmd of sorted) {
      const nameCol = `/${cmd.name}`.padEnd(18);
      const aliases = (cmd.aliases ?? []).length > 0 ? ` (${(cmd.aliases ?? []).map(a => '/' + a).join(', ')})` : '';
      const usage = cmd.usage ? ` ${cmd.usage}` : '';
      commandRows.push(`  ${nameCol}  ${cmd.description}${aliases}${usage}`);
    }
  } else {
    commandRows.push('  /help  /model  /provider  /config  /tools  /bookmarks  /sessions  /quit  ...');
  }

  return ModalFactory.createModal(
    {
      title: 'Help — Keyboard Shortcuts & Commands',
      width: 84,
      sections: [
        {
          type: 'text',
          content: '  Navigation',
          style: { fg: '#00ffff', bold: true },
        },
        { type: 'separator' },
        ...navRows.map((row) => ({ type: 'text' as const, content: row })),
        { type: 'separator' },
        {
          type: 'text',
          content: '  Editing & Input',
          style: { fg: '#00ffff', bold: true },
        },
        { type: 'separator' },
        ...editRows.map((row) => ({ type: 'text' as const, content: row })),
        { type: 'separator' },
        {
          type: 'text',
          content: '  Modals & Actions',
          style: { fg: '#00ffff', bold: true },
        },
        { type: 'separator' },
        ...modalRows.map((row) => ({ type: 'text' as const, content: row })),
        { type: 'separator' },
        {
          type: 'text',
          content: '  Slash Commands',
          style: { fg: '#00ffff', bold: true },
        },
        { type: 'separator' },
        ...commandRows.map((row) => ({ type: 'text' as const, content: row })),
      ],
      hints: ['? or Esc Close', '\u2191\u2193 Scroll'],
    },
    width,
  );
}
