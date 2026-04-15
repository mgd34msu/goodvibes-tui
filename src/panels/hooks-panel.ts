import type { Line } from '@pellux/goodvibes-sdk/platform/types/grid';
import { createEmptyLine } from '@pellux/goodvibes-sdk/platform/types/grid';
import { BasePanel } from './base-panel.ts';
import { listHookPointContracts } from '../hooks/index.ts';
import type { HookDispatcher } from '../hooks/dispatcher.ts';
import type { HookPointContract } from '@pellux/goodvibes-sdk/platform/hooks/contracts';
import type { HookActivityRecord, HookActivityTracker } from '@pellux/goodvibes-sdk/platform/hooks/activity';
import type { HookAuthoringAction, HookSimulationResult } from '../hooks/workbench.ts';
import type { HookChain, HookDefinition } from '@pellux/goodvibes-sdk/platform/hooks/types';
import type { HookWorkbench } from '../hooks/workbench.ts';
import { truncateDisplay } from '@pellux/goodvibes-sdk/platform/utils/terminal-width';
import {
  buildEmptyState,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  resolvePrimaryScrollableSection,
  type PanelWorkspaceSection,
} from './polish.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#94a3b8',
  headerBg: '#1e293b',
  ok: '#22c55e',
  warn: '#eab308',
  error: '#ef4444',
  info: '#38bdf8',
  selectBg: '#0f172a',
} as const;

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

export class HooksPanel extends BasePanel {
  private selectedIndex = 0;
  private scrollOffset = 0;
  private readonly dataSource: HooksPanelDataSource;

  public constructor(
    hookDispatcher: Pick<HookDispatcher, 'listHooks' | 'getChains'>,
    hookWorkbench: HookWorkbench,
    hookActivityTracker: Pick<HookActivityTracker, 'listRecent'>,
    dataSource: HooksPanelDataSource = createDefaultDataSource(hookDispatcher, hookWorkbench, hookActivityTracker),
  ) {
    super('hooks', 'Hooks', 'H', 'monitoring');
    this.dataSource = dataSource;
  }

  public handleInput(key: string): boolean {
    const entries = this.dataSource.listHooks();
    if (key === 'r') {
      this.markDirty();
      return true;
    }
    if (entries.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(entries.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const intro = 'Hook contracts, active registrations, managed authoring, recent runtime activity, and simulation matches.';
    const contracts = this.dataSource.listContracts();
    const hooks = this.dataSource.listHooks();
    const chains = this.dataSource.listChains();
    const recentActivity = this.dataSource.listRecentActivity(3);
    const workbench = this.dataSource.getWorkbench();
    const managedHooks = workbench.listManagedHooks();
    const managedChains = workbench.listManagedChains();
    const recentAuthoring = workbench.listRecentActions(3);
    const lastSimulation = workbench.getLastSimulation();

    if (hooks.length === 0) {
      const emptyLines = [
        ...buildEmptyState(
          width,
          ' No hooks are currently registered.',
          'Configure hooks.json or register hooks programmatically, then use this workspace to review contracts, activity, and managed authoring state.',
          [
            { command: '/hooks', summary: 'review hook contracts and managed authoring actions' },
            { command: '/settings', summary: 'review hook/runtime behavior in the settings surface' },
          ],
          C,
        ),
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
        emptyLines.push(buildPanelLine(width, [
          ['  Authoring: ', C.label],
          [truncateDisplay(`${recentAuthoring[0]!.kind} ${recentAuthoring[0]!.target}`, Math.max(0, width - 14)), C.info],
        ]));
      }
      if (lastSimulation) {
        emptyLines.push(buildPanelLine(width, [
          ['  Last Simulation: ', C.label],
          [truncateDisplay(lastSimulation.eventPath, Math.max(0, width - 20)), C.value],
        ]));
      }
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Hooks Control Room',
        intro,
        sections: [{ lines: emptyLines }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    this.selectedIndex = Math.min(this.selectedIndex, hooks.length - 1);
    const selected = hooks[this.selectedIndex]!;
    const contract = contracts.find((candidate) => candidate.pattern === selected.pattern);
    const detailLines: Line[] = [
      buildPanelLine(width, [
        ['  Hook: ', C.label],
        [selected.hook.name ?? '(unnamed)', C.value],
        ['  Type: ', C.label],
        [selected.hook.type, C.info],
        ['  Match: ', C.label],
        [selected.hook.matcher ?? selected.hook.match, C.value],
      ]),
      buildPanelLine(width, [
        ['  Pattern: ', C.label],
        [truncateDisplay(selected.pattern, Math.max(0, width - 12)), C.value],
      ]),
    ];
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

    const activityLines: Line[] = recentActivity.length === 0
      ? [buildPanelLine(width, [['  No hook activity recorded yet.', C.empty]])]
      : recentActivity.map((record) => {
          const color = !record.ok ? C.error : record.decision === 'deny' ? C.warn : C.ok;
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
    const selectedSection: PanelWorkspaceSection = { title: 'Selected Hook', lines: detailLines };
    const activitySection: PanelWorkspaceSection = { title: 'Recent Activity', lines: activityLines };
    const authoringSection: PanelWorkspaceSection = { title: 'Authoring', lines: authoringLines };
    const resolvedHooksSection = resolvePrimaryScrollableSection(width, height, {
      intro,
      footerLines: [buildPanelLine(width, [['  Up/Down move  r refresh  /hooks for full contract listing', C.dim]])],
      palette: C,
      section: {
        title: 'Hooks',
        scrollableLines: hooks.map((entry, absolute) => {
          const bg = absolute === this.selectedIndex ? C.selectBg : undefined;
          return buildPanelLine(width, [
            [' ', C.label, bg],
            [truncateDisplay(entry.hook.name ?? '(unnamed)', 20).padEnd(20), C.value, bg],
            [` ${truncateDisplay(entry.pattern, 28).padEnd(28)}`, C.info, bg],
            [` ${(entry.hook.enabled === false ? 'DISABLED' : 'ENABLED').padEnd(8)}`, entry.hook.enabled === false ? C.warn : C.ok, bg],
            [` ${entry.hook.type}`, C.dim, bg],
          ]);
        }),
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        guardRows: 1,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: [selectedSection, activitySection, authoringSection],
    });
    this.scrollOffset = resolvedHooksSection.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      resolvedHooksSection.section,
      selectedSection,
      activitySection,
      authoringSection,
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Hooks Control Room',
      intro,
      sections,
      footerLines: [buildPanelLine(width, [['  Up/Down move  r refresh  /hooks for full contract listing', C.dim]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
