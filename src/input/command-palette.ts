/**
 * command-palette.ts, the command palette (ctrl+p, also ctrl+k and /palette).
 *
 * One entry point for everything: every registered slash command, built live
 * from the registry so it can never drift from the real command set. With no
 * query the palette shows four curated groups (Suggested, Session, Views,
 * Settings) and then every other command; typing filters across names,
 * aliases, titles, descriptions, categories and search words (old pane names
 * such as "fleet", "cockpit", "tokens" and "git" find the modal that holds
 * them now: Agents, Usage, Changes, Notifications). The slash
 * command sits right-aligned on every row, so the palette also teaches it.
 *
 * Suggested learns from what you use (per process); until it has something
 * to learn from it offers a sensible starting set.
 *
 * Enter runs the selected command; a command that needs arguments (and tab,
 * for any command) fills the composer instead so the arguments can be typed.
 */

import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { SlashCommand } from './command-registry.ts';
import type { SurfaceModal, SurfaceModalHost } from './surface-modal-host.ts';
import type { SurfaceLayer } from '../renderer/surface-kit.ts';
import { renderCommandPalette } from '../renderer/command-palette.ts';
import { isTextBackspace } from './delete-key-policy.ts';
import { AGENT_VIEW_NAMES, CHANGES_VIEW_NAMES, USAGE_VIEW_NAMES } from './views.ts';
import type { PaletteEntry, PaletteGroup, PaletteRunMode, PaletteSection, PaletteView } from './command-palette-types.ts';
export type { PaletteEntry, PaletteGroup, PaletteRunMode, PaletteSection } from './command-palette-types.ts';



interface CuratedEntry {
  readonly title: string;
  readonly group: Exclude<PaletteGroup, 'Suggested' | 'Commands'>;
  readonly keywords?: readonly string[];
  readonly right?: string;
}

/**
 * The curated groups, by command name. A name that is not registered in this
 * build is skipped, so the table never shows a command that does not exist.
 */
const CURATED: ReadonlyArray<readonly [string, CuratedEntry]> = [
  ['resume', { title: 'Resume a session', group: 'Session', keywords: ['open', 'load'] }],
  ['session', { title: 'Sessions', group: 'Session', keywords: ['saved', 'hosted', 'history'] }],
  ['clear', { title: 'Clear the conversation', group: 'Session', keywords: ['new', 'reset'] }],
  ['compact', { title: 'Compact context', group: 'Session', keywords: ['summarize', 'tokens'] }],
  ['fork', { title: 'Fork from here', group: 'Session', keywords: ['branch'] }],
  ['bookmarks', { title: 'Bookmarks', group: 'Session' }],
  ['replay', { title: 'Replay a session', group: 'Session' }],
  ['agents', { title: 'Agents', group: 'Views', keywords: [...AGENT_VIEW_NAMES, 'hosted', 'acp', 'claude code', 'codex', 'opencode', 'steer', 'stop'] }],
  ['usage', { title: 'Usage', group: 'Views', keywords: [...USAGE_VIEW_NAMES, 'budget', 'compact', 'price'] }],
  ['changes', { title: 'Changes', group: 'Views', keywords: [...CHANGES_VIEW_NAMES, 'files', 'stage', 'commit', 'hunk'] }],
  ['notifications', { title: 'Notifications', group: 'Views', keywords: ['notifications', 'alerts', 'messages', 'history', 'toasts'] }],
  ['context', { title: 'Context inspector', group: 'Views', keywords: ['tokens', 'window'] }],
  ['work-plan', { title: 'Work plan', group: 'Views', keywords: ['todo', 'plan'] }],
  ['hosted', { title: 'Hosted sessions', group: 'Views', keywords: ['daemon'] }],
  ['health', { title: 'Health', group: 'Views', keywords: ['doctor'] }],
  ['settings', { title: 'Settings', group: 'Settings', keywords: ['preferences', 'options', 'theme'] }],
  ['model', { title: 'Switch model', group: 'Settings', keywords: ['provider', 'llm'] }],
  ['effort', { title: 'Reasoning effort', group: 'Settings', keywords: ['thinking'] }],
  ['shortcuts', { title: 'Keyboard shortcuts', group: 'Settings', keywords: ['keys', 'help'], right: '?' }],
  ['keybindings', { title: 'Keybindings', group: 'Settings', keywords: ['keys'] }],
  ['mode', { title: 'Approval mode', group: 'Settings', keywords: ['permissions', 'hitl'] }],
  ['profiles', { title: 'Profiles', group: 'Settings' }],
  ['local-auth', { title: 'Local accounts', group: 'Settings', keywords: ['accounts', 'users', 'auth', 'password', 'local-auth'] }],
  ['tts', { title: 'Voice and speech', group: 'Settings', keywords: ['voice'] }],
];

/** The Suggested group before there is any usage to learn from. */
const DEFAULT_SUGGESTED = ['changes', 'model', 'compact'];
const SUGGESTED_COUNT = 3;

/** How often each command was run from the palette in this process. */
const usage = new Map<string, number>();

export function recordPaletteUse(id: string): void {
  usage.set(id, (usage.get(id) ?? 0) + 1);
}

/** Test hook. */
export function resetPaletteUsageForTests(): void {
  usage.clear();
}

function hasRequiredArgs(command: SlashCommand): boolean {
  const hint = command.argsHint ?? command.usage ?? '';
  return /<[^>]+>/.test(hint.replace(/\[[^\]]*\]/g, ''));
}

/** Title for a command outside the curated table: its description's first clause. */
function titleFromDescription(command: SlashCommand): string {
  const text = command.description.trim();
  if (!text) return `/${command.name}`;
  const first = text.split(/(?<=[.;])\s/)[0]!.replace(/[.;]$/, '');
  return first.length > 0 ? first : text;
}

/** Build the palette's entries from the registered commands. */
export function buildPaletteEntries(commands: readonly SlashCommand[], categories: ReadonlyMap<string, string>): PaletteEntry[] {
  const curated = new Map(CURATED);
  const entries: PaletteEntry[] = [];
  for (const command of commands) {
    const c = curated.get(command.name);
    entries.push({
      id: command.name,
      title: c?.title ?? titleFromDescription(command),
      description: command.description,
      category: categories.get(command.name) ?? 'Other',
      group: c?.group ?? 'Commands',
      aliases: command.aliases ?? [],
      keywords: c?.keywords ?? [],
      argsHint: command.argsHint ?? command.usage,
      needsArgs: hasRequiredArgs(command),
      right: c?.right,
    });
  }
  // Curated entries in table order, the rest alphabetically by name.
  const order = new Map(CURATED.map(([name], index) => [name, index]));
  return entries.sort((a, b) => {
    const oa = order.get(a.id);
    const ob = order.get(b.id);
    if (oa !== undefined && ob !== undefined) return oa - ob;
    if (oa !== undefined) return -1;
    if (ob !== undefined) return 1;
    return a.id.localeCompare(b.id);
  });
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function wordScore(entry: PaletteEntry, word: string): number {
  const name = entry.id.toLowerCase();
  const title = entry.title.toLowerCase();
  if (name === word) return 100;
  if (name.startsWith(word)) return 80;
  if (entry.aliases.some((a) => a.toLowerCase() === word)) return 75;
  if (entry.aliases.some((a) => a.toLowerCase().startsWith(word))) return 70;
  if (title.split(/[\s/-]+/).some((w) => w.startsWith(word))) return 60;
  if (entry.keywords.some((k) => k.toLowerCase().startsWith(word))) return 55;
  if (name.includes(word) || title.includes(word)) return 40;
  if (entry.keywords.some((k) => k.toLowerCase().includes(word))) return 35;
  if (entry.description.toLowerCase().includes(word)) return 20;
  if (entry.category.toLowerCase().includes(word)) return 10;
  return 0;
}

/** Match score for a query (every word must match somewhere), or 0 for no match. */
export function paletteScore(entry: PaletteEntry, query: string): number {
  const words = query.trim().toLowerCase().replace(/^\//, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  let total = 0;
  for (const word of words) {
    const s = wordScore(entry, word);
    if (s === 0) return 0;
    total += s;
  }
  return total;
}


// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

export interface CommandPaletteOptions {
  readonly entries: readonly PaletteEntry[];
  /** Run or fill the composer with a command; the palette has already closed. */
  readonly onRun: (entry: PaletteEntry, mode: PaletteRunMode) => void;
  /** Optional live note for a row (e.g. the current model), shown muted after its title. */
  readonly describe?: (id: string) => string | undefined;
}

export class CommandPalette implements SurfaceModal, PaletteView {
  readonly name = 'command-palette';
  query = '';
  selectedIndex = 0;
  private sectionsCache: { query: string; sections: PaletteSection[] } | null = null;

  constructor(private readonly options: CommandPaletteOptions) {}

  get entries(): readonly PaletteEntry[] {
    return this.options.entries;
  }

  describe(id: string): string | undefined {
    return this.options.describe?.(id);
  }

  /** The groups shown for the current query. */
  sections(): PaletteSection[] {
    if (this.sectionsCache?.query === this.query) return this.sectionsCache.sections;
    const sections: PaletteSection[] = [];
    if (this.query.trim().length === 0) {
      const byId = new Map(this.entries.map((e) => [e.id, e]));
      const learned = [...usage.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
      const suggested: PaletteEntry[] = [];
      for (const id of [...learned, ...DEFAULT_SUGGESTED]) {
        const entry = byId.get(id);
        if (entry && !suggested.includes(entry)) suggested.push(entry);
        if (suggested.length >= SUGGESTED_COUNT) break;
      }
      if (suggested.length > 0) sections.push({ group: 'Suggested', entries: suggested });
      for (const group of ['Session', 'Views', 'Settings', 'Commands'] as const) {
        const entries = this.entries.filter((e) => e.group === group && !suggested.includes(e));
        if (entries.length > 0) sections.push({ group, entries });
      }
    } else {
      const ranked = this.entries
        .map((entry, index) => ({ entry, index, score: paletteScore(entry, this.query) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((r) => r.entry);
      if (ranked.length > 0) sections.push({ group: 'Commands', entries: ranked });
    }
    this.sectionsCache = { query: this.query, sections };
    return sections;
  }

  /** Entries in display order (what up and down walk). */
  flat(): PaletteEntry[] {
    return this.sections().flatMap((s) => s.entries);
  }

  getSelected(): PaletteEntry | null {
    const flat = this.flat();
    return flat[Math.max(0, Math.min(this.selectedIndex, flat.length - 1))] ?? null;
  }

  setQuery(query: string): void {
    this.query = query;
    this.selectedIndex = 0;
  }

  move(delta: number): void {
    const count = this.flat().length;
    if (count === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + count) % count;
  }

  handleToken(token: InputToken, host: SurfaceModalHost): void {
    if (token.type === 'text') {
      const text = [...token.value].filter((ch) => ch >= ' ' && ch !== '\x7f').join('');
      if (text) this.setQuery(this.query + text);
      return;
    }
    if (token.type !== 'key') return;
    const key = token.logicalName ?? '';
    if (token.ctrl && (key === 'p' || key === 'k')) {
      host.close(this, 'escape');
      return;
    }
    if (key === 'up') this.move(-1);
    else if (key === 'down') this.move(1);
    else if (key === 'pageup') this.move(-10);
    else if (key === 'pagedown') this.move(10);
    else if (isTextBackspace(key)) this.setQuery(this.query.slice(0, -1));
    else if (key === 'enter' || key === 'tab') {
      const entry = this.getSelected();
      if (!entry) return;
      host.close(this, 'done');
      recordPaletteUse(entry.id);
      this.options.onRun(entry, key === 'tab' || entry.needsArgs ? 'fill' : 'run');
    }
  }

  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    return renderCommandPalette(this, screenWidth, screenHeight);
  }
}
