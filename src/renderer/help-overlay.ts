/**
 * renderHelpOverlay — renders the help overlay with keyboard shortcuts and slash commands.
 *
 * Toggle with `?` key or `/help` command.
 */

import { type Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import type { SlashCommand } from '../input/command-registry.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import { getOverlaySurfaceMetrics } from './overlay-viewport.ts';
import { getVisibleWindow } from './surface-layout.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';

function toModalSections(rows: readonly string[]): import('./modal-factory.ts').ModalSection[] {
  return rows.map((row) => {
    if (row === '') return { type: 'spacer' as const };
    if (row.startsWith('  ') && !row.slice(2).includes('  ')) {
      return { type: 'title' as const, content: row.trim() };
    }
    if (row.startsWith('  \u2500')) return { type: 'separator' as const };
    return { type: 'text' as const, content: row };
  });
}

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
  keybindingsManager: KeybindingsManager,
  commands?: SlashCommand[],
  scrollOffset = 0,
  viewportHeight = process.stdout.rows || 24,
): Line[] {
  const kb = (action: Parameters<typeof keybindingsManager.getComboLabel>[0]) => keybindingsManager.getComboLabel(action);

  const hasCommand = (name: string): boolean => Boolean(commands?.some((command) => command.name === name || (command.aliases ?? []).includes(name)));

  // Keyboard shortcut sections
  const shortcutRows: string[] = [
    '  Core Navigation',
    '  ' + '\u2500'.repeat(40),
    `  ${'Up / Down'.padEnd(20)}  Scroll / history recall`,
    `  ${'PageUp / PageDn'.padEnd(20)}  Scroll by full page`,
    `  ${kb('search').padEnd(20)}  Search conversation (Ctrl+F)`,
    '',
    '  Prompt And Editing',
    '  ' + '\u2500'.repeat(40),
    `  ${'Enter'.padEnd(20)}  Submit message`,
    `  ${'Shift+Enter'.padEnd(20)}  Insert newline`,
    `  ${kb('paste').padEnd(20)}  Paste (image priority)`,
    `  ${(kb('undo') + ' / ' + kb('redo')).padEnd(20)}  Undo / redo`,
    '',
    '  Overlays And Panels',
    '  ' + '\u2500'.repeat(40),
    `  ${'?'.padEnd(20)}  Toggle help`,
    `  ${'/shortcuts'.padEnd(20)}  Full keyboard shortcuts`,
    `  ${kb('panel-picker').padEnd(20)}  Open or focus the panel workspace`,
    '',
  ];

  // Featured commands shown in the Quick Start section.
  // Each entry is [commandName, subcommandOrArgHint, description].
  // Commands not registered in the live registry are omitted at render time.
  const FEATURED_COMMANDS: Array<[name: string, argHint: string, desc: string]> = [
    ['onboarding',   '',           'Open the onboarding wizard with current settings preloaded'],
    ['cockpit',      '',           'Unified runtime control room'],
    ['settings',     '',           'Settings and config browser'],
    ['provider',     '',           'Choose provider or model family'],
    ['subscription', '',           'Review provider logins and subscriptions'],
    ['marketplace',  'open',       'Browse plugins, skills, and packs'],
    ['remote',       'setup',      'Review remote, bridge, and tunnel flows'],
    ['sandbox',      'review',     'Inspect secure execution posture'],
    ['security',     '',           'Security review workspace'],
    ['policy',       '',           'Simulation, lint, and preflight review'],
    ['incident',     '',           'Incident workspace and export flows'],
    ['knowledge',    '',           'Durable knowledge and review queue'],
    ['hooks',        '',           'Hook workbench and runtime activity'],
    ['orchestration','',           'Graph and recursive-agent control room'],
    ['communication','',           'Structured agent communication workspace'],
    ['tasks',        '',           'Task surface for list/show/pause/resume/output'],
  ];

  // Build command rows from featured list, filtering out unregistered commands.
  function featuredRow(name: string, argHint: string, desc: string): string {
    const invocation = argHint ? `/${name} ${argHint}` : `/${name}`;
    return `  ${invocation.padEnd(23)}  ${desc}`;
  }

  const quickStartRows: string[] = [];
  try {
    for (const [name, argHint, desc] of FEATURED_COMMANDS) {
      if (!hasCommand(name)) continue; // omit if not in live registry
      quickStartRows.push(featuredRow(name, argHint, desc));
    }
  } catch (err) {
    // A plugin command getter threw during registry traversal. Fall back to an
    // unfiltered quick-start list so /help remains reachable.
    logger.warn(`[help-overlay] registry traversal error during command filter; using unfiltered list: ${err}`);
    quickStartRows.length = 0;
    for (const [name, argHint, desc] of FEATURED_COMMANDS) {
      quickStartRows.push(featuredRow(name, argHint, desc));
    }
  }

  const commandRows: string[] = [];
  if (quickStartRows.length > 0) {
    commandRows.push('  Quick Start', '  ' + '\u2500'.repeat(40), ...quickStartRows, '');
  }

  if (commands && commands.length > 0) {
    commandRows.push('', '  Available Slash Commands', '  ' + '\u2500'.repeat(40));
    const preferred = ['setup', 'cockpit', 'settings', 'provider', 'subscription', 'marketplace', 'remote', 'sandbox', 'security', 'policy', 'incident', 'knowledge', 'hooks', 'orchestration', 'communication', 'tasks'];
    const seen = new Set<string>();
    for (const name of preferred) {
      const cmd = commands.find((entry) => entry.name === name);
      if (!cmd) continue;
      seen.add(cmd.name);
      const nameCol = `/${cmd.name}`.padEnd(18);
      commandRows.push(`  ${nameCol}  ${cmd.description}`);
    }
    const remainder = [...commands]
      .filter((cmd) => !seen.has(cmd.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 24);
    if (remainder.length > 0) {
      commandRows.push('', '  More Commands', '  ' + '\u2500'.repeat(40));
      for (const cmd of remainder) {
        const nameCol = `/${cmd.name}`.padEnd(18);
        commandRows.push(`  ${nameCol}  ${cmd.description}`);
      }
    }
  } else if (!hasCommand('help')) {
    commandRows.push('', '  Essentials', '  ' + '\u2500'.repeat(40));
    commandRows.push('  /help               Show this help overlay');
    commandRows.push('  /shortcuts          Keyboard shortcut reference');
    commandRows.push('  /model              Select LLM model');
    commandRows.push('  /clear              Clear conversation');
  }

  const allRows = [...shortcutRows, ...commandRows];

  // Apply scroll offset — show a window of rows
  const metrics = getOverlaySurfaceMetrics(width, viewportHeight, {
    chromeRows: 4,
    minContentRows: 8,
    maxContentRows: 12,
  });
  const maxVisible = metrics.contentRows;
  const clampedOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, allRows.length - maxVisible)));
  const visibleRows = allRows.slice(clampedOffset, clampedOffset + maxVisible);
  const window = getVisibleWindow(allRows.length, clampedOffset, maxVisible);

  return ModalFactory.createModal(
    {
      title: 'Help',
      width: metrics.boxWidth,
      margin: metrics.margin,
      targetContentRows: metrics.contentRows,
      tabs: [
        { label: 'Overview', active: true },
        { label: 'Commands' },
      ],
      sections: toModalSections(visibleRows),
      helpers: allRows.length > maxVisible
        ? [{ content: `[${window.start + 1}-${Math.min(allRows.length, clampedOffset + visibleRows.length)} of ${allRows.length}]` }]
        : undefined,
      hints: ['? or Esc Close', 'Up/Down Scroll'],
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
  keybindingsManager: KeybindingsManager,
  scrollOffset = 0,
  viewportHeight = process.stdout.rows || 24,
): Line[] {
  function row(key: string, desc: string): string {
    const keyCol = key.length > 20 ? key.slice(0, 19) + '\u2026' : key.padEnd(20);
    return `  ${keyCol}  ${desc}`;
  }

  // Helper: get the label for a bindable action, falling back to literal string.
  const kb = (action: Parameters<typeof keybindingsManager.getComboLabel>[0]) => keybindingsManager.getComboLabel(action);

  const allRows: string[] = [
    '  Navigation',
    '  ' + '\u2500'.repeat(40),
    row('Up / Down', 'Scroll / history recall'),
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
    row('Tab', 'Swap focus between input and panel workspace'),
    row(kb('panel-picker'), 'Open / focus / hide panel workspace'),
    row(kb('panel-tab-next'), 'Next workspace panel tab'),
    row(kb('panel-tab-prev'), 'Previous workspace panel tab'),
    '',
    `  Config: /keybindings to list and customize`,
  ];

  const metrics = getOverlaySurfaceMetrics(width, viewportHeight, {
    chromeRows: 4,
    minContentRows: 8,
    maxContentRows: 12,
  });
  const maxVisible = metrics.contentRows;
  const clampedOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, allRows.length - maxVisible)));
  const visibleRows = allRows.slice(clampedOffset, clampedOffset + maxVisible);
  const window = getVisibleWindow(allRows.length, clampedOffset, maxVisible);

  return ModalFactory.createModal(
    {
      title: 'Keyboard Shortcuts',
      width: metrics.boxWidth,
      margin: metrics.margin,
      targetContentRows: metrics.contentRows,
      tabs: [{ label: 'Shortcuts', active: true }],
      sections: toModalSections(visibleRows),
      helpers: allRows.length > maxVisible
        ? [{ content: `[${window.start + 1}-${Math.min(allRows.length, clampedOffset + visibleRows.length)} of ${allRows.length}]` }]
        : undefined,
      hints: ['Esc Close', 'Up/Down Scroll'],
    },
    width,
  );
}
