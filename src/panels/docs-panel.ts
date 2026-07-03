// ---------------------------------------------------------------------------
// DocsPanel — tool list, model capabilities, and keyboard shortcut reference.
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import { buildKeyboardHints, buildPanelLine, buildPanelWorkspace, buildSearchInputLine, resolveScrollablePanelSection, extendPalette, DEFAULT_PANEL_PALETTE } from './polish.ts';
import type { ToolCatalogQuery } from '../runtime/ui-service-queries.ts';
import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers';
import type { KeybindingsManager } from '../input/keybindings.ts';
import type { PanelIntegrationContext } from './types.ts';
import { ToolInspectorPanel } from './tool-inspector-panel.ts';
import { isPanelSearchBackspace, isPanelSearchPrintable } from './search-focus.ts';

const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  // Panel-specific domain colors with no clean shared equivalent.
  sectionFg: '#00ffff',
  toolFg:    '#88ccff',
  selected:  '#00ffff',
});

/**
 * Minimal provider-registry surface DocsPanel needs: list models, read the
 * live active model (to mark it in the list), and switch models (Enter on a
 * model row is a real in-panel action, not a printed signpost). Structurally
 * satisfied by the full ProviderRegistry passed in from bootstrap.
 */
interface DocsProviderRegistry {
  listModels(): ModelDefinition[];
  getCurrentModel?(): ModelDefinition | undefined;
  setCurrentModel?(registryKey: string): void;
}

type DocSection = 'tools' | 'models' | 'shortcuts';

interface FlatRow {
  kind: 'header' | 'item' | 'detail' | 'empty';
  text: string;
  fg: string;
  bg: string;
  bold?: boolean;
  /** Present on tool 'item' rows — the tool name Enter should filter the inspector to. */
  toolName?: string;
  /** Present on model 'item' rows — the model's registryKey (provider:id) for setCurrentModel. */
  modelKey?: string;
  /** Present on model 'item' rows — whether Enter is allowed to switch to this model. */
  modelSelectable?: boolean;
}

function renderRow(width: number, row: FlatRow, isCursor: boolean): Line {
  const bg = isCursor ? C.selectBg : row.bg;
  return buildPanelLine(width, [
    [isCursor ? '▸' : ' ', C.selected, bg],
    [row.text, isCursor ? C.selected : row.fg, bg],
  ]);
}

export class DocsPanel extends BasePanel {
  private toolRegistry: ToolCatalogQuery | null = null;
  private providerRegistry: DocsProviderRegistry | null = null;
  private keybindingsManager: KeybindingsManager | null = null;
  private section: DocSection = 'tools';
  private searchQuery = '';
  private searching = false;
  private rows: FlatRow[] = [];
  private cursorIndex = 0;
  private scrollOffset = 0;
  /** Set by handleInput('enter') on a tool row; consumed by handlePanelIntegrationAction, which has the PanelManager reference needed to open the sibling inspector. */
  private _pendingToolJump: string | null = null;

  constructor(toolRegistry?: ToolCatalogQuery, providerRegistry?: DocsProviderRegistry, keybindingsManager?: KeybindingsManager) {
    super('docs', 'Docs', '?', 'session');
    this.toolRegistry = toolRegistry ?? null;
    this.providerRegistry = providerRegistry ?? null;
    this.keybindingsManager = keybindingsManager ?? null;
  }

  override onActivate(): void {
    this.needsRender = true;
    this._buildRows();
  }

  /**
   * WO-153: converged modal '/' filter (mirrors ScrollableListPanel's
   * _handleFilterKey). Returns `true`/`false` when consumed/ignored in
   * filter context, or `null` to fall through to section hotkeys/navigation.
   */
  private _handleSearchKey(key: string): boolean | null {
    if (this.searching) {
      if (key === 'escape') {
        this.searching = false;
        this.searchQuery = '';
        this._buildRows();
        return true;
      }
      if (key === 'return' || key === 'enter') {
        this.searching = false; // commit; keep the query applied
        this._buildRows();
        return true;
      }
      if (isPanelSearchBackspace(key)) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this._buildRows();
        return true;
      }
      // Arrow/paging keys navigate the filtered rows — fall through.
      if (key === 'up' || key === 'down' || key === 'pageup' || key === 'pagedown') {
        return null;
      }
      // Any printable character (including section hotkeys like t/m/k) extends the query.
      if (isPanelSearchPrintable(key)) {
        this.searchQuery += key;
        this._buildRows();
        return true;
      }
      return false;
    }
    if (key === '/') {
      this._startSearch();
      return true;
    }
    return null;
  }

  /**
   * The `/`-to-search buffer wants every character of a burst (paste, or a
   * fast-typed query landing in one input.feed() call), same as it always
   * has — see the interface doc on `Panel.isCapturingTextBurst`.
   */
  isCapturingTextBurst(): boolean {
    return this.searching;
  }

  handleInput(key: string): boolean {
    const searchResult = this._handleSearchKey(key);
    if (searchResult !== null) return searchResult;

    switch (key) {
      case 'up':       this._move(-1);         return true;
      case 'down':     this._move(1);          return true;
      case 'pageup':   this._move(-10);        return true;
      case 'pagedown': this._move(10);         return true;
      case 't':        this._setSection('tools');     return true;
      case 'm':        this._setSection('models');    return true;
      case 'k':        this._setSection('shortcuts'); return true;
      case 'enter':
      case 'return':   return this._activateSelected();
      default:         return false;
    }
  }

  /**
   * Enter on the cursor row. Tool rows can't act directly — opening the tool
   * inspector needs the PanelManager, which only handlePanelIntegrationAction
   * has — so this just records intent and lets that hook finish the jump.
   * Model rows need no cross-panel access: switching the active model is a
   * direct providerRegistry call, so it happens right here.
   */
  private _activateSelected(): boolean {
    const row = this.rows[this.cursorIndex];
    if (!row || row.kind !== 'item') return false;
    if (this.section === 'tools' && row.toolName) {
      this._pendingToolJump = row.toolName;
      return true;
    }
    if (this.section === 'models' && row.modelKey) {
      if (row.modelSelectable && this.providerRegistry?.setCurrentModel) {
        this.providerRegistry.setCurrentModel(row.modelKey);
        this._buildRows();
      }
      return true;
    }
    return false;
  }

  /**
   * Cross-panel integration hook — opens ToolInspectorPanel filtered to the
   * tool selected on Enter (session.ts:102 sibling-open pattern), consuming
   * the intent recorded by _activateSelected.
   */
  handlePanelIntegrationAction(_key: string, ctx: PanelIntegrationContext): boolean {
    if (!this._pendingToolJump) return false;
    const tool = this._pendingToolJump;
    this._pendingToolJump = null;
    const inspector = ctx.panelManager.open('tools');
    if (!(inspector instanceof ToolInspectorPanel)) return false;
    inspector.filterByTool(tool);
    return true;
  }

  render(width: number, height: number): Line[] {
    if (height <= 0 || width <= 0) return [];
    const sectionLabel = this.section === 'tools' ? 'Tools' : this.section === 'models' ? 'Models' : 'Shortcuts';
    this.cursorIndex = Math.max(0, Math.min(this.cursorIndex, Math.max(0, this.rows.length - 1)));
    const controlsSection = {
      title: 'Controls',
      lines: [
        buildPanelLine(width, [
          [' t', DEFAULT_PANEL_PALETTE.info], [' tools', DEFAULT_PANEL_PALETTE.dim],
          ['   m', DEFAULT_PANEL_PALETTE.info], [' models', DEFAULT_PANEL_PALETTE.dim],
          ['   k', DEFAULT_PANEL_PALETTE.info], [' shortcuts', DEFAULT_PANEL_PALETTE.dim],
          ['   /', DEFAULT_PANEL_PALETTE.info], [' filter', DEFAULT_PANEL_PALETTE.dim],
        ]),
        this._buildFilterLine(width),
      ],
    } as const;
    // Context-aware footer: while filtering, surface only the keys that work in
    // the filter field; otherwise surface section + navigation keys.
    const footerLines = [this.searching
      ? buildKeyboardHints(width, [
          { keys: 'type', label: 'filter' },
          { keys: 'Enter', label: 'apply' },
          { keys: 'Esc', label: 'clear' },
        ], DEFAULT_PANEL_PALETTE)
      : buildKeyboardHints(width, [
          { keys: 't/m/k', label: 'tools / models / shortcuts' },
          { keys: '↑/↓', label: 'navigate' },
          ...(this.section === 'tools' ? [{ keys: 'Enter', label: 'open in tool inspector' }] : []),
          ...(this.section === 'models' ? [{ keys: 'Enter', label: 'set active model' }] : []),
          { keys: '/', label: 'filter' },
        ], DEFAULT_PANEL_PALETTE)];

    const sectionWindow = resolveScrollablePanelSection(width, height, {
      intro: 'Browse built-in tool docs, available models, and keyboard shortcuts from one shared reference surface.',
      palette: DEFAULT_PANEL_PALETTE,
      footerLines,
      beforeSections: [controlsSection],
      section: {
        title: sectionLabel,
        scrollableLines: this.rows.map((row, absIdx) => {
          const isCursor = absIdx === this.cursorIndex && row.kind !== 'header' && row.kind !== 'empty';
          return renderRow(width, row, isCursor);
        }),
        selectedIndex: this.cursorIndex,
        scrollOffset: this.scrollOffset,
        minRows: 8,
      },
    });
    this.scrollOffset = sectionWindow.scrollOffset;

    return buildPanelWorkspace(width, height, {
      title: ` Docs / ${sectionLabel}`,
      intro: 'Browse built-in tool docs, available models, and keyboard shortcuts from one shared reference surface.',
      sections: [
        controlsSection,
        sectionWindow.section.lines.length > 0 ? sectionWindow.section : { title: sectionLabel, lines: [buildPanelLine(width, [[' No matching docs', DEFAULT_PANEL_PALETTE.dim]])] },
      ],
      footerLines,
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  private _setSection(section: DocSection): void {
    this.section = section;
    this.searchQuery = '';
    this.cursorIndex = 0;
    this.scrollOffset = 0;
    this._buildRows();
  }

  private _startSearch(): void {
    this.searching = true;
    this.markDirty();
  }

  /**
   * The filter input line — pinned rendering contract shared with
   * ScrollableListPanel.buildFilterLine: 'Filter: ' unfocused / '[Filter] '
   * focused, literal trailing '_' cursor while active (active:false is
   * passed to buildSearchInputLine to suppress its block-glyph cursor
   * substitution).
   */
  private _buildFilterLine(width: number): Line {
    const label = this.searching ? '[Filter] ' : 'Filter: ';
    const value = this.searching ? `${this.searchQuery}_` : this.searchQuery;
    return buildSearchInputLine(width, label, value, DEFAULT_PANEL_PALETTE, {
      active: false,
      bg: this.searching ? DEFAULT_PANEL_PALETTE.inputBg : DEFAULT_PANEL_PALETTE.sectionBg,
      emptyLabel: '(/ to filter)',
      valueColor: this.searching ? DEFAULT_PANEL_PALETTE.info : (this.searchQuery ? DEFAULT_PANEL_PALETTE.value : DEFAULT_PANEL_PALETTE.dim),
    });
  }

  private _move(delta: number): void {
    if (this.rows.length === 0) return;
    this.cursorIndex = Math.max(0, Math.min(this.rows.length - 1, this.cursorIndex + delta));
    this.markDirty();
  }

  private _buildRows(): void {
    const q = this.searchQuery.trim().toLowerCase();
    const rows: FlatRow[] = [];

    if (this.section === 'tools') {
      const tools = this.toolRegistry?.list() ?? [];
      const filtered = q ? tools.filter(t => t.definition.name.toLowerCase().includes(q) || (t.definition.description ?? '').toLowerCase().includes(q)) : tools;
      if (filtered.length === 0) {
        rows.push({ kind: 'empty', text: q ? ` No tools match "${this.searchQuery}". Press Esc to clear the filter.` : ' Tool registry not wired into this session.', fg: C.dim, bg: '' });
      } else {
        rows.push({ kind: 'header', text: ` Tools (${filtered.length})`, fg: C.sectionFg, bg: C.sectionBg, bold: true });
        for (const tool of filtered) {
          rows.push({ kind: 'item', text: `  ${tool.definition.name}`, fg: C.toolFg, bg: '', bold: true, toolName: tool.definition.name });
          if (tool.definition.description) {
            rows.push({ kind: 'detail', text: `    ${tool.definition.description}`, fg: C.label, bg: '' });
          }
          const metadata: string[] = [];
          if (tool.definition.sideEffects && tool.definition.sideEffects.length > 0) {
            metadata.push(`effects: ${tool.definition.sideEffects.join(', ')}`);
          }
          if (tool.definition.concurrency) {
            metadata.push(`concurrency: ${tool.definition.concurrency}`);
          }
          if (tool.definition.supportsProgress) {
            metadata.push('progress');
          }
          if (tool.definition.supportsStreamingOutput) {
            metadata.push('streaming');
          }
          if (metadata.length > 0) {
            rows.push({ kind: 'detail', text: `    ${metadata.join('  |  ')}`, fg: C.dim, bg: '' });
          }
        }
      }
    } else if (this.section === 'models') {
      const models = this.providerRegistry?.listModels() ?? [];
      const filtered = q ? models.filter(m => m.id.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q)) : models;
      if (filtered.length === 0) {
        rows.push({ kind: 'empty', text: q ? ` No models match "${this.searchQuery}". Press Esc to clear the filter.` : ' Provider registry not wired into this session.', fg: C.dim, bg: '' });
      } else {
        // Group by provider
        const byProvider = new Map<string, typeof filtered>();
        for (const m of filtered) {
          let arr = byProvider.get(m.provider);
          if (!arr) { arr = []; byProvider.set(m.provider, arr); }
          arr.push(m);
        }
        // Live active-model marker (WO-136): Enter on a selectable row calls
        // providerRegistry.setCurrentModel, so re-derive this on every build
        // instead of caching it — it can change without this panel's input.
        const activeKey = this.providerRegistry?.getCurrentModel?.()?.registryKey;
        for (const [provider, pModels] of byProvider) {
          rows.push({ kind: 'header', text: ` ${provider} (${pModels.length})`, fg: C.sectionFg, bg: C.sectionBg, bold: true });
          for (const m of pModels) {
            const ctxK = m.contextWindow > 0 ? `${(m.contextWindow / 1000).toFixed(0)}k` : '?';
            const caps = [m.contextWindow > 0 ? `ctx:${ctxK}` : ''].filter(Boolean).join(' ');
            const isActive = m.registryKey === activeKey;
            const activeTag = isActive ? '  ACTIVE' : '';
            rows.push({
              kind: 'item',
              text: `  ${m.displayName}  ${caps}${activeTag}`,
              fg: isActive ? C.good : C.toolFg,
              bg: '',
              modelKey: m.registryKey,
              modelSelectable: m.selectable,
            });
            rows.push({ kind: 'detail', text: `    ${m.id}${m.selectable ? '' : '  (not selectable)'}`, fg: C.label, bg: '' });
          }
        }
      }
    } else {
      // Shortcuts — live bindings from KeybindingsManager.getAll() (WO-136),
      // including any user overrides from ~/.goodvibes/tui/keybindings.json.
      const km = this.keybindingsManager;
      const shortcuts = (km?.getAll() ?? []).map((entry) => ({
        key: entry.combos.length > 0 ? entry.combos.map((combo) => km!.formatCombo(combo)).join(', ') : '(unbound)',
        desc: entry.description,
      }));
      const filtered = q ? shortcuts.filter(s => s.key.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q)) : shortcuts;
      if (shortcuts.length === 0) {
        rows.push({ kind: 'empty', text: ' Keybindings manager not wired into this session.', fg: C.dim, bg: '' });
      } else {
        rows.push({ kind: 'header', text: ' Keyboard Shortcuts', fg: C.sectionFg, bg: C.sectionBg, bold: true });
        for (const s of filtered) {
          const key = s.key.padEnd(20);
          rows.push({ kind: 'item', text: `  ${key} ${s.desc}`, fg: C.value, bg: '' });
        }
      }
    }

    this.rows = rows;
    this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, rows.length - 1));
    this.markDirty();
  }
}
