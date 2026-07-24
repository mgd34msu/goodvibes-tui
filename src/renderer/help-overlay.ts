/**
 * renderHelpOverlay — renders the help overlay with keyboard shortcuts and slash commands.
 *
 * Opened via `/commands`. `?` and `/help` open the searchable command
 * browser (a selection modal that runs the picked command) instead — they
 * are a different, complementary surface, not this one.
 */

import { type Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import type { SlashCommand } from '../input/command-registry.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import { getOverlaySurfaceMetrics } from './overlay-viewport.ts';
import { getVisibleWindow } from './surface-layout.ts';
import { formatHints } from './hint-grammar.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';

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

  const hasCommand = (name: string): boolean => {
    if (!commands) return false;
    for (const command of commands) {
      // A broken plugin may expose a throwing `aliases` getter; skip it rather
      // than crash the overlay (mirrors the Quick Start traversal guard below).
      try {
        if (command.name === name || (command.aliases ?? []).includes(name)) return true;
      } catch { /* skip this command */ }
    }
    return false;
  };

  const shortcutLine = (label: string, desc: string): string => `  ${label.padEnd(20)}  ${desc}`;

  // Enumerate EVERY workspace/panel binding straight from the live keybindings
  // table so each rebindable action (including user overrides) is discoverable
  // here and stays in lockstep with /keybindings. Any action id prefixed
  // `panel-` is a workspace affordance.
  const panelBindingRows: string[] = keybindingsManager
    .getAll()
    .filter((entry) => entry.action.startsWith('panel-'))
    .map((entry) => shortcutLine(keybindingsManager.getComboLabel(entry.action), entry.description));

  // Keyboard shortcut sections
  const shortcutRows: string[] = [
    '  Core Navigation',
    '  ' + '\u2500'.repeat(40),
    `  ${'Up / Down'.padEnd(20)}  Recall input history; Down at bottom focuses the process indicator`,
    `  ${'PageUp / PageDn'.padEnd(20)}  Scroll by full page`,
    `  ${kb('search').padEnd(20)}  Search conversation (Ctrl+F)`,
    '',
    '  Prompt And Editing',
    '  ' + '\u2500'.repeat(40),
    `  ${'Enter'.padEnd(20)}  Submit message (composer empty: open the block-actions menu)`,
    `  ${'Shift+Enter'.padEnd(20)}  Insert newline`,
    `  ${kb('paste').padEnd(20)}  Paste (image priority)`,
    `  ${(kb('undo') + ' / ' + kb('redo')).padEnd(20)}  Undo / redo`,
    shortcutLine('(paste >8 lines)', 'Folds to [TEXT: pN, M lines] — /pastes previews it before you submit'),
    '',
    '  Overlays And Panels',
    '  ' + '\u2500'.repeat(40),
    shortcutLine('?  or  /help', 'Open the command browser (search & run any command)'),
    shortcutLine('/commands', 'This reference: keyboard shortcuts + full command list'),
    shortcutLine('/shortcuts', 'Keyboard-shortcuts-only reference (a separate, generated overlay)'),
    // Precedence (highest first): a visible panel workspace claims Tab for
    // focus-swap; failing that, a partial path under the cursor claims it for
    // completion; only then does it fall through to collapse/expand.
    shortcutLine('Tab', 'Panel focus-swap, else path-complete, else collapse/expand block'),
    ...panelBindingRows,
    '',
    // The shared in-panel contract every workspace panel honors. These are not
    // rebindable global actions \u2014 they are the common controls a focused panel
    // interprets \u2014 so they are documented here rather than pulled from getAll().
    '  In-Panel Controls',
    '  ' + '\u2500'.repeat(40),
    shortcutLine('j / k', 'Move selection down / up'),
    shortcutLine('g / G', 'Jump to top / bottom'),
    shortcutLine('Enter / Esc', 'Activate / dismiss or leave panel'),
    shortcutLine('/', 'Filter the list'),
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

  // Essentials \u2014 the handful of commands worth memorizing, listed first and
  // filtered to what the live registry actually exposes.
  const ESSENTIAL_COMMANDS: Array<[name: string, desc: string]> = [
    ['model',       'Select provider or model'],
    ['sessions',    'Browse and resume saved sessions'],
    ['save',        'Save the current session'],
    ['compact',     'Compact the conversation history'],
    ['clear',       'Clear the conversation display (keeps LLM context)'],
    ['keybindings', 'List and customize key bindings'],
    ['panel',       'Open, focus, or manage panels'],
  ];

  const commandRows: string[] = [];
  // Track command names already surfaced in a curated group so the exhaustive
  // list below does not repeat them.
  const seen = new Set<string>();

  const essentialRows: string[] = [];
  for (const [name, desc] of ESSENTIAL_COMMANDS) {
    if (!hasCommand(name)) continue;
    seen.add(name);
    essentialRows.push(`  ${`/${name}`.padEnd(18)}  ${desc}`);
  }
  if (essentialRows.length > 0) {
    commandRows.push('  Essentials', '  ' + '\u2500'.repeat(40), ...essentialRows, '');
  }

  if (quickStartRows.length > 0) {
    commandRows.push('  Quick Start', '  ' + '\u2500'.repeat(40), ...quickStartRows, '');
  }

  if (commands && commands.length > 0) {
    commandRows.push('', '  Available Slash Commands', '  ' + '\u2500'.repeat(40));
    const preferred = ['setup', 'cockpit', 'settings', 'provider', 'subscription', 'marketplace', 'remote', 'sandbox', 'security', 'policy', 'incident', 'knowledge', 'hooks', 'orchestration', 'communication', 'tasks'];
    for (const name of preferred) {
      const cmd = commands.find((entry) => entry.name === name);
      if (!cmd || seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      const nameCol = `/${cmd.name}`.padEnd(18);
      commandRows.push(`  ${nameCol}  ${cmd.description}`);
    }
    // No command cap: the overlay windows and scrolls (getVisibleWindow below),
    // so the full remaining registry is listed rather than truncated at 24.
    const remainder = [...commands]
      .filter((cmd) => !seen.has(cmd.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (remainder.length > 0) {
      commandRows.push('', '  More Commands', '  ' + '\u2500'.repeat(40));
      for (const cmd of remainder) {
        const nameCol = `/${cmd.name}`.padEnd(18);
        commandRows.push(`  ${nameCol}  ${cmd.description}`);
      }
    }
  } else if (!hasCommand('help')) {
    commandRows.push('', '  Essentials', '  ' + '\u2500'.repeat(40));
    commandRows.push('  /commands           Show this help overlay');
    commandRows.push('  /help               Browse & run any command');
    commandRows.push('  /shortcuts          Keyboard shortcut reference');
    commandRows.push('  /model              Select LLM model');
    commandRows.push('  /clear              Clear the conversation display (keeps LLM context)');
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
      // Single tab: the old second 'Commands' tab had no switch handler (Left/
      // Right did nothing), so it was a dead affordance. The overlay is one
      // scrolling surface, so it advertises exactly one tab.
      tabs: [{ label: 'Overview', active: true }],
      sections: toModalSections(visibleRows),
      helpers: allRows.length > maxVisible
        ? [{ content: `[${window.start + 1}-${Math.min(allRows.length, clampedOffset + visibleRows.length)} of ${allRows.length}]` }]
        : undefined,
      hints: [formatHints([
        { key: 'Up/Down', verb: 'Scroll' },
        { key: '?', verb: 'Help' },
        { key: 'Esc', verb: 'Close' },
      ])],
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

  // Keys that are real, but not KeyAction entries in keybindingsManager
  // (context-dependent chords, or literal characters rather than bindable
  // actions) \u2014 a maintained table rather than hand-picked getAll() calls, so
  // adding a new KeyAction automatically shows up below without anyone
  // remembering to also add a row for it here.
  const HARDCODED_ROWS: ReadonlyArray<[key: string, desc: string]> = [
    ['Up / Down', 'Recall input history; Down at bottom focuses the process indicator'],
    ['PageUp / PageDn', 'Scroll by full page'],
    ['Home / End', 'Jump to start / end of line'],
    ['n / N (search)', 'Next / previous match'],
    ['Mouse wheel', 'Scroll conversation or hovered panel'],
    ['Enter', 'Submit message (composer empty: open the block-actions menu)'],
    ['Shift+Enter', 'Insert newline'],
    ['@', 'Open file picker'],
    ['/', 'Slash command mode'],
    ['Esc', 'Close overlay / cancel generation / clear prompt (context-dependent)'],
    ['Shift+Tab', 'Cycle permission mode (auto-approve / prompt / manual)'],
    ['F2', 'Open the Fleet panel'],
    ['?  or  /help', 'Open the command browser (search & run any command)'],
    // Precedence (highest first): panel focus-swap, else path-completion,
    // else collapse/expand \u2014 see the Panels section's Tab row below for the
    // full chain; this row is the "what does it do here" short form.
    ['Tab', 'Collapse/expand block (composer empty \u2014 see Panels: Tab for full precedence)'],
  ];

  const IN_PANEL_ROWS: ReadonlyArray<[key: string, desc: string]> = [
    ['j / k', 'Move selection down / up'],
    ['g / G', 'Jump to top / bottom'],
    ['/', 'Filter the list'],
  ];

  // Generated from the live keybindings table (default bindings AND any user
  // overrides) so this listing can never drift from what a key actually
  // does \u2014 no action is hand-picked, none can be silently missed.
  const allBindings = keybindingsManager.getAll();
  const panelActionRows = allBindings
    .filter((entry) => entry.action.startsWith('panel-'))
    .map((entry) => row(entry.combos.map((c) => keybindingsManager.formatCombo(c)).join(', '), entry.description));
  const otherActionRows = allBindings
    .filter((entry) => !entry.action.startsWith('panel-'))
    .map((entry) => row(entry.combos.map((c) => keybindingsManager.formatCombo(c)).join(', '), entry.description));

  const allRows: string[] = [
    '  Navigation & Editing',
    '  ' + '\u2500'.repeat(40),
    ...HARDCODED_ROWS.map(([key, desc]) => row(key, desc)),
    '',
    '  Actions & Shortcuts (customize via /keybindings)',
    '  ' + '\u2500'.repeat(40),
    ...otherActionRows,
    '',
    '  Panels',
    '  ' + '\u2500'.repeat(40),
    // Full Tab precedence, stated once here as the authoritative chain: a
    // visible panel workspace claims Tab for focus-swap first; failing that,
    // a partial path under the cursor claims it for completion; only then
    // does it fall through to collapse/expand (the Actions section's row).
    row('Tab', 'Panel focus-swap (1st) > path-complete (2nd) > collapse/expand block (3rd)'),
    ...panelActionRows,
    '',
    '  In-Panel Controls',
    '  ' + '\u2500'.repeat(40),
    ...IN_PANEL_ROWS.map(([key, desc]) => row(key, desc)),
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
      hints: [formatHints([
        { key: 'Up/Down', verb: 'Scroll' },
        { key: 'Esc', verb: 'Close' },
      ])],
    },
    width,
  );
}
