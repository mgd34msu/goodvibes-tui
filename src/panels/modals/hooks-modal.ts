import { MODAL_TONES } from './modal-theme.ts';
import { infoRow } from './modal-surface-helpers.ts';
import { listHookPointContracts } from '@pellux/goodvibes-sdk/platform/hooks';
import type {
  HookActivityTracker,
  HookDefinition,
  HookDispatcher,
  HookWorkbench,
} from '@pellux/goodvibes-sdk/platform/hooks';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalTab,
  ConfigModalView,
} from '../../input/config-modal-types.ts';

// ---------------------------------------------------------------------------
// Hooks → config-modal surface (group-B port). Two tabs: 'Hooks' (active
// registrations + contract posture) and 'Activity' (recent runtime activity +
// managed authoring + last simulation, the panel's expand-activity view, now a
// dedicated tab). All sources are in-memory (dispatcher/workbench/tracker hold
// live state), so buildView reads live and refresh() is a no-op. Toggle/remove/
// simulate route to their `/hooks` command path. Selection-blind port: the
// panel's selected-hook contract detail is folded into each hook row label.
// ---------------------------------------------------------------------------

export type HooksModalDispatcher = Pick<HookDispatcher, 'listHooks' | 'getChains'>;
export type HooksModalWorkbench = Pick<HookWorkbench, 'getHooksFilePath' | 'listManagedHooks' | 'listManagedChains' | 'listRecentActions' | 'getLastSimulation'>;
export type HooksModalActivityTracker = Pick<HookActivityTracker, 'listRecent'>;

export interface HooksModalDeps {
  readonly hookDispatcher: HooksModalDispatcher;
  readonly hookWorkbench: HooksModalWorkbench;
  readonly hookActivityTracker: HooksModalActivityTracker;
}

type HookEntry = { pattern: string; hook: HookDefinition };

function rowId(entry: HookEntry, index: number): string {
  return `${entry.pattern}#${entry.hook.name ?? index}`;
}

class HooksModalSurface implements ConfigModalSurface {
  readonly name = 'hooks-modal';
  readonly title = 'Hooks';

  constructor(private readonly deps: HooksModalDeps) {}

  readonly actions = [
    { key: 't', id: 'toggle', label: 'toggle', enabledFor: (_row: ConfigModalRow | null, tabId: string) => tabId === 'hooks' },
    { key: 'x', id: 'remove', label: 'remove', enabledFor: (_row: ConfigModalRow | null, tabId: string) => tabId === 'hooks' },
    { key: 's', id: 'simulate', label: 'simulate', enabledFor: (_row: ConfigModalRow | null, tabId: string) => tabId === 'hooks' },
    { key: 'r', id: 'refresh', label: 'refresh' },
  ];

  private entryFrom(id: string): HookEntry | undefined {
    return this.deps.hookDispatcher.listHooks().find((entry, index) => rowId(entry, index) === id);
  }

  private hooksTab(): ConfigModalTab {
    const hooks = this.deps.hookDispatcher.listHooks();
    const chains = this.deps.hookDispatcher.getChains();
    const contracts = listHookPointContracts();
    const managedHooks = this.deps.hookWorkbench.listManagedHooks();
    const hooksFilePath = this.deps.hookWorkbench.getHooksFilePath();

    if (hooks.length === 0) {
      const rows: ConfigModalRow[] = [
        infoRow('empty:0', 'No hooks are currently registered.'),
        infoRow('empty:1', `contracts ${contracts.length}  chains ${chains.length}  managed ${managedHooks.length}`, { dim: true }),
        infoRow('empty:2', `hooks file: ${hooksFilePath}`, { dim: true }),
        infoRow('empty:title', 'Next steps'),
        infoRow('empty:hooks', '/hooks     — review hook contracts and managed authoring actions', { dim: true }),
        infoRow('empty:settings', '/settings  — review hook/runtime behavior in the settings surface', { dim: true }),
      ];
      return { id: 'hooks', label: 'Hooks', rows, emptyText: '' };
    }

    const recentForStats = this.deps.hookActivityTracker.listRecent(3);
    const denials = recentForStats.filter((r) => r.ok && r.decision === 'deny').length;
    const errors = recentForStats.filter((r) => !r.ok).length;
    const header = [`hooks ${hooks.length}  chains ${chains.length}  contracts ${contracts.length}  denials ${denials}  errors ${errors}`];

    const rows: ConfigModalRow[] = hooks.map((entry, index) => {
      const contract = contracts.find((c) => c.pattern === entry.pattern);
      const contractPart = contract
        ? ` · ${contract.authority}/${contract.executionMode} deny=${contract.canDeny ? 'y' : 'n'} mut=${contract.canMutateInput ? 'y' : 'n'} inj=${contract.canInjectContext ? 'y' : 'n'}`
        : ' · no exact contract';
      return {
        id: rowId(entry, index),
        label: `${(entry.hook.name ?? '(unnamed)').padEnd(20)} ${entry.pattern.padEnd(28)} ${(entry.hook.enabled === false ? 'DISABLED' : 'ENABLED').padEnd(8)} ${entry.hook.type}${contractPart}`,
        ...(contract ? {} : { style: { fg: MODAL_TONES.warn } }),
      };
    });

    return { id: 'hooks', label: 'Hooks', header, rows, hints: ['t toggle', 'x remove', 's simulate'] };
  }

  private activityTab(): ConfigModalTab {
    const rows: ConfigModalRow[] = [];
    const recentActivity = this.deps.hookActivityTracker.listRecent(20);
    if (recentActivity.length === 0) {
      rows.push(infoRow('act:none', 'No hook activity recorded yet.', { dim: true }));
    } else {
      recentActivity.forEach((record, i) => {
        const decisionText = record.ok ? (record.decision ?? 'ok') : 'error';
        const color = !record.ok ? MODAL_TONES.bad : record.decision === 'deny' ? MODAL_TONES.warn : MODAL_TONES.good;
        rows.push(infoRow(`act:${i}`, `${record.hookName.padEnd(18)} ${record.path.padEnd(26)} ${decisionText}`, { fg: color }));
      });
    }

    rows.push(infoRow('auth:title', 'Authoring'));
    const recentAuthoring = this.deps.hookWorkbench.listRecentActions(3);
    if (recentAuthoring.length === 0) {
      rows.push(infoRow('auth:none', 'No managed hook authoring actions recorded yet.', { dim: true }));
    } else {
      recentAuthoring.forEach((action, i) => rows.push(infoRow(`auth:${i}`, `${action.kind.padEnd(14)} ${action.target}`, { dim: true })));
    }

    const lastSimulation = this.deps.hookWorkbench.getLastSimulation();
    if (lastSimulation) {
      rows.push(infoRow('sim:path', `last simulation: ${lastSimulation.eventPath}`));
      rows.push(infoRow('sim:matches', `matches: hooks=${lastSimulation.matchedHooks.length} chains=${lastSimulation.matchedChains.length}`, { dim: true }));
    }
    return { id: 'activity', label: 'Activity', rows, emptyText: 'No hook activity recorded yet.' };
  }

  buildView(): ConfigModalView {
    return { title: 'Hooks', tabs: [this.hooksTab(), this.activityTab()] };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') { ctx.setStatus('Hooks are read live.'); ctx.requestRender(); return; }
    const entry = ctx.row ? this.entryFrom(ctx.row.id) : undefined;
    if (!entry) return;
    const name = entry.hook.name;
    switch (id) {
      case 'toggle':
        if (!name) { ctx.print('This hook has no managed name to toggle.'); return; }
        void ctx.executeCommand?.('hooks', [entry.hook.enabled === false ? 'enable' : 'disable', name]);
        ctx.setStatus(`Dispatched /hooks ${entry.hook.enabled === false ? 'enable' : 'disable'} ${name}.`);
        break;
      case 'remove':
        if (!name) { ctx.print('This hook has no managed name to remove.'); return; }
        void ctx.executeCommand?.('hooks', ['remove', name]);
        ctx.setStatus(`Dispatched /hooks remove ${name}.`);
        break;
      case 'simulate':
        void ctx.executeCommand?.('hooks', ['simulate', entry.pattern]);
        ctx.setStatus(`Dispatched /hooks simulate ${entry.pattern}.`);
        break;
    }
  }
}

export function createHooksModalSurface(deps: HooksModalDeps): ConfigModalSurface {
  return new HooksModalSurface(deps);
}

/**
 * Deterministic golden fixture: fixed dispatcher/workbench/activity-tracker
 * stand-ins with two managed hooks (one enabled, one disabled) and one recorded
 * activity entry. listHookPointContracts() reads the SDK's static contract table
 * (no disk/wall-clock). All timestamps are fixed epoch numbers.
 */
export function hooksModalGoldenSurface(): ConfigModalSurface {
  const hooks: HookEntry[] = [
    { pattern: 'Pre:tool:*', hook: { match: 'Pre:tool:*', type: 'command', command: 'echo pre', name: 'pre-tool-guard', enabled: true } },
    { pattern: 'Post:file:write', hook: { match: 'Post:file:write', type: 'command', command: 'echo post', name: 'post-write-log', enabled: false } },
  ];
  const dispatcher: HooksModalDispatcher = { listHooks: () => hooks, getChains: () => [] };
  const workbench: HooksModalWorkbench = {
    getHooksFilePath: () => '/golden/hooks.json',
    listManagedHooks: () => hooks,
    listManagedChains: () => [],
    listRecentActions: () => [{ kind: 'toggle', target: 'pre-tool-guard', timestamp: 0 }],
    getLastSimulation: () => null,
  };
  const activityTracker: HooksModalActivityTracker = {
    listRecent: () => [{
      timestamp: 0, path: 'Pre:tool:*', specific: '*', pattern: 'Pre:tool:*',
      hookName: 'pre-tool-guard', hookType: 'command', ok: true, decision: 'allow', durationMs: 1, async: false,
    }],
  };
  return createHooksModalSurface({ hookDispatcher: dispatcher, hookWorkbench: workbench, hookActivityTracker: activityTracker });
}
