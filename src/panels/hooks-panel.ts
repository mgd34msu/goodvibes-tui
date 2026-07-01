import type { Line } from '../types/grid.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import { listHookPointContracts } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookPointContract } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookActivityRecord, HookActivityTracker } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookAuthoringAction, HookSimulationResult } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookChain, HookDefinition } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookWorkbench } from '@pellux/goodvibes-sdk/platform/hooks';
import { truncateDisplay } from '../utils/terminal-width.ts';
import {
  buildKeyValueLine,
  buildKeyboardHints,
  buildPanelLine,
  buildStatusPill,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';

// Base chrome only — title band, state colors, and text tokens all come
// straight from DEFAULT_PANEL_PALETTE (WO-002).
const C = DEFAULT_PANEL_PALETTE;

export interface HooksPanelWorkbenchView {
  listManagedHooks(): Array<{ pattern: string; hook: HookDefinition }>;
  listManagedChains(): HookChain[];
  listRecentActions(limit?: number): HookAuthoringAction[];
  getLastSimulation(): HookSimulationResult | null;
  getHooksFilePath(): string;
}

export interface HooksPanelDataSource {
  listContracts(): HookPointContract[];
  listHooks(): Array<{ pattern: string; hook: HookDefinition }>;
  listChains(): HookChain[];
  listRecentActivity(limit?: number): readonly HookActivityRecord[];
  getWorkbench(): HooksPanelWorkbenchView;
}

function createDefaultDataSource(
  hookDispatcher: Pick<HookDispatcher, 'listHooks' | 'getChains'>,
  hookWorkbench: HookWorkbench,
  hookActivityTracker: Pick<HookActivityTracker, 'listRecent'>,
): HooksPanelDataSource {
  return {
    listContracts: () => listHookPointContracts(),
    listHooks: () => hookDispatcher.listHooks(),
    listChains: () => hookDispatcher.getChains(),
    listRecentActivity: (limit = 3) => hookActivityTracker.listRecent(limit),
    getWorkbench: () => hookWorkbench,
  };
}

type HookEntry = { pattern: string; hook: HookDefinition };

export class HooksPanel extends ScrollableListPanel<HookEntry> {
  private readonly dataSource: HooksPanelDataSource;

  public constructor(
    hookDispatcher: Pick<HookDispatcher, 'listHooks' | 'getChains'>,
    hookWorkbench: HookWorkbench,
    hookActivityTracker: Pick<HookActivityTracker, 'listRecent'>,
    dataSource: HooksPanelDataSource = createDefaultDataSource(hookDispatcher, hookWorkbench, hookActivityTracker),
  ) {
    super('hooks', 'Hooks', 'H', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.filterEnabled = true;
    this.filterLabel = 'Filter hooks';
    this.dataSource = dataSource;
  }

  protected override filterMatches(entry: HookEntry, q: string): boolean {
    return (entry.hook.name ?? '').toLowerCase().includes(q)
      || entry.pattern.toLowerCase().includes(q)
      || entry.hook.type.toLowerCase().includes(q);
  }

  protected override getPalette() { return C; }
  protected override getEmptyStateMessage() { return ' No hooks are currently registered.'; }
  protected override getEmptyStateActions() {
    return [
      { command: '/hooks', summary: 'review hook contracts and managed authoring actions' },
      { command: '/settings', summary: 'review hook/runtime behavior in the settings surface' },
    ];
  }

  protected getItems(): readonly HookEntry[] {
    return this.dataSource.listHooks();
  }

  protected renderItem(entry: HookEntry, index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [truncateDisplay(entry.hook.name ?? '(unnamed)', 20).padEnd(20), C.value, bg],
      [` ${truncateDisplay(entry.pattern, 28).padEnd(28)}`, C.info, bg],
      ...buildStatusPill(entry.hook.enabled === false ? 'warn' : 'good', ` ${(entry.hook.enabled === false ? 'DISABLED' : 'ENABLED').padEnd(8)}`, { bg }),
      [` ${entry.hook.type}`, C.dim, bg],
    ]);
  }

  public handleInput(key: string): boolean {
    if (!this.filterActive && key === 'r') {
      this.markDirty();
      return true;
    }
    return super.handleInput(key);
  }

  public render(width: number, height: number): Line[] {
    this.clampSelection();
    const hooks = this.dataSource.listHooks();
    const contracts = this.dataSource.listContracts();
    const chains = this.dataSource.listChains();
    const recentActivity = this.dataSource.listRecentActivity(3);
    const workbench = this.dataSource.getWorkbench();
    const managedHooks = workbench.listManagedHooks();
    const managedChains = workbench.listManagedChains();
    const recentAuthoring = workbench.listRecentActions(3);
    const lastSimulation = workbench.getLastSimulation();
    const intro = 'Hook contracts, active registrations, managed authoring, recent runtime activity, and simulation matches.';

    const selected = hooks[this.selectedIndex];
    const contract = selected ? contracts.find((c) => c.pattern === selected.pattern) : undefined;

    const detailLines: Line[] = [];
    if (selected) {
      detailLines.push(buildPanelLine(width, [
        ['  Hook: ', C.label],
        [selected.hook.name ?? '(unnamed)', C.value],
        ['  Type: ', C.label],
        [selected.hook.type, C.info],
        ['  Match: ', C.label],
        [selected.hook.matcher ?? selected.hook.match, C.value],
      ]));
      detailLines.push(buildPanelLine(width, [
        ['  Pattern: ', C.label],
        [truncateDisplay(selected.pattern, Math.max(0, width - 12)), C.value],
      ]));
      if (contract) {
        detailLines.push(buildPanelLine(width, [
          ['  Contract: ', C.label],
          [`${contract.authority} / ${contract.executionMode}`, C.info],
          ['  Policy: ', C.label],
          [contract.failurePolicy, C.value],
        ]));
        detailLines.push(buildPanelLine(width, [
          ['  Capabilities: ', C.label],
          [`deny=${contract.canDeny ? 'yes' : 'no'} mutate=${contract.canMutateInput ? 'yes' : 'no'} inject=${contract.canInjectContext ? 'yes' : 'no'}`, C.dim],
        ]));
      } else {
        detailLines.push(buildPanelLine(width, [['  Contract: No exact contract registered for this pattern.', C.warn]]));
      }
      detailLines.push(buildPanelLine(width, [
        ['  Summary: ', C.label],
        [`hooks=${hooks.length} chains=${chains.length} contracts=${contracts.length} managed=${managedHooks.length}/${managedChains.length}`, C.dim],
      ]));
      detailLines.push(buildPanelLine(width, [
        ['  Hooks file: ', C.label],
        [truncateDisplay(workbench.getHooksFilePath(), Math.max(0, width - 15)), C.dim],
      ]));
    }

    const activityLines: Line[] = recentActivity.length === 0
      ? [buildPanelLine(width, [['  No hook activity recorded yet.', C.empty]])]
      : recentActivity.map((record) => {
          const color = !record.ok ? C.bad : record.decision === 'deny' ? C.warn : C.good;
          return buildPanelLine(width, [
            ['  ', C.label],
            [truncateDisplay(record.hookName, 18).padEnd(18), C.value],
            ['  ', C.label],
            [truncateDisplay(record.path, 26).padEnd(26), C.info],
            ['  ', C.label],
            [record.ok ? (record.decision ?? 'ok') : 'error', color],
          ]);
        });

    const authoringLines: Line[] = recentAuthoring.length === 0
      ? [buildPanelLine(width, [['  No managed hook authoring actions recorded yet.', C.empty]])]
      : recentAuthoring.map((action) => buildPanelLine(width, [
          ['  ', C.label],
          [truncateDisplay(action.kind, 14).padEnd(14), C.info],
          ['  ', C.label],
          [truncateDisplay(action.target, Math.max(0, width - 20)), C.dim],
        ]));
    if (lastSimulation) {
      authoringLines.push(buildPanelLine(width, [
        ['  Last Simulation: ', C.label],
        [truncateDisplay(lastSimulation.eventPath, Math.max(0, width - 20)), C.value],
      ]));
      authoringLines.push(buildPanelLine(width, [
        ['  Matches: ', C.label],
        [`hooks=${lastSimulation.matchedHooks.length} chains=${lastSimulation.matchedChains.length}`, C.dim],
      ]));
    }

    // Empty state: show extra context lines (hooks file, contracts, authoring) before base empty state
    if (hooks.length === 0) {
      const extraHeader: Line[] = [
        buildPanelLine(width, [
          ['  Contracts: ', C.label],
          [String(contracts.length), C.value],
          ['  Chains: ', C.label],
          [String(chains.length), C.value],
          ['  Managed: ', C.label],
          [String(managedHooks.length), C.info],
        ]),
        buildPanelLine(width, [
          ['  Hooks file: ', C.label],
          [truncateDisplay(workbench.getHooksFilePath(), Math.max(0, width - 15)), C.dim],
        ]),
      ];
      if (recentAuthoring.length > 0) {
        extraHeader.push(buildPanelLine(width, [
          ['  Authoring: ', C.label],
          [truncateDisplay(`${recentAuthoring[0]!.kind} ${recentAuthoring[0]!.target}`, Math.max(0, width - 14)), C.info],
        ]));
      }
      if (lastSimulation) {
        extraHeader.push(buildPanelLine(width, [
          ['  Last Simulation: ', C.label],
          [truncateDisplay(lastSimulation.eventPath, Math.max(0, width - 20)), C.value],
        ]));
      }
      return this.renderList(width, height, {
        title: 'Hooks Control Room',
        header: extraHeader,
      });
    }

    // Summary header — surface registration + activity counts first so the most
    // important "what's firing" signal is visible without scrolling to the footer.
    const denials = recentActivity.filter((r) => r.ok && r.decision === 'deny').length;
    const errors = recentActivity.filter((r) => !r.ok).length;
    const headerLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'hooks', value: String(hooks.length), valueColor: C.info },
        { label: 'chains', value: String(chains.length), valueColor: C.value },
        { label: 'contracts', value: String(contracts.length), valueColor: C.value },
        { label: 'recent denials', value: String(denials), valueColor: denials > 0 ? C.warn : C.dim },
        { label: 'errors', value: String(errors), valueColor: errors > 0 ? C.bad : C.dim },
      ], C),
    ];

    const hints = this.filterActive
      ? [{ keys: 'type', label: 'filter' }, { keys: 'Enter', label: 'apply' }, { keys: 'Esc', label: 'clear' }]
      : [
          { keys: 'Up/Down', label: 'move' },
          { keys: 'r', label: 'refresh' },
          { keys: '/hooks', label: 'full listing' },
          { keys: '/', label: 'filter' },
        ];

    return this.renderList(width, height, {
      title: 'Hooks Control Room',
      header: headerLines,
      footer: [
        ...detailLines,
        buildPanelLine(width, [['  Recent Activity', C.label]]),
        ...activityLines,
        buildPanelLine(width, [['  Authoring', C.label]]),
        ...authoringLines,
        buildKeyboardHints(width, hints, C),
      ],
    });
  }
}
