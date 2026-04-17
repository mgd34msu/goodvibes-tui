import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';
import { getDisplayWidth, truncateDisplay } from '../utils/terminal-width.ts';
import { SearchableListPanel } from './scrollable-list-panel.ts';
import type { ComponentHealthMonitor } from '../runtime/perf/panel-health-monitor.ts';
import type { ShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';
import {
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';
import {
  getPanelSearchFocusTransition,
  isPanelSearchCancel,
} from './search-focus.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#94a3b8',
  headerBg: '#1e293b',
  searchFg: '#f97316',
  searchBg: '#1e293b',
  label: '#64748b',
  value: '#e2e8f0',
  dim: '#64748b',
  empty: '#334155',
  selectedFg: '#e2e8f0',
  selectedBg: '#1e3a5f',
  project: '#38bdf8',
  global: '#a78bfa',
  hint: '#475569',
  path: '#94a3b8',
  selectBg: '#1e3a5f',
} as const;

export type SkillOrigin = 'project-local' | 'global' | 'custom';

export interface SkillRecord {
  name: string;
  description: string;
  path: string;
  origin: SkillOrigin;
  dependencies: string[];
  includes: string[];
  frontmatter: Record<string, string>;
}

export interface SkillsPanelOptions {
  shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>;
  componentHealthMonitor?: ComponentHealthMonitor;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length > 0) {
      result[key.trim()] = rest.join(':').trim();
    }
  }
  return result;
}

function getSkillDirectories(cwd: string, homeDir: string): Array<{ root: string; origin: SkillOrigin }> {
  return [
    { root: join(cwd, '.goodvibes', 'skills'), origin: 'project-local' },
    { root: join(cwd, '.goodvibes', 'tui', 'skills'), origin: 'project-local' },
    { root: join(homeDir, '.goodvibes', 'skills'), origin: 'global' },
    { root: join(homeDir, '.goodvibes', 'tui', 'skills'), origin: 'global' },
  ];
}

function readSkillFile(path: string, origin: SkillOrigin): SkillRecord | null {
  if (!existsSync(path)) return null;
  let content = '';
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }

  const frontmatter = parseFrontmatter(content);
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const name = frontmatter.name ?? path.split(/[\\/]/).pop()?.replace(/\.md$/, '') ?? 'skill';
  const description = frontmatter.description ?? frontmatter.summary ?? '';
  const dependencies = frontmatter.depends_on
    ? frontmatter.depends_on.split(',').map((item) => item.trim()).filter(Boolean)
    : [];
  const includes: string[] = [];
  const includeRegex = /^@([\w/-]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = includeRegex.exec(body)) !== null) {
    includes.push(match[1]);
  }

  return {
    name,
    description,
    path,
    origin,
    dependencies,
    includes,
    frontmatter,
  };
}

function scanSkillDirectory(root: string, origin: SkillOrigin): SkillRecord[] {
  if (!existsSync(root)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const records: SkillRecord[] = [];
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    if (entry.endsWith('.md')) {
      const record = readSkillFile(join(root, entry), origin);
      if (record) records.push(record);
      continue;
    }

    const markerPath = join(root, entry, 'SKILL.md');
    const record = readSkillFile(markerPath, origin);
    if (record) records.push(record);
  }

  return records;
}

export function discoverSkills(shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>): SkillRecord[] {
  const cwd = shellPaths.workingDirectory;
  const homeDir = shellPaths.homeDirectory;
  const seen = new Set<string>();
  const records: SkillRecord[] = [];

  for (const { root, origin } of getSkillDirectories(cwd, homeDir)) {
    for (const record of scanSkillDirectory(root, origin)) {
      if (seen.has(record.name.toLowerCase())) continue;
      seen.add(record.name.toLowerCase());
      records.push(record);
    }
  }

  return records.sort((a, b) => {
    const originRank = a.origin === b.origin
      ? 0
      : a.origin === 'project-local'
        ? -1
        : 1;
    return originRank || a.name.localeCompare(b.name);
  });
}

function wordWrap(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [''];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (!line) {
      line = word;
      continue;
    }
    if (line.length + 1 + word.length <= maxWidth) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

function truncatePathDisplay(path: string, width: number): string {
  if (width <= 0) return '';
  if (getDisplayWidth(path) <= width) return path;

  const ellipsis = '…';
  const ellipsisWidth = getDisplayWidth(ellipsis);
  if (ellipsisWidth >= width) return truncateDisplay(path, width);

  const available = width - ellipsisWidth;
  const prefixBudget = Math.max(1, Math.floor(available * 0.35));
  const suffixBudget = Math.max(1, available - prefixBudget);
  const prefix = truncateDisplay(path, prefixBudget, '');

  let suffix = '';
  let suffixWidth = 0;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const char = path[index]!;
    const charWidth = getDisplayWidth(char);
    if (suffixWidth + charWidth > suffixBudget) break;
    suffix = char + suffix;
    suffixWidth += charWidth;
  }

  return `${prefix}${ellipsis}${suffix}`;
}

function originLabel(origin: SkillOrigin): string {
  switch (origin) {
    case 'project-local':
      return 'project';
    case 'global':
      return 'global';
    case 'custom':
      return 'custom';
  }
}

function originColor(origin: SkillOrigin): string {
  switch (origin) {
    case 'project-local':
      return C.project;
    case 'global':
      return C.global;
    case 'custom':
      return C.dim;
  }
}

export class SkillsPanel extends SearchableListPanel<SkillRecord> {
  private readonly shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>;
  /** Whether the filter input row is focused for typing (vs. list navigation). */
  private filterFocused = false;
  private cached: SkillRecord[] | null = null;
  private cacheDirty = true;
  // I1: confirm state for destructive delete
  private confirm: ConfirmState | null = null;

  public constructor(options: SkillsPanelOptions) {
    super('skills', 'Skills', 'K', 'monitoring', options.componentHealthMonitor);
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.shellPaths = options.shellPaths;
  }

  // -------------------------------------------------------------------------
  // SearchableListPanel implementation
  // -------------------------------------------------------------------------

  protected getAllItems(): readonly SkillRecord[] {
    if (this.cached === null || this.cacheDirty) {
      this.cached = discoverSkills(this.shellPaths);
      this.cacheDirty = false;
    }
    return this.cached;
  }

  protected matchesSearch(skill: SkillRecord, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const haystack = [
      skill.name,
      skill.description,
      skill.path,
      skill.origin,
      skill.dependencies.join(' '),
      skill.includes.join(' '),
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  }

  protected renderItem(skill: SkillRecord, index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    const dot = skill.origin === 'project-local' ? '\u25c6' : '\u2022';
    const desc = skill.description || 'No description provided.';
    const descWidth = Math.max(1, width - 4 - skill.name.length - 6);
    const descLines = wordWrap(desc, descWidth);
    return buildPanelLine(width, [
      [selected ? '\u25b8' : ' ', C.selectedFg, bg],
      [' ', C.dim, bg],
      [dot, originColor(skill.origin), bg],
      [' ', C.dim, bg],
      [skill.name, selected ? C.selectedFg : C.value, bg],
      ['  ', C.dim, bg],
      [descLines[0] ?? '', selected ? C.selectedFg : C.dim, bg],
    ]);
  }

  protected override getPalette() { return C; }
  protected override getEmptyStateMessage() { return ' No skills discovered.'; }
  protected override getEmptyStateActions() {
    return [
      { command: '.goodvibes/skills', summary: 'place skill .md files here (project-local) or ~/.goodvibes/skills (global)' },
      { command: '/registry search skills', summary: 'inspect the same skill directories from the shell' },
    ];
  }

  public override onActivate(): void {
    super.onActivate();
    this.searchQuery = '';
    this.invalidateFilter();
    this.filterFocused = false;
    this.cacheDirty = true;
  }

  public override onDestroy(): void {}

  public handleInput(key: string): boolean {
    // I1: y/n confirmation dialog for delete
    const confirmResult = handleConfirmInput(this.confirm, key);
    if (confirmResult === 'confirmed') {
      const toDelete = this.confirm!.subject;
      this.confirm = null;
      // Skills are read from the filesystem — deletion requires a shell command.
      // Surface an error directing the user to remove the file manually.
      this.setError(`Delete via shell: rm "${toDelete}"`);
      this.markDirty();
      return true;
    }
    if (confirmResult === 'cancelled') {
      this.confirm = null;
      this.markDirty();
      return true;
    }
    if (confirmResult === 'absorbed') return true;

    const items = this.getItems();

    // Filter-focus mode: typing goes into the search query
    if (this.filterFocused) {
      const transition = getPanelSearchFocusTransition(key, { selectedIndex: this.selectedIndex, itemCount: items.length });
      if (transition === 'focus-list') {
        this.filterFocused = false;
        this.markDirty();
        return true;
      }
      // Escape: also blur filter focus (clear + return to list navigation)
      if (isPanelSearchCancel(key)) {
        this.filterFocused = false;
        // Delegate to super to clear the query. If the query is empty, super
        // returns false and escape propagates to the panel dismissal handler —
        // this is the intentional double-escape UX (blur filter, then close).
        return super.handleInput(key);
      }
      // Delegate backspace/printable to SearchableListPanel.handleInput
      return super.handleInput(key);
    }

    const transition = getPanelSearchFocusTransition(key, { selectedIndex: this.selectedIndex, itemCount: items.length });
    if (transition === 'focus-search') {
      this.filterFocused = true;
      this.markDirty();
      return true;
    }

    // I1: 'd' prompts delete confirmation
    if (key === 'd') {
      const skill = items[this.selectedIndex];
      if (skill) {
        this.confirm = { subject: skill.path, label: skill.name };
        this.markDirty();
      }
      return true;
    }

    // Navigation + search: delegate to SearchableListPanel (up/down/g/G/page/enter + backspace/escape)
    return super.handleInput(key);
  }

  public render(width: number, height: number): Line[] {
    return this.trackedRender(() => {
    this.needsRender = false;

    // I1: show confirm dialog in place of normal content
    if (this.confirm) {
      const lines = buildPanelWorkspace(width, height, {
        title: 'Skills - confirm action',
        intro: '',
        sections: [{ title: 'Confirmation', lines: renderConfirmLines(width, this.confirm) }],
        palette: C,
      });
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    // Build filter input line (provided by SearchableListPanel base)
    const filterLine = this.buildFilterInputLine(width, 'Filter', this.filterFocused);

    // Build detail footer for the currently selected skill
    const items = this.getItems();
    const selected = items[this.selectedIndex];
    const detailLines: Line[] = [];
    if (selected) {
      detailLines.push(
        buildPanelLine(width, [['  Selected: ', C.label], [selected.name, C.value], ['  [', C.dim], [originLabel(selected.origin), originColor(selected.origin)], [']', C.dim]]),
        buildPanelLine(width, [['  Path: ', C.label], [truncatePathDisplay(selected.path, Math.max(1, width - 8)), C.path]]),
        buildPanelLine(width, [['  Desc: ', C.label], [selected.description || 'No description provided.', C.value]]),
        buildPanelLine(width, [['  Depends: ', C.label], [selected.dependencies.length > 0 ? selected.dependencies.join(', ') : 'none', C.dim]]),
        buildPanelLine(width, [['  Includes: ', C.label], [selected.includes.length > 0 ? selected.includes.join(', ') : 'none', C.dim]]),
      );
    }
    detailLines.push(buildPanelLine(width, [['  Up/Down navigate  / or Up-at-top focus filter  Esc blur  Backspace clear', C.hint]]));

    const lines = this.renderList(width, height, {
      title: 'Skills - discover project-local and global skill packs',
      header: [filterLine],
      footer: detailLines,
    });
    return lines;
    });
  }
}
