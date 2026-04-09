import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import {
  buildEmptyState,
  buildPanelLine,
  buildSearchInputLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  resolvePrimaryScrollableSection,
  type PanelWorkspaceSection,
} from './polish.ts';
import {
  getPanelSearchFocusTransition,
  isPanelSearchBackspace,
  isPanelSearchCancel,
  isPanelSearchPrintable,
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
  cwd?: string;
  homeDir?: string;
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

export function discoverSkills(opts: SkillsPanelOptions = {}): SkillRecord[] {
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir ?? homedir();
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

export class SkillsPanel extends BasePanel {
  private readonly cwd: string;
  private readonly homeDir: string;
  private query = '';
  private filterFocused = false;
  private selectedIndex = 0;
  private scrollOffset = 0;
  private cached: SkillRecord[] | null = null;
  private cacheDirty = true;

  public constructor(options: SkillsPanelOptions = {}) {
    super('skills', 'Skills', 'K', 'monitoring');
    this.cwd = options.cwd ?? process.cwd();
    this.homeDir = options.homeDir ?? homedir();
  }

  public override onActivate(): void {
    super.onActivate();
    this.query = '';
    this.filterFocused = false;
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.cacheDirty = true;
  }

  public override onDestroy(): void {}

  public handleInput(key: string): boolean {
    const records = this._filteredSkills();
    if (this.filterFocused) {
      const transition = getPanelSearchFocusTransition(key, { selectedIndex: this.selectedIndex, itemCount: records.length });
      if (transition === 'focus-list') {
        this.filterFocused = false;
        this.selectedIndex = 0;
        this.scrollOffset = 0;
        this.markDirty();
        return true;
      }
      if (isPanelSearchBackspace(key)) {
        if (this.query.length === 0) return true;
        this.query = this.query.slice(0, -1);
        this.selectedIndex = 0;
        this.scrollOffset = 0;
        this.markDirty();
        return true;
      }
      if (isPanelSearchCancel(key)) {
        this.filterFocused = false;
        this.markDirty();
        return true;
      }
      if (isPanelSearchPrintable(key)) {
        this.query += key;
        this.selectedIndex = 0;
        this.scrollOffset = 0;
        this.markDirty();
        return true;
      }
      return false;
    }

    const transition = getPanelSearchFocusTransition(key, { selectedIndex: this.selectedIndex, itemCount: records.length });
    if (transition === 'focus-search') {
      this.filterFocused = true;
      this.markDirty();
      return true;
    }

    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(Math.max(0, records.length - 1), this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    if (key === 'home') {
      this.selectedIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'end') {
      this.selectedIndex = Math.max(0, records.length - 1);
      this.markDirty();
      return true;
    }
    if (key === 'pageup') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 5);
      this.markDirty();
      return true;
    }
    if (key === 'pagedown') {
      this.selectedIndex = Math.min(Math.max(0, records.length - 1), this.selectedIndex + 5);
      this.markDirty();
      return true;
    }
    if (isPanelSearchBackspace(key)) {
      if (this.query.length === 0) return false;
      this.query = this.query.slice(0, -1);
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.markDirty();
      return true;
    }
    if (isPanelSearchCancel(key)) {
      if (this.query.length === 0) return false;
      this.query = '';
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.markDirty();
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    if (!this.canRenderNow()) {
      return Array.from({ length: height }, () => createEmptyLine(width));
    }

    const start = Date.now();
    this.needsRender = false;
    const intro = 'Discover project-local and global skill packs, filter by name or description, and inspect path, dependencies, and includes.';
    const skills = this._filteredSkills();

    if (skills.length === 0) {
      const lines = buildPanelWorkspace(width, height, {
        title: 'Skills - discover project-local and global skill packs',
        intro,
        sections: [{
          title: 'Filter',
          lines: [buildSearchInputLine(width, ' query: ', `${this.query}${this.filterFocused ? '_' : ''}`, C, {
            active: this.filterFocused,
            emptyLabel: this.filterFocused ? '(type to filter)' : '(/ or up at top)',
            valueColor: this.query ? C.searchFg : undefined,
          })],
        }, {
          lines: buildEmptyState(
            width,
            ' No skills discovered.',
            'Create .goodvibes/skills or .goodvibes/tui/skills in this repo, or ~/.goodvibes/skills and ~/.goodvibes/tui/skills for global packs.',
            [{ command: '/registry search skills', summary: 'inspect the same skill directories from the shell' }],
            C,
          ),
        }],
        palette: C,
      });
      while (lines.length < height) lines.push(createEmptyLine(width));
      this.reportRenderDuration(Date.now() - start);
      return lines.slice(0, height);
    }

    this._clampSelection(skills);
    const selected = skills[this.selectedIndex];
    const fixedDiscoveryLines: Line[] = [
      buildSearchInputLine(width, ' query: ', `${this.query}${this.filterFocused ? '_' : ''}`, C, {
        active: this.filterFocused,
        emptyLabel: this.filterFocused ? '(type to filter)' : '(/ or up at top)',
        valueColor: this.query ? C.searchFg : undefined,
      }),
    ];

    const detailLines: Line[] = [];
    if (selected) {
      detailLines.push(
        buildPanelLine(width, [['  Selected: ', C.label], [selected.name, C.value], ['  [', C.dim], [originLabel(selected.origin), originColor(selected.origin)], [']', C.dim]]),
        buildPanelLine(width, [['  Path: ', C.label], [selected.path, C.path]]),
        buildPanelLine(width, [['  Desc: ', C.label], [selected.description || 'No description provided.', C.value]]),
        buildPanelLine(width, [['  Depends: ', C.label], [selected.dependencies.length > 0 ? selected.dependencies.join(', ') : 'none', C.dim]]),
        buildPanelLine(width, [['  Includes: ', C.label], [selected.includes.length > 0 ? selected.includes.join(', ') : 'none', C.dim]]),
      );
    } else {
      detailLines.push(buildPanelLine(width, [[' No selection.', C.dim]]));
    }
    const detailSection: PanelWorkspaceSection = { title: 'Selected Skill', lines: detailLines };
    const resolvedDiscoverySection = resolvePrimaryScrollableSection(width, height, {
      intro,
      footerLines: [buildPanelLine(width, [['  Up/Down navigate  / or Up-at-top focus filter  Esc blur  Backspace clear', C.hint]])],
      palette: C,
      section: {
        title: 'Discovery',
        fixedLines: fixedDiscoveryLines,
        scrollableLines: skills.map((skill, absolute) => {
          const isSelected = absolute === this.selectedIndex;
          const bg = isSelected ? C.selectBg : undefined;
          const dot = skill.origin === 'project-local' ? '◆' : '•';
          const desc = skill.description || 'No description provided.';
          const descWidth = Math.max(1, width - 4 - skill.name.length - 6);
          const descLines = wordWrap(desc, descWidth);
          return buildPanelLine(width, [
            [isSelected ? '▸' : ' ', C.selectedFg, bg],
            [' ', C.dim, bg],
            [dot, originColor(skill.origin), bg],
            [' ', C.dim, bg],
            [skill.name, isSelected ? C.selectedFg : C.value, bg],
            ['  ', C.dim, bg],
            [descLines[0] ?? '', isSelected ? C.selectedFg : C.dim, bg],
          ]);
        }),
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        guardRows: 1,
        minRows: 4,
        appendWindowSummary: {
          dimColor: C.dim,
          formatter: (window) => buildPanelLine(width, [[`  showing ${window.start + 1}-${window.end} of ${window.total}`, C.dim]]),
        },
      },
      afterSections: [detailSection],
    });
    this.scrollOffset = resolvedDiscoverySection.scrollOffset;
    this._clampScroll(skills, resolvedDiscoverySection.window.count);

    const sections: PanelWorkspaceSection[] = [
      resolvedDiscoverySection.section,
      detailSection,
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Skills - discover project-local and global skill packs',
      intro,
      sections,
      footerLines: [buildPanelLine(width, [['  Up/Down navigate  / or Up-at-top focus filter  Esc blur  Backspace clear', C.hint]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    this.reportRenderDuration(Date.now() - start);
    return lines.slice(0, height);
  }

  private _filteredSkills(): SkillRecord[] {
    if (this.cached === null || this.cacheDirty) {
      this.cached = discoverSkills({ cwd: this.cwd, homeDir: this.homeDir });
      this.cacheDirty = false;
    }
    const q = this.query.trim().toLowerCase();
    if (!q) return this.cached;
    return this.cached.filter((skill) => {
      const haystack = [
        skill.name,
        skill.description,
        skill.path,
        skill.origin,
        skill.dependencies.join(' '),
        skill.includes.join(' '),
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }

  private _clampSelection(records: SkillRecord[]): void {
    if (records.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, records.length - 1));
  }

  private _clampScroll(records: SkillRecord[], listHeight: number): void {
    const maxScroll = Math.max(0, records.length - listHeight);
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + listHeight) {
      this.scrollOffset = this.selectedIndex - listHeight + 1;
    }
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
  }
}
