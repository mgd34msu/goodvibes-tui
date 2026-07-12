import { infoRow } from './modal-surface-helpers.ts';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalTab,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';

// ---------------------------------------------------------------------------
// Docs + Shortcuts → 'keybindings' config-modal surface (group-B port).
// A MERGE of the retired DocsPanel (tools/models/shortcuts) and the
// shortcuts-overlay reference. Three tabs: 'Tools', 'Models', and 'Shortcuts'
// (the categorized keyboard reference — driven live off keybindingsManager so
// user overrides show up — followed by an exhaustive 'All Bindings (live)'
// table). Enter opens the tool-inspector successor ('fleet') or switches the
// active model, both via the command path (fleet is a panel; /model is a
// settings mutation). Selection-blind port: the panel's selected tool/model
// detail is folded into each row label. The panel's live '/' filter is dropped
// (the host has no query state).
// ---------------------------------------------------------------------------

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
export interface KeybindingsModalToolRegistry { list(): readonly KeybindingsModalTool[]; }
export interface KeybindingsModalModel { readonly id: string; readonly provider: string; readonly registryKey: string; readonly displayName: string; readonly contextWindow: number; readonly selectable: boolean; }
export interface KeybindingsModalProviderRegistry { listModels(): readonly KeybindingsModalModel[]; getCurrentModel?(): { readonly registryKey: string } | undefined; }

export interface KeybindingsModalDeps {
  readonly toolRegistry?: KeybindingsModalToolRegistry;
  readonly providerRegistry?: KeybindingsModalProviderRegistry;
  readonly keybindingsManager?: KeybindingsManager;
}

class KeybindingsModalSurface implements ConfigModalSurface {
  readonly name = 'keybindings-modal';
  readonly title = 'Keybindings';

  constructor(private readonly deps: KeybindingsModalDeps) {}

  readonly actions = [
    { key: 'enter', id: 'activate', label: 'activate', enabledFor: (row: ConfigModalRow | null, tabId: string) => (tabId === 'tools') || (tabId === 'models' && row !== null) },
    { key: 'r', id: 'refresh', label: 'refresh' },
  ];

  private sortedModels(): readonly KeybindingsModalModel[] {
    const models = this.deps.providerRegistry?.listModels() ?? [];
    return [...models].sort((a, b) => a.provider.localeCompare(b.provider) || a.displayName.localeCompare(b.displayName));
  }

  private toolsTab(): ConfigModalTab {
    if (!this.deps.toolRegistry) return { id: 'tools', label: 'Tools', rows: [infoRow('tools:none', 'Tool registry not wired into this session.', { dim: true })], emptyText: 'Tool registry not wired into this session.' };
    const tools = this.deps.toolRegistry.list();
    const rows: ConfigModalRow[] = tools.map((tool) => {
      const d = tool.definition;
      const meta: string[] = [];
      if (d.sideEffects?.length) meta.push(`effects: ${d.sideEffects.join(', ')}`);
      if (d.concurrency) meta.push(`concurrency: ${d.concurrency}`);
      if (d.supportsProgress) meta.push('progress');
      if (d.supportsStreamingOutput) meta.push('streaming');
      const detail = [d.description, meta.join('  |  ') || null].filter((s): s is string => Boolean(s)).join(' · ');
      return { id: `tool:${d.name}`, label: detail ? `${d.name.padEnd(22)} ${detail}` : d.name };
    });
    return { id: 'tools', label: 'Tools', rows, emptyText: 'No tools registered.', hints: ['enter open in fleet'] };
  }

  private modelsTab(): ConfigModalTab {
    if (!this.deps.providerRegistry) return { id: 'models', label: 'Models', rows: [infoRow('models:none', 'Provider registry not wired into this session.', { dim: true })], emptyText: 'Provider registry not wired into this session.' };
    const activeKey = this.deps.providerRegistry.getCurrentModel?.()?.registryKey;
    const rows: ConfigModalRow[] = this.sortedModels().map((model) => {
      const ctxK = model.contextWindow > 0 ? `${(model.contextWindow / 1000).toFixed(0)}k` : '?';
      const isActive = model.registryKey === activeKey;
      return { id: `model:${model.registryKey}`, label: `${model.provider.padEnd(14)} ${model.displayName.padEnd(24)} ctx:${ctxK}${isActive ? '  ACTIVE' : ''}  ${model.id}${model.selectable ? '' : '  (not selectable)'}` };
    });
    return { id: 'models', label: 'Models', rows, emptyText: 'No models registered.', hints: ['enter set active model'] };
  }

  private shortcutsTab(): ConfigModalTab {
    const km = this.deps.keybindingsManager;
    if (!km) return { id: 'shortcuts', label: 'Shortcuts', rows: [infoRow('sc:none', 'Keybindings manager not wired into this session.', { dim: true })], emptyText: 'Keybindings manager not wired into this session.' };
    const kb = (action: Parameters<KeybindingsManager['getComboLabel']>[0]) => km.getComboLabel(action);
    const rows: ConfigModalRow[] = [];
    let n = 0;
    const category = (title: string, entries: ReadonlyArray<readonly [string, string]>): void => {
      rows.push(infoRow(`sc:t:${n++}`, title));
      for (const [key, desc] of entries) rows.push(infoRow(`sc:${n++}`, `${key.padEnd(20)} ${desc}`));
    };
    category('Navigation', [['Up / Down', 'Scroll / history recall'], ['PageUp / PageDn', 'Scroll by full page'], ['Home / End', 'Jump to start / end of line'], [kb('search'), 'Search conversation'], ['n / N (search)', 'Next / previous match'], ['Mouse wheel', 'Scroll conversation or hovered panel']]);
    category('Editing', [['Enter', 'Submit message'], ['Shift+Enter', 'Insert newline'], ['@', 'Open file picker'], ['/', 'Slash command mode'], [kb('paste'), 'Paste (image priority)'], [`${kb('undo')} / ${kb('redo')}`, 'Undo / redo'], [kb('clear-prompt'), 'Clear prompt'], [kb('delete-word'), 'Delete word backward'], [kb('kill-line'), 'Kill to end of line']]);
    category('Actions', [['Tab', 'Collapse/expand block'], [kb('bookmark'), 'Bookmark block'], [kb('block-copy'), 'Copy block to clipboard'], [kb('block-save'), 'Save block to file'], [kb('copy-selection'), 'Copy selection'], ['F2', 'Process monitor'], ['?', 'Help overlay'], [`${kb('clear-cancel')} x2`, 'Exit']]);
    category('Panels', [['Tab', 'Swap focus between input and panel workspace'], [kb('panel-picker'), 'Open / focus / hide panel workspace'], [kb('panel-tab-next'), 'Next workspace panel tab'], [kb('panel-tab-prev'), 'Previous workspace panel tab'], [`${kb('panel-tab-1')}...${kb('panel-tab-9')}`, 'Jump to workspace tab 1-9'], [kb('panel-focus-toggle'), 'Swap focus between top / bottom pane'], [kb('panel-close'), 'Close active panel'], [kb('panel-close-all'), 'Close all panels'], [kb('panel-ops'), 'Open the Ops Control panel']]);
    category('In-Panel Controls', [['j / k', 'Move selection down / up'], ['g / G', 'Jump to top / bottom'], ['/', 'Filter the list']]);
    const allBindings = km.getAll().map((entry) => [entry.combos.length > 0 ? entry.combos.map((combo) => km.formatCombo(combo)).join(', ') : '(unbound)', entry.description] as const);
    category('All Bindings (live)', allBindings);
    return { id: 'shortcuts', label: 'Shortcuts', rows, emptyText: 'No shortcuts recorded.' };
  }

  buildView(): ConfigModalView {
    return { title: 'Keybindings', tabs: [this.toolsTab(), this.modelsTab(), this.shortcutsTab()] };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') { ctx.setStatus('Docs & shortcuts are read live.'); ctx.requestRender(); return; }
    if (id !== 'activate') return;
    if (ctx.tabId === 'tools') {
      // item 4: pass the tool name through as a deep-link target.
      // Honest caveat (documented, not a bug to silently paper over): fleet's
      // ProcessKind set has no 'tool' node — a docs Tools row names a static
      // tool DEFINITION, not a live process, so FleetPanel.receiveDeepLink
      // will not currently find a match and shows its honest "node no longer
      // present" line. The plumbing is still worth wiring now (matches the
      // work-plan agent/wrfc jumps' shape) — it starts resolving for free the
      // day fleet grows a per-tool-call node (the retired DocsPanel's own
      // comment already anticipated this: "no filter-by-tool equivalent
      // there yet").
      const toolName = ctx.row?.id.startsWith('tool:') ? ctx.row.id.slice('tool:'.length) : null;
      void ctx.executeCommand?.('panel', toolName ? ['open', 'fleet', '--target', `${toolName}:tool`] : ['open', 'fleet']);
      ctx.setStatus('Opened the tool inspector (fleet).');
      return;
    }
    if (ctx.tabId === 'models') {
      const key = ctx.row?.id.startsWith('model:') ? ctx.row.id.slice('model:'.length) : null;
      if (!key) return;
      const model = this.sortedModels().find((m) => m.registryKey === key);
      if (!model || !model.selectable) { ctx.setStatus('This model is not selectable.'); return; }
      void ctx.executeCommand?.('model', [model.registryKey]);
      ctx.setStatus(`Dispatched /model ${model.registryKey}.`);
    }
  }
}

export function createKeybindingsModalSurface(deps: KeybindingsModalDeps): ConfigModalSurface {
  return new KeybindingsModalSurface(deps);
}

/**
 * Deterministic golden fixture. KeybindingsManager is pointed at a nonexistent
 * config path so it always resolves to DEFAULT_KEYBINDINGS. Tool and model
 * fixtures are frozen literals — no disk, no live registry.
 */
export function keybindingsModalGoldenSurface(): ConfigModalSurface {
  const keybindingsManager = new KeybindingsManager({ configPath: '/nonexistent/golden-keybindings.json' });
  const toolRegistry: KeybindingsModalToolRegistry = {
    list: () => [
      { definition: { name: 'read_file', description: 'Read a file from disk.', sideEffects: ['read_fs'], concurrency: 'parallel', supportsProgress: false, supportsStreamingOutput: false } },
      { definition: { name: 'run_shell', description: 'Execute a shell command.', sideEffects: ['exec'], concurrency: 'serial', supportsProgress: true, supportsStreamingOutput: true } },
    ],
  };
  const providerRegistry: KeybindingsModalProviderRegistry = {
    listModels: () => [
      { id: 'golden-a', provider: 'golden-provider', registryKey: 'golden-provider:golden-a', displayName: 'Golden Model A', contextWindow: 128000, selectable: true },
      { id: 'golden-b', provider: 'golden-provider', registryKey: 'golden-provider:golden-b', displayName: 'Golden Model B', contextWindow: 32000, selectable: false },
    ],
    getCurrentModel: () => ({ registryKey: 'golden-provider:golden-a' }),
  };
  return createKeybindingsModalSurface({ toolRegistry, providerRegistry, keybindingsManager });
}
