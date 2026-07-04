import type { ModalConfig, ModalSection, ModalListItem } from '../../renderer/modal-factory.ts';
import type { BoundModalSurface, ModalAction, ModalViewState } from './modal-surface.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';

// ---------------------------------------------------------------------------
// Docs + Shortcuts → 'keybindings' modal (W6 WO-B).
//
// This is a MERGE of two retired/adjacent surfaces:
//   - src/panels/docs-panel.ts (DocsPanel): tools / models / shortcuts tabs,
//     where the 'shortcuts' tab was a flat live enumeration of
//     KeybindingsManager.getAll().
//   - src/renderer/help-overlay.ts renderShortcutsOverlay(): the richer
//     categorized keyboard reference (Navigation / Editing / Actions /
//     Panels / In-Panel Controls), mixing rebindable actions (looked up live
//     via keybindingsManager.getComboLabel) with static, non-rebindable keys
//     (Enter, Shift+Enter, mouse wheel, j/k, g/G, etc.) that have no KeyAction
//     entry at all.
//
// The merged 'Shortcuts' tab below renders the categorized reference first
// (parity with renderShortcutsOverlay, still driven live off
// keybindingsManager so user overrides show up), then an exhaustive
// 'All Bindings (live)' table (parity with DocsPanel's original flat list),
// so no bindable action can fall out of view even if a future action is
// never added to a curated category.
//
// Action parity (charter — see modal-surface.ts): the only "activation" this
// surface performs is opening the tool-inspector successor ('fleet') or
// switching the active model, both live navigation/settings actions with no
// destructive/approval semantics, but neither is a modal-to-modal
// cross-open ('fleet' is a panel, not a registered BoundModalSurface), so
// both route through runCommand rather than an in-modal state mutation.
// ---------------------------------------------------------------------------

type KeybindingsModalSection = 'tools' | 'models' | 'shortcuts';

/**
 * Minimal structural slice of `Tool` (@pellux/goodvibes-sdk/platform/types/tools,
 * re-exported as `ToolCatalogQuery.list(): Tool[]` via
 * src/runtime/ui-service-queries.ts) that this modal reads.
 */
export interface KeybindingsModalTool {
  readonly definition: {
    readonly name: string;
    readonly description?: string;
    readonly sideEffects?: readonly string[];
    readonly concurrency?: string;
    readonly supportsProgress?: boolean;
    readonly supportsStreamingOutput?: boolean;
  };
}

/** Minimal structural slice of `ToolCatalogQuery` (src/runtime/ui-service-queries.ts). */
export interface KeybindingsModalToolRegistry {
  list(): readonly KeybindingsModalTool[];
}

/**
 * Minimal structural slice of `ModelDefinition`
 * (@pellux/goodvibes-sdk/platform/providers) that this modal reads — mirrors
 * the `DocsProviderRegistry` structural view already used by
 * src/panels/docs-panel.ts. `setCurrentModel` is intentionally NOT part of
 * this shape: switching models is a settings mutation, so it routes through
 * the `/model` command instead of being called directly from the modal.
 */
export interface KeybindingsModalModel {
  readonly id: string;
  readonly provider: string;
  readonly registryKey: string;
  readonly displayName: string;
  readonly contextWindow: number;
  readonly selectable: boolean;
}

/** Minimal structural slice of the live provider registry (mirrors DocsProviderRegistry). */
export interface KeybindingsModalProviderRegistry {
  listModels(): readonly KeybindingsModalModel[];
  getCurrentModel?(): { readonly registryKey: string } | undefined;
}

export interface KeybindingsModalDeps {
  readonly toolRegistry?: KeybindingsModalToolRegistry;
  readonly providerRegistry?: KeybindingsModalProviderRegistry;
  /**
   * The real class (src/input/keybindings.ts) is used directly rather than a
   * restated structural interface: the golden fixture below must construct
   * one (`new KeybindingsManager({ configPath: '/nonexistent/...' })`) to get
   * deterministic default bindings, and every method this modal calls
   * (getAll/getComboLabel/formatCombo) is read-only.
   */
  readonly keybindingsManager?: KeybindingsManager;
}

function matches(haystacks: readonly (string | undefined)[], q: string): boolean {
  if (q === '') return true;
  const needle = q.toLowerCase();
  return haystacks.some((value) => (value ?? '').toLowerCase().includes(needle));
}

function visibleTools(deps: KeybindingsModalDeps, query: string): readonly KeybindingsModalTool[] {
  const tools = deps.toolRegistry?.list() ?? [];
  const q = query.trim();
  return q === '' ? tools : tools.filter((t) => matches([t.definition.name, t.definition.description], q));
}

function visibleModels(deps: KeybindingsModalDeps, query: string): readonly KeybindingsModalModel[] {
  const models = deps.providerRegistry?.listModels() ?? [];
  const q = query.trim();
  const filtered = q === '' ? models : models.filter((m) => matches([m.id, m.displayName, m.provider], q));
  return [...filtered].sort((a, b) => a.provider.localeCompare(b.provider) || a.displayName.localeCompare(b.displayName));
}

function buildToolsSection(deps: KeybindingsModalDeps, view: ModalViewState): ModalSection[] {
  if (!deps.toolRegistry) {
    return [{ type: 'text', content: 'Tool registry not wired into this session.', style: { dim: true } }];
  }
  const filtered = visibleTools(deps, view.query);
  if (filtered.length === 0) {
    return [{ type: 'text', content: view.query ? `No tools match "${view.query}".` : 'No tools registered.', style: { dim: true } }];
  }
  const sections: ModalSection[] = [];
  const clampedIndex = Math.max(0, Math.min(view.selectedIndex, filtered.length - 1));
  const items: ModalListItem[] = filtered.map((tool, index) => ({
    label: tool.definition.name,
    selected: index === clampedIndex,
  }));
  sections.push({ type: 'list', items });
  const selected = filtered[clampedIndex];
  if (selected) {
    sections.push({ type: 'separator' });
    if (selected.definition.description) {
      sections.push({ type: 'text', content: selected.definition.description, style: { dim: true } });
    }
    const metadata: string[] = [];
    if (selected.definition.sideEffects?.length) metadata.push(`effects: ${selected.definition.sideEffects.join(', ')}`);
    if (selected.definition.concurrency) metadata.push(`concurrency: ${selected.definition.concurrency}`);
    if (selected.definition.supportsProgress) metadata.push('progress');
    if (selected.definition.supportsStreamingOutput) metadata.push('streaming');
    if (metadata.length > 0) sections.push({ type: 'text', content: metadata.join('  |  '), style: { dim: true } });
  }
  return sections;
}

function buildModelsSection(deps: KeybindingsModalDeps, view: ModalViewState): ModalSection[] {
  if (!deps.providerRegistry) {
    return [{ type: 'text', content: 'Provider registry not wired into this session.', style: { dim: true } }];
  }
  const filtered = visibleModels(deps, view.query);
  if (filtered.length === 0) {
    return [{ type: 'text', content: view.query ? `No models match "${view.query}".` : 'No models registered.', style: { dim: true } }];
  }
  const sections: ModalSection[] = [];
  const clampedIndex = Math.max(0, Math.min(view.selectedIndex, filtered.length - 1));
  const activeKey = deps.providerRegistry.getCurrentModel?.()?.registryKey;
  const items: ModalListItem[] = filtered.map((model, index) => {
    const ctxK = model.contextWindow > 0 ? `${(model.contextWindow / 1000).toFixed(0)}k` : '?';
    const isActive = model.registryKey === activeKey;
    return {
      label: `${model.provider.padEnd(14)} ${model.displayName.padEnd(24)} ctx:${ctxK}${isActive ? '  ACTIVE' : ''}`,
      selected: index === clampedIndex,
    };
  });
  sections.push({ type: 'list', items });
  const selected = filtered[clampedIndex];
  if (selected) {
    sections.push({ type: 'separator' });
    sections.push({ type: 'text', content: `${selected.id}${selected.selectable ? '' : '  (not selectable)'}`, style: { dim: true } });
  }
  return sections;
}

/** category rows as [key-label, description] tuples, filtered by the live query. */
function pushCategory(sections: ModalSection[], title: string, rows: ReadonlyArray<readonly [string, string]>, q: string): void {
  const filteredRows = q === ''
    ? rows
    : rows.filter(([key, desc]) => key.toLowerCase().includes(q) || desc.toLowerCase().includes(q));
  if (filteredRows.length === 0) return;
  sections.push({ type: 'title', content: title });
  for (const [key, desc] of filteredRows) {
    sections.push({ type: 'text', content: `${key.padEnd(20)} ${desc}` });
  }
}

function buildShortcutsSection(deps: KeybindingsModalDeps, view: ModalViewState): ModalSection[] {
  const km = deps.keybindingsManager;
  if (!km) {
    return [{ type: 'text', content: 'Keybindings manager not wired into this session.', style: { dim: true } }];
  }
  const q = view.query.trim().toLowerCase();
  const kb = (action: Parameters<KeybindingsManager['getComboLabel']>[0]) => km.getComboLabel(action);
  const sections: ModalSection[] = [];

  // Categorized reference — mirrors renderShortcutsOverlay (src/renderer/help-overlay.ts),
  // including its static (non-rebindable) rows, but driven live off `km` so
  // rebindable labels reflect any user overrides loaded from disk.
  pushCategory(sections, 'Navigation', [
    ['Up / Down', 'Scroll / history recall'],
    ['PageUp / PageDn', 'Scroll by full page'],
    ['Home / End', 'Jump to start / end of line'],
    [kb('search'), 'Search conversation'],
    ['n / N (search)', 'Next / previous match'],
    ['Mouse wheel', 'Scroll conversation or hovered panel'],
  ], q);
  pushCategory(sections, 'Editing', [
    ['Enter', 'Submit message'],
    ['Shift+Enter', 'Insert newline'],
    ['@', 'Open file picker'],
    ['/', 'Slash command mode'],
    [kb('paste'), 'Paste (image priority)'],
    [`${kb('undo')} / ${kb('redo')}`, 'Undo / redo'],
    [kb('clear-prompt'), 'Clear prompt'],
    [kb('delete-word'), 'Delete word backward'],
    [kb('kill-line'), 'Kill to end of line'],
  ], q);
  pushCategory(sections, 'Actions', [
    ['Tab', 'Collapse/expand block'],
    [kb('bookmark'), 'Bookmark block'],
    [kb('block-copy'), 'Copy block to clipboard'],
    [kb('block-save'), 'Save block to file'],
    [kb('copy-selection'), 'Copy selection'],
    ['F2', 'Process monitor'],
    ['?', 'Help overlay'],
    [`${kb('clear-cancel')} x2`, 'Exit'],
  ], q);
  pushCategory(sections, 'Panels', [
    ['Tab', 'Swap focus between input and panel workspace'],
    [kb('panel-picker'), 'Open / focus / hide panel workspace'],
    [kb('panel-tab-next'), 'Next workspace panel tab'],
    [kb('panel-tab-prev'), 'Previous workspace panel tab'],
    [`${kb('panel-tab-1')}...${kb('panel-tab-9')}`, 'Jump to workspace tab 1-9'],
    [kb('panel-focus-toggle'), 'Swap focus between top / bottom pane'],
    [kb('panel-close'), 'Close active panel'],
    [kb('panel-close-all'), 'Close all panels'],
    [kb('panel-ops'), 'Open the Ops Control panel'],
  ], q);
  pushCategory(sections, 'In-Panel Controls', [
    ['j / k', 'Move selection down / up'],
    ['g / G', 'Jump to top / bottom'],
    ['/', 'Filter the list'],
  ], q);

  // Exhaustive live table — parity with DocsPanel's original flat
  // `keybindingsManager.getAll()` enumeration, so any action not named in a
  // curated category above (or added later) is still discoverable.
  const allBindings = km.getAll().map((entry) => [
    entry.combos.length > 0 ? entry.combos.map((combo) => km.formatCombo(combo)).join(', ') : '(unbound)',
    entry.description,
  ] as const);
  pushCategory(sections, 'All Bindings (live)', allBindings, q);

  if (sections.length === 0) {
    sections.push({ type: 'text', content: `No shortcuts match "${view.query}".`, style: { dim: true } });
  }
  return sections;
}

/**
 * Docs + Shortcuts → modal. Tools/Models tabs mirror DocsPanel's live reads
 * (no disk I/O, so refresh() is a no-op); the merged Shortcuts tab folds in
 * the categorized shortcuts-overlay reference. `activeSection` is
 * surface-owned mutable state (like DocsPanel's own `this.section`) since
 * ModalViewState has no tab field — tab switches are dispatched as actions
 * rather than encoded in the shared view.
 */
export function bindKeybindingsModal(deps: KeybindingsModalDeps): BoundModalSurface {
  let activeSection: KeybindingsModalSection = 'tools';

  const buildConfig = (view: ModalViewState): ModalConfig => {
    const sections = activeSection === 'tools'
      ? buildToolsSection(deps, view)
      : activeSection === 'models'
      ? buildModelsSection(deps, view)
      : buildShortcutsSection(deps, view);

    return {
      title: 'Keybindings',
      width: 84,
      tabs: [
        { label: 'Tools', active: activeSection === 'tools' },
        { label: 'Models', active: activeSection === 'models' },
        { label: 'Shortcuts', active: activeSection === 'shortcuts' },
      ],
      search: view.query,
      sections,
      hints: [
        't tools',
        'm models',
        'k shortcuts',
        ...(activeSection === 'tools' ? ['enter open in fleet'] : []),
        ...(activeSection === 'models' ? ['enter set active model'] : []),
        '/ filter',
      ],
    };
  };

  const activate: ModalAction = (view) => {
    if (activeSection === 'tools') {
      const tools = visibleTools(deps, view.query);
      if (tools.length === 0) return { kind: 'none' };
      // Cross-open: 'fleet' is a live panel, not a registered BoundModalSurface,
      // so this can't use the `openModal` outcome — it routes through the
      // existing `/panel open <id>` command path instead (mirrors DocsPanel's
      // own handlePanelIntegrationAction, which opens 'fleet' directly).
      return { kind: 'runCommand', command: '/panel open fleet' };
    }
    if (activeSection === 'models') {
      const models = visibleModels(deps, view.query);
      if (models.length === 0) return { kind: 'none' };
      const index = Math.max(0, Math.min(view.selectedIndex, models.length - 1));
      const model = models[index];
      if (!model || !model.selectable) return { kind: 'none' };
      return { kind: 'runCommand', command: `/model ${model.registryKey}` };
    }
    return { kind: 'none' };
  };

  return {
    name: 'keybindings',
    title: 'Keybindings',
    // Tools/models are live in-memory reads (ToolCatalogQuery.list() /
    // ProviderModelCatalogQuery.listModels() do no disk I/O per call, same as
    // DocsPanel), and the shortcuts tab reads keybindingsManager.getAll()
    // live — nothing here is cached, so there is nothing to reload.
    refresh: () => {},
    buildConfig,
    rowIds: (view) => {
      if (activeSection === 'tools') return visibleTools(deps, view.query).map((t) => `tool:${t.definition.name}`);
      if (activeSection === 'models') return visibleModels(deps, view.query).map((m) => `model:${m.registryKey}`);
      return [];
    },
    actions: {
      tools: () => { activeSection = 'tools'; return { kind: 'none' }; },
      models: () => { activeSection = 'models'; return { kind: 'none' }; },
      shortcuts: () => { activeSection = 'shortcuts'; return { kind: 'none' }; },
      activate,
      refresh: () => ({ kind: 'refresh' }),
    },
  };
}

/**
 * Deterministic golden fixture. KeybindingsManager is pointed at a
 * nonexistent config path so it always resolves to DEFAULT_KEYBINDINGS (the
 * exact pattern the shortcuts-overlay golden uses — see
 * src/test/renderer/golden-frames.test.ts's GOLDEN_KEYBINDINGS). Tool and
 * model fixtures are frozen literals — no disk, no live registry.
 */
export function keybindingsModalGoldenSurface(): BoundModalSurface {
  const keybindingsManager = new KeybindingsManager({ configPath: '/nonexistent/golden-keybindings.json' });
  const toolRegistry: KeybindingsModalToolRegistry = {
    list: () => [
      {
        definition: {
          name: 'read_file',
          description: 'Read a file from disk.',
          sideEffects: ['read_fs'],
          concurrency: 'parallel',
          supportsProgress: false,
          supportsStreamingOutput: false,
        },
      },
      {
        definition: {
          name: 'run_shell',
          description: 'Execute a shell command.',
          sideEffects: ['exec'],
          concurrency: 'serial',
          supportsProgress: true,
          supportsStreamingOutput: true,
        },
      },
    ],
  };
  const providerRegistry: KeybindingsModalProviderRegistry = {
    listModels: () => [
      { id: 'golden-a', provider: 'golden-provider', registryKey: 'golden-provider:golden-a', displayName: 'Golden Model A', contextWindow: 128000, selectable: true },
      { id: 'golden-b', provider: 'golden-provider', registryKey: 'golden-provider:golden-b', displayName: 'Golden Model B', contextWindow: 32000, selectable: false },
    ],
    getCurrentModel: () => ({ registryKey: 'golden-provider:golden-a' }),
  };
  const surface = bindKeybindingsModal({ toolRegistry, providerRegistry, keybindingsManager });
  surface.refresh();
  return surface;
}
