/**
 * renderHelpOverlay, the /commands reference: keyboard shortcuts plus the
 * full slash-command list, drawn with the modal surface kit as one grouped,
 * filterable kit list (✦ group headers, each entry's description on the left
 * and its key or command right-aligned, muted). The search row is always
 * live; ↑↓ scroll.
 *
 * `?` and `/help` open the searchable command browser (a selection modal that
 * runs the picked command) instead; that is a different, complementary
 * surface, not this one.
 */

import type { SlashCommand } from '../input/command-registry.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import type { OverlayFilter } from '../input/overlay-filter.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { activeTokens } from './theme.ts';
import {
  beginModal,
  finishModal,
  searchRow,
  scrollCountText,
  type KitHint,
  type SurfaceLayer,
} from './surface-kit.ts';
import { drawList, listScrollEnd, type KitRow } from './surface-kit-list.ts';
import { drawTextBlock } from './surface-kit-extra.ts';

export { renderShortcutsOverlay } from './shortcuts-overlay.ts';

interface HelpGroup {
  readonly title: string;
  readonly entries: Array<{ readonly label: string; readonly right: string }>;
}

/**
 * The row strings ("  Title", "  ────", "  key\tdescription", "") become
 * groups: a title row opens a group, rule rows are dropped, entry rows split
 * at the tab into key (right-aligned) and description (the row's label).
 */
function groupsFromRows(rows: readonly string[]): HelpGroup[] {
  const groups: HelpGroup[] = [];
  for (const row of rows) {
    const text = row.trim();
    if (!text || text.startsWith('\u2500')) continue;
    const tab = text.indexOf('\t');
    if (tab < 0) {
      groups.push({ title: text, entries: [] });
      continue;
    }
    if (groups.length === 0) groups.push({ title: 'Commands', entries: [] });
    groups[groups.length - 1]!.entries.push({ right: text.slice(0, tab).trim(), label: text.slice(tab + 1).trim() });
  }
  return groups.filter((g) => g.entries.length > 0);
}

/** Every help group for the live keybindings and registry. */
function helpGroups(keybindingsManager: KeybindingsManager, commands?: SlashCommand[]): HelpGroup[] {
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

  const shortcutLine = (label: string, desc: string): string => `  ${label}\t${desc}`;

  // Keyboard shortcut sections
  const shortcutRows: string[] = [
    '  Core Navigation',
    '  ' + '\u2500'.repeat(40),
    `  ${'Up / Down'}\tRecall input history; Down at bottom focuses the process indicator`,
    `  ${'PageUp / PageDn'}\tScroll by full page`,
    `  ${kb('search')}\tSearch conversation (Ctrl+F)`,
    '',
    '  Prompt And Editing',
    '  ' + '\u2500'.repeat(40),
    `  ${'Enter'}\tSubmit message (composer empty: open the block-actions menu)`,
    `  ${'Shift+Enter'}\tInsert newline`,
    `  ${kb('paste')}\tPaste (image priority)`,
    `  ${(kb('undo') + ' / ' + kb('redo'))}\tUndo / redo`,
    shortcutLine('(paste >8 lines)', 'Folds to [TEXT: pN, M lines]; /pastes previews it before you submit'),
    '',
    '  Overlays And Views',
    '  ' + '\u2500'.repeat(40),
    shortcutLine('?  or  /help', 'Open the command browser (search & run any command)'),
    shortcutLine('/commands', 'This reference: keyboard shortcuts + full command list'),
    shortcutLine('/shortcuts', 'Keyboard-shortcuts-only reference (a separate, generated overlay)'),
    shortcutLine(kb('command-palette'), 'Command palette: every command and view'),
    shortcutLine(`F2 / ${kb('open-agents')}`, 'Agents: running agents, chains and hosted sessions'),
    shortcutLine('/usage', 'Usage: context, tokens and cost'),
    shortcutLine('/changes', 'Changes: files, diff, review'),
    shortcutLine('/notifications', 'Notification history'),
    shortcutLine('Esc', 'Close the top modal (one level)'),
    // A partial path under the cursor claims Tab for completion; otherwise it
    // collapses or expands the nearest block.
    shortcutLine('Tab', 'Path-complete, else collapse/expand block'),
    '',
  ];

  // Featured commands shown in the Quick Start section.
  // Each entry is [commandName, subcommandOrArgHint, description].
  // Commands not registered in the live registry are omitted at render time.
  const FEATURED_COMMANDS: Array<[name: string, argHint: string, desc: string]> = [
    ['onboarding',   '',           'Open the onboarding wizard with current settings preloaded'],
    ['agents',       '',           'Agents: running agents, chains and hosted sessions'],
    ['usage',        '',           'Usage: context, tokens and cost'],
    ['changes',      '',           'Changes: files, tinted diff, review and staging'],
    ['notifications','',           'Notification history'],
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
    ['tasks',        '',           'Task surface for list/show/pause/resume/output'],
  ];

  // Build command rows from featured list, filtering out unregistered commands.
  function featuredRow(name: string, argHint: string, desc: string): string {
    const invocation = argHint ? `/${name} ${argHint}` : `/${name}`;
    return `  ${invocation}\t${desc}`;
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
    ['clear',       'Start a fresh conversation (current one saved)'],
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
    essentialRows.push(`  ${`/${name}`}\t${desc}`);
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
      const nameCol = `/${cmd.name}`;
      commandRows.push(`  ${nameCol}\t${cmd.description}`);
    }
    // No command cap: the overlay list scrolls,
    // so the full remaining registry is listed rather than truncated at 24.
    const remainder = [...commands]
      .filter((cmd) => !seen.has(cmd.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (remainder.length > 0) {
      commandRows.push('', '  More Commands', '  ' + '\u2500'.repeat(40));
      for (const cmd of remainder) {
        const nameCol = `/${cmd.name}`;
        commandRows.push(`  ${nameCol}\t${cmd.description}`);
      }
    }
  } else if (!hasCommand('help')) {
    commandRows.push('', '  Essentials', '  ' + '\u2500'.repeat(40));
    commandRows.push('  /commands\tShow this help overlay');
    commandRows.push('  /help\tBrowse & run any command');
    commandRows.push('  /shortcuts\tKeyboard shortcut reference');
    commandRows.push('  /model\tSelect LLM model');
    commandRows.push('  /clear\tStart a fresh conversation (current one saved)');
  }

  return groupsFromRows([...shortcutRows, ...commandRows]);
}

function filterGroups(groups: readonly HelpGroup[], query: string): HelpGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...groups];
  return groups
    .map((g) => ({
      title: g.title,
      entries: g.title.toLowerCase().includes(q)
        ? g.entries
        : g.entries.filter((e) => e.label.toLowerCase().includes(q) || e.right.toLowerCase().includes(q)),
    }))
    .filter((g) => g.entries.length > 0);
}

const HINTS: readonly KitHint[] = [['↑↓', 'scroll'], ['?', 'close']];

/**
 * Render the help overlay as a SurfaceLayer in screen coordinates.
 *
 * @param scrollOffset  Rows scrolled past the top of the list.
 * @param filter        The search row's query; the renderer records how far the list can scroll in it.
 */
export function renderHelpOverlay(
  screenWidth: number,
  screenHeight: number,
  keybindingsManager: KeybindingsManager,
  commands?: SlashCommand[],
  scrollOffset = 0,
  filter?: OverlayFilter,
): SurfaceLayer {
  const t = activeTokens();
  const query = filter?.query ?? '';
  const all = helpGroups(keybindingsManager, commands);
  const groups = filterGroups(all, query);
  const f = beginModal(screenWidth, screenHeight, { title: 'Help', hints: HINTS });
  const total = all.reduce((n, g) => n + g.entries.length, 0);
  const shown = groups.reduce((n, g) => n + g.entries.length, 0);
  searchRow(f, f.top, query, 'Filter commands and shortcuts', query ? `${shown} of ${total}` : `${total} entries`);

  const top = f.top + 2;
  if (groups.length === 0) {
    if (filter) filter.maxScroll = 0;
    drawTextBlock(f.canvas, f.l, top, f.r - f.l + 1, [{ text: `Nothing matches "${query}".`, style: { fg: t.textMuted } }], f.bottom);
    return finishModal(f);
  }

  const rows: KitRow[] = [];
  for (const g of groups) {
    rows.push({ header: g.title });
    for (const e of g.entries) rows.push({ label: e.label, right: e.right });
  }
  // The furthest start that still fills the list, by drawList's own spacing rules.
  const listOptions = { rows, top, bottom: f.bottom, x0: f.l, x1: f.r };
  const maxStart = listScrollEnd(f.canvas, listOptions);
  if (filter) filter.maxScroll = maxStart;
  const res = drawList(f.canvas, { ...listOptions, scrollStart: Math.min(scrollOffset, maxStart) });
  f.hintRight = scrollCountText(res.above, res.below);
  return finishModal(f);
}
