import { promises as fsPromises } from 'node:fs';
import { join, sep } from 'node:path';
import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';
import { getDisplayWidth, truncateDisplay } from '../utils/terminal-width.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import { FilePreviewPanel } from './file-preview-panel.ts';
import type { PanelIntegrationContext } from './types.ts';
import type { ComponentHealthMonitor } from '../runtime/perf/panel-health-monitor.ts';
import { listInstalledEcosystemEntries, type EcosystemCatalogPathOptions, type ShellPathService } from '@/runtime/index.ts';
import {
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
} from './polish.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

// Domain accents only; base chrome (header/headerBg/label/value/dim/empty/
// selectBg) comes from DEFAULT_PANEL_PALETTE.
const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  project: '#38bdf8',   // project-local skill origin
  global:  '#a78bfa',   // global skill origin
} as const);

export type SkillOrigin = 'project-local' | 'global' | 'custom';

export interface SkillRecord {
  name: string;
  description: string;
  path: string;
  origin: SkillOrigin;
  dependencies: string[];
  includes: string[];
  frontmatter: Record<string, string>;
  /**
   * Set when this skill's file lives under an installed ecosystem-marketplace
   * receipt's targetPath — the receipt's provenance summary (e.g. curated
   * source / signature info), so marketplace-installed skills read as such
   * instead of looking identical to hand-authored ones.
   */
  marketplaceProvenance?: string;
}

export interface SkillsPanelOptions {
  shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>;
  componentHealthMonitor?: ComponentHealthMonitor;
  /** When provided, installed skill entries are tagged with marketplace provenance. */
  ecosystemPaths?: EcosystemCatalogPathOptions;
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

async function readSkillFile(path: string, origin: SkillOrigin): Promise<SkillRecord | null> {
  let content = '';
  try {
    content = await fsPromises.readFile(path, 'utf-8');
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

async function scanSkillDirectory(root: string, origin: SkillOrigin): Promise<SkillRecord[]> {
  let entries: string[] = [];
  try {
    entries = await fsPromises.readdir(root);
  } catch {
    return [];
  }

  const records: SkillRecord[] = [];
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    if (entry.endsWith('.md')) {
      const record = await readSkillFile(join(root, entry), origin);
      if (record) records.push(record);
      continue;
    }

    const markerPath = join(root, entry, 'SKILL.md');
    const record = await readSkillFile(markerPath, origin);
    if (record) records.push(record);
  }

  return records;
}

/**
 * Tags records whose file lives under an installed ecosystem-marketplace
 * receipt's targetPath with that receipt's provenance summary. Best-effort:
 * a lookup failure (e.g. no ecosystem catalogs configured) leaves records
 * untagged rather than failing skill discovery.
 */
function applyMarketplaceProvenance(records: SkillRecord[], ecosystemPaths: EcosystemCatalogPathOptions): SkillRecord[] {
  let receipts: ReturnType<typeof listInstalledEcosystemEntries>;
  try {
    receipts = listInstalledEcosystemEntries('skill', ecosystemPaths);
  } catch {
    return records;
  }
  if (receipts.length === 0) return records;
  return records.map((record) => {
    const receipt = receipts.find((candidate) => record.path === candidate.targetPath || record.path.startsWith(`${candidate.targetPath}${sep}`));
    if (!receipt) return record;
    return { ...record, marketplaceProvenance: receipt.provenanceSummary };
  });
}

export async function discoverSkills(
  shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>,
  ecosystemPaths?: EcosystemCatalogPathOptions,
): Promise<SkillRecord[]> {
  const cwd = shellPaths.workingDirectory;
  const homeDir = shellPaths.homeDirectory;
  const seen = new Set<string>();
  const records: SkillRecord[] = [];

  for (const { root, origin } of getSkillDirectories(cwd, homeDir)) {
    for (const record of await scanSkillDirectory(root, origin)) {
      if (seen.has(record.name.toLowerCase())) continue;
      seen.add(record.name.toLowerCase());
      records.push(record);
    }
  }

  const tagged = ecosystemPaths ? applyMarketplaceProvenance(records, ecosystemPaths) : records;

  return tagged.sort((a, b) => {
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

export class SkillsPanel extends ScrollableListPanel<SkillRecord> {
  private readonly shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>;
  private readonly ecosystemPaths: EcosystemCatalogPathOptions | undefined;
  private cached: SkillRecord[] | null = null;
  private cacheDirty = true;
  // I1: confirm state for destructive delete
  private confirm: ConfirmState | null = null;
  private readyPromise: Promise<void> | null = null;
  // Staged pending action consumed by handlePanelIntegrationAction (same
  // pattern as diff-panel.ts's pendingOpenPreview): Enter marks the intent
  // here, the actual PanelManager/preview wiring happens once the
  // integration context is available.
  private pendingOpenPreview = false;

  public constructor(options: SkillsPanelOptions) {
    super('skills', 'Skills', '▩', 'automation-control', options.componentHealthMonitor);
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.filterEnabled = true; // WO-153: converged modal '/' filter
    this.filterLabel = 'Filter';
    this.shellPaths = options.shellPaths;
    this.ecosystemPaths = options.ecosystemPaths;
  }

  // -------------------------------------------------------------------------
  // ScrollableListPanel implementation
  // -------------------------------------------------------------------------

  protected getItems(): readonly SkillRecord[] {
    return this.cached ?? [];
  }

  private _loadSkillsAsync(): Promise<void> {
    const p = (async () => {
      try {
        await this.withLoading('Scanning skills\u2026', async () => {
          this.cached = await discoverSkills(this.shellPaths, this.ecosystemPaths);
          this.cacheDirty = false;
          this.markDirty();
        });
      } catch (err) {
        this.setError(summarizeError(err));
      }
      this.markDirty();
    })();
    this.readyPromise = p;
    return p;
  }

  /** Resolves when the current load cycle has settled. */
  public awaitReady(): Promise<void> {
    return this.readyPromise ?? Promise.resolve();
  }

  /**
   * REAL delete: removes the confirmed skill's markdown file from disk, then
   * rescans so the list reflects the change immediately. Replaces the old
   * setError('Delete via shell: rm …') signpost, which never actually
   * deleted anything.
   */
  private async _deleteSkill(path: string): Promise<void> {
    try {
      await fsPromises.rm(path);
      this.cacheDirty = true;
      await this._loadSkillsAsync();
    } catch (err) {
      this.setError(summarizeError(err));
      this.markDirty();
    }
  }

  /** `q` arrives already trimmed + lower-cased from ScrollableListPanel.getVisibleItems(). */
  protected override filterMatches(skill: SkillRecord, q: string): boolean {
    const haystack = [
      skill.name,
      skill.description,
      skill.path,
      skill.origin,
      skill.marketplaceProvenance ?? '',
      skill.dependencies.join(' '),
      skill.includes.join(' '),
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  }

  protected renderItem(skill: SkillRecord, index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    const dot = skill.origin === 'project-local' ? '\u25c6' : '\u2022';
    // Marketplace-installed skills get a badge glyph; unbadged column stays a
    // single blank cell so rows stay aligned either way.
    const marketplaceBadge = skill.marketplaceProvenance ? '\u2605' : ' ';
    const desc = skill.description || 'No description provided.';
    const descWidth = Math.max(1, width - 6 - skill.name.length - 6);
    const descLines = wordWrap(desc, descWidth);
    return buildPanelLine(width, [
      [selected ? '\u25b8' : ' ', C.value, bg],
      [' ', C.dim, bg],
      [dot, originColor(skill.origin), bg],
      [' ', C.dim, bg],
      [marketplaceBadge, C.info, bg],
      [' ', C.dim, bg],
      [skill.name, selected ? C.value : C.value, bg],
      ['  ', C.dim, bg],
      [descLines[0] ?? '', selected ? C.value : C.dim, bg],
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
    this.filterQuery = '';
    this.filterActive = false;
    this.cacheDirty = true;
    void this._loadSkillsAsync();
  }

  public override onDestroy(): void {}

  protected override onSelect(_skill: SkillRecord): void {
    // Enter opens the skill's markdown source in the preview panel — see
    // handlePanelIntegrationAction for the actual PanelManager wiring
    // (needs the integration context, not available here). Selection itself
    // is read back from getVisibleItems() in that hook. onSelect is only
    // invoked by ScrollableListPanel's navigation handler when the filter is
    // not active, so no manual guard is needed here.
    this.pendingOpenPreview = true;
  }

  /**
   * Cross-panel integration hook — Enter opens the selected skill's markdown
   * source in the preview panel via the same open/focus bridge DiffPanel
   * uses (src/input/panel-integration-actions.ts), without this panel
   * needing to know about PanelManager pane/focus mechanics beyond what ctx
   * exposes.
   */
  public handlePanelIntegrationAction(_key: string, ctx: PanelIntegrationContext): boolean {
    if (!this.pendingOpenPreview) return false;
    this.pendingOpenPreview = false;
    const skill = this.getVisibleItems()[this.selectedIndex];
    if (!skill) return false;

    const pm = ctx.panelManager;
    let previewPanel = pm.getPanel('preview');
    if (previewPanel instanceof FilePreviewPanel) {
      const pane = pm.getPaneOf('preview');
      pm.activateById('preview');
      if (pane) pm.focusPane(pane);
    } else {
      const targetPane: 'top' | 'bottom' = pm.isBottomPaneVisible()
        ? (pm.getFocusedPane() === 'top' ? 'bottom' : 'top')
        : 'bottom';
      const opened = pm.open('preview', targetPane);
      pm.show();
      pm.focusPane(targetPane);
      previewPanel = opened instanceof FilePreviewPanel ? opened : null;
    }
    if (previewPanel instanceof FilePreviewPanel) {
      previewPanel.openFile(skill.path);
      return true;
    }
    return false;
  }

  public handleInput(key: string): boolean {
    // I1: y/n confirmation dialog for delete
    const confirmResult = handleConfirmInput(this.confirm, key);
    if (confirmResult === 'confirmed') {
      const toDelete = this.confirm!.subject;
      this.confirm = null;
      void this._deleteSkill(toDelete);
      this.markDirty();
      return true;
    }
    if (confirmResult === 'cancelled') {
      this.confirm = null;
      this.markDirty();
      return true;
    }
    if (confirmResult === 'absorbed') return true;

    // I1: 'd' prompts delete confirmation — only outside filter mode, so 'd'
    // remains typeable into the filter query while it is active (WO-153:
    // converged modal '/' filter coexists with single-letter action keys).
    if (!this.filterActive && key === 'd') {
      const skill = this.getVisibleItems()[this.selectedIndex];
      if (skill) {
        this.confirm = { subject: skill.path, label: skill.name };
        this.markDirty();
      }
      return true;
    }

    // Navigation + filter: delegate to ScrollableListPanel ('/' enters
    // filter, typing narrows, Esc clears, up/down/g/G/page/enter navigate).
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

    // Build detail footer for the currently selected skill
    const items = this.getVisibleItems();
    const selected = items[this.selectedIndex];
    const detailLines: Line[] = [];
    if (selected) {
      detailLines.push(
        buildPanelLine(width, [['  Selected: ', C.label], [selected.name, C.value], ['  [', C.dim], [originLabel(selected.origin), originColor(selected.origin)], [']', C.dim]]),
        buildPanelLine(width, [['  Path: ', C.label], [truncatePathDisplay(selected.path, Math.max(1, width - 8)), C.label]]),
        buildPanelLine(width, [['  Desc: ', C.label], [selected.description || 'No description provided.', C.value]]),
        buildPanelLine(width, [['  Depends: ', C.label], [selected.dependencies.length > 0 ? selected.dependencies.join(', ') : 'none', C.dim]]),
        buildPanelLine(width, [['  Includes: ', C.label], [selected.includes.length > 0 ? selected.includes.join(', ') : 'none', C.dim]]),
        buildPanelLine(width, [
          ['  Provenance: ', C.label],
          [selected.marketplaceProvenance ?? 'not installed via marketplace', selected.marketplaceProvenance ? C.info : C.dim],
        ]),
      );
    }
    detailLines.push(buildPanelLine(width, [['  Up/Down navigate  / filter  Esc clear  Backspace edit', C.dim]]));
    detailLines.push(buildPanelLine(width, [['  Enter open in preview  d delete (confirm)', C.dim]]));

    // Filter input line is auto-injected by renderList() (filterEnabled=true).
    const lines = this.renderList(width, height, {
      title: 'Skills - discover project-local and global skill packs',
      footer: detailLines,
    });
    return lines;
    });
  }
}
