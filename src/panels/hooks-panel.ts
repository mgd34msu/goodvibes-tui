import type { Line, Cell } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import { getHookActivityTracker, getHookDispatcher, getHookWorkbench, listHookPointContracts } from '../hooks/index.ts';
import type { HookPointContract } from '../hooks/contracts.ts';
import type { HookActivityRecord } from '../hooks/activity.ts';
import type { HookAuthoringAction, HookSimulationResult } from '../hooks/workbench.ts';
import type { HookChain, HookDefinition } from '../hooks/types.ts';

const C = {
  header: '#94a3b8',
  headerBg: '#1e293b',
  label: '#64748b',
  value: '#e2e8f0',
  dim: '#475569',
  ok: '#22c55e',
  warn: '#eab308',
  error: '#ef4444',
  info: '#38bdf8',
  selectBg: '#0f172a',
  empty: '#334155',
} as const;

function buildLine(width: number, segments: Array<[string, string, string?]>): Line {
  const cells: Cell[] = [];
  let used = 0;
  for (const [text, fg, bg] of segments) {
    cells.push(createStyledCell(text, { fg, bg: bg ?? '' }));
    used += text.length;
  }
  if (used < width) cells.push(createStyledCell(' '.repeat(width - used), { fg: '' }));
  return cells;
}

function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

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

function createDefaultDataSource(): HooksPanelDataSource {
  return {
    listContracts: () => listHookPointContracts(),
    listHooks: () => getHookDispatcher().listHooks(),
    listChains: () => getHookDispatcher().getChains(),
    listRecentActivity: (limit = 3) => getHookActivityTracker().listRecent(limit),
    getWorkbench: () => getHookWorkbench(),
  };
}

export class HooksPanel extends BasePanel {
  private selectedIndex = 0;
  private readonly dataSource: HooksPanelDataSource;

  public constructor(dataSource: HooksPanelDataSource = createDefaultDataSource()) {
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
    const lines: Line[] = [];
    lines.push(buildLine(width, [[' Hooks Control Room', C.header, C.headerBg]]));

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
      lines.push(buildLine(width, [[' No hooks are currently registered. Configure hooks.json or register hooks programmatically.', C.empty]]));
      lines.push(buildLine(width, [
        ['  Contracts: ', C.label],
        [String(contracts.length), C.value],
        ['  Chains: ', C.label],
        [String(chains.length), C.value],
        ['  Managed: ', C.label],
        [String(managedHooks.length), C.info],
      ]));
      lines.push(buildLine(width, [
        ['  Hooks file: ', C.label],
        [truncate(workbench.getHooksFilePath(), Math.max(0, width - 15)), C.dim],
      ]));
      if (recentAuthoring.length > 0) {
        lines.push(buildLine(width, [[' Authoring', C.label]]));
        for (const action of recentAuthoring.slice(0, 2)) {
          lines.push(buildLine(width, [
            ['  ', C.label],
            [truncate(action.kind, 14).padEnd(14), C.info],
            ['  ', C.label],
            [truncate(action.target, Math.max(0, width - 20)), C.dim],
          ]));
        }
      }
      if (lastSimulation) {
        lines.push(buildLine(width, [[' Last Simulation', C.label]]));
        lines.push(buildLine(width, [
          ['  Event: ', C.label],
          [truncate(lastSimulation.eventPath, Math.max(0, width - 10)), C.value],
        ]));
      }
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    this.selectedIndex = Math.min(this.selectedIndex, hooks.length - 1);
    const selected = hooks[this.selectedIndex]!;
    const visible = hooks.slice(0, Math.max(1, height - 12));

    for (let index = 0; index < visible.length; index++) {
      const entry = visible[index]!;
      const bg = index === this.selectedIndex ? C.selectBg : undefined;
      lines.push(buildLine(width, [
        [' ', C.label, bg],
        [truncate((entry.hook.name ?? '(unnamed)').padEnd(20), 20), C.value, bg],
        [` ${truncate(entry.pattern, 28).padEnd(28)}`, C.info, bg],
        [` ${(entry.hook.enabled === false ? 'DISABLED' : 'ENABLED').padEnd(8)}`, entry.hook.enabled === false ? C.warn : C.ok, bg],
        [` ${entry.hook.type}`, C.dim, bg],
      ]));
    }

    const contract = contracts.find((candidate) => candidate.pattern === selected.pattern);
    lines.push(buildLine(width, [[' Details', C.label]]));
    lines.push(buildLine(width, [
      ['  Hook: ', C.label],
      [selected.hook.name ?? '(unnamed)', C.value],
      ['  Type: ', C.label],
      [selected.hook.type, C.info],
      ['  Match: ', C.label],
      [selected.hook.matcher ?? selected.hook.match, C.value],
    ]));
    lines.push(buildLine(width, [
      ['  Pattern: ', C.label],
      [truncate(selected.pattern, Math.max(0, width - 12)), C.value],
    ]));
    if (contract) {
      lines.push(buildLine(width, [
        ['  Contract: ', C.label],
        [`${contract.authority} / ${contract.executionMode}`, C.info],
        ['  Policy: ', C.label],
        [contract.failurePolicy, C.value],
      ]));
      lines.push(buildLine(width, [
        ['  Capabilities: ', C.label],
        [`deny=${contract.canDeny ? 'yes' : 'no'} mutate=${contract.canMutateInput ? 'yes' : 'no'} inject=${contract.canInjectContext ? 'yes' : 'no'}`, C.dim],
      ]));
    } else {
      lines.push(buildLine(width, [['  Contract: No exact contract registered for this pattern.', C.warn]]));
    }
    lines.push(buildLine(width, [
      ['  Summary: ', C.label],
      [`hooks=${hooks.length} chains=${chains.length} contracts=${contracts.length} managed=${managedHooks.length}/${managedChains.length}`, C.dim],
    ]));
    lines.push(buildLine(width, [
      ['  Hooks file: ', C.label],
      [truncate(workbench.getHooksFilePath(), Math.max(0, width - 15)), C.dim],
    ]));
    lines.push(buildLine(width, [[' Recent Activity', C.label]]));
    if (recentActivity.length === 0) {
      lines.push(buildLine(width, [['  No hook activity recorded yet.', C.empty]]));
    } else {
      for (const record of recentActivity) {
        const color = !record.ok ? C.error : record.decision === 'deny' ? C.warn : C.ok;
        lines.push(buildLine(width, [
          ['  ', C.label],
          [truncate(record.hookName, 18).padEnd(18), C.value],
          ['  ', C.label],
          [truncate(record.path, 26).padEnd(26), C.info],
          ['  ', C.label],
          [record.ok ? (record.decision ?? 'ok') : 'error', color],
        ]));
      }
    }
    lines.push(buildLine(width, [[' Authoring', C.label]]));
    if (recentAuthoring.length === 0) {
      lines.push(buildLine(width, [['  No managed hook authoring actions recorded yet.', C.empty]]));
    } else {
      for (const action of recentAuthoring) {
        lines.push(buildLine(width, [
          ['  ', C.label],
          [truncate(action.kind, 14).padEnd(14), C.info],
          ['  ', C.label],
          [truncate(action.target, Math.max(0, width - 20)), C.dim],
        ]));
      }
    }
    if (lastSimulation) {
      lines.push(buildLine(width, [[' Last Simulation', C.label]]));
      lines.push(buildLine(width, [
        ['  Event: ', C.label],
        [truncate(lastSimulation.eventPath, Math.max(0, width - 10)), C.value],
      ]));
      lines.push(buildLine(width, [
        ['  Matches: ', C.label],
        [`hooks=${lastSimulation.matchedHooks.length} chains=${lastSimulation.matchedChains.length}`, C.dim],
      ]));
    }
    lines.push(buildLine(width, [['  Use /hooks for a full contract listing. Press r to refresh.', C.dim]]));

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
