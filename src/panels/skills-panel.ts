import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Cell, Line } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { BasePanel } from './base-panel.ts';

const C = {
  headerFg: '#94a3b8',
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

function buildLine(width: number, segments: Array<[string, string, string?]>): Line {
  const cells: Cell[] = [];
  for (const [text, fg, bg] of segments) {
    const style = { fg, bg: bg ?? '' };
    for (const ch of text) {
      if (cells.length >= width) break;
      const cw = getDisplayWidth(ch);
      cells.push(createStyledCell(ch, style));
      if (cw === 2 && cells.length < width) {
        cells.push(createStyledCell('', style));
      }
    }
  }
  while (cells.length < width) {
    cells.push(createStyledCell(' ', { fg: '' }));
  }
  return cells.slice(0, width);
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
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.cacheDirty = true;
  }

  public override onDestroy(): void {}

  public handleInput(key: string): boolean {
    const records = this._filteredSkills();

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
    if (key === 'backspace' || key === 'delete') {
      if (this.query.length === 0) return false;
      this.query = this.query.slice(0, -1);
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.markDirty();
      return true;
    }
    if (key === 'escape') {
      if (this.query.length === 0) return false;
      this.query = '';
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.markDirty();
      return true;
    }
    if (key.length === 1 && key >= ' ') {
      this.query += key;
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
    const lines: Line[] = [];
    const skills = this._filteredSkills();
    const detailHeight = skills.length > 0 ? (height > 8 ? 4 : 2) : 4;
    const listHeight = Math.max(1, height - 2 - 1 - detailHeight);

    lines.push(buildLine(width, [[' Skills — discover project-local and global skill packs', C.headerFg, C.headerBg]]));
    lines.push(buildLine(width, [
      [' Filter: ', C.label, C.searchBg],
      [this.query || ' ', C.searchFg, C.searchBg],
      [' '.repeat(Math.max(0, width - 9 - Math.max(1, this.query.length))), C.dim, C.searchBg],
    ]));

    if (skills.length === 0) {
      lines.push(buildLine(width, [[' No skills discovered.', C.empty]]));
      lines.push(buildLine(width, [[' Create .goodvibes/skills or .goodvibes/tui/skills in this repo,', C.dim]]));
      lines.push(buildLine(width, [[' or ~/.goodvibes/skills / ~/.goodvibes/tui/skills for global packs.', C.dim]]));
      lines.push(buildLine(width, [[' Use /registry search skills to inspect the same directories.', C.dim]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      this.reportRenderDuration(Date.now() - start);
      return lines.slice(0, height);
    }

    this._clampSelection(skills);
    const selected = skills[this.selectedIndex];
    this._clampScroll(skills, listHeight);

    const visible = skills.slice(this.scrollOffset, this.scrollOffset + listHeight);
    for (const skill of visible) {
      const isSelected = skills[this.selectedIndex]?.name === skill.name;
      const bg = isSelected ? C.selectedBg : '';
      const arrow = isSelected ? '▶' : ' ';
      const dot = skill.origin === 'project-local' ? '●' : '○';
      const desc = skill.description || 'No description provided.';
      const descWidth = Math.max(1, width - 4 - skill.name.length - 6);
      const descLines = wordWrap(desc, descWidth);
      lines.push(buildLine(width, [
        [arrow, C.selectedFg, bg],
        [' ', C.dim, bg],
        [dot, originColor(skill.origin), bg],
        [' ', C.dim, bg],
        [skill.name, isSelected ? C.selectedFg : C.value, bg],
        ['  ', C.dim, bg],
        [descLines[0] ?? '', isSelected ? C.selectedFg : C.dim, bg],
      ]));
    }

    const detailsHeader = selected
      ? ` Selected: ${selected.name}  [${originLabel(selected.origin)}]`
      : ' Selected: none';
    lines.push(buildLine(width, [[detailsHeader.slice(0, width), C.label]]));

    if (selected) {
      const selectedPath = ` Path: ${selected.path}`;
      const selectedDesc = ` Desc: ${selected.description || 'No description provided.'}`;
      const selectedDeps = ` Depends: ${selected.dependencies.length > 0 ? selected.dependencies.join(', ') : 'none'}`;
      const selectedIncludes = ` Includes: ${selected.includes.length > 0 ? selected.includes.join(', ') : 'none'}`;
      lines.push(buildLine(width, [[selectedPath.slice(0, width), C.path]]));
      if (detailHeight > 2) {
        lines.push(buildLine(width, [[selectedDesc.slice(0, width), C.value]]));
        lines.push(buildLine(width, [[`${selectedDeps}  ${selectedIncludes}`.slice(0, width), C.dim]]));
      }
    } else {
      lines.push(buildLine(width, [[' No selection.', C.dim]]));
      if (detailHeight > 2) {
        lines.push(buildLine(width, [[' ', C.dim]]));
        lines.push(buildLine(width, [[' ', C.dim]]));
      }
    }

    lines.push(buildLine(width, [[' ↑/↓ navigate  type to filter  Backspace clear  Esc reset', C.hint]]));

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
