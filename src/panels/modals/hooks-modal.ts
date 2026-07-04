import { MODAL_TONES } from './modal-theme.ts';
import { listHookPointContracts } from '@pellux/goodvibes-sdk/platform/hooks';
import type {
  HookActivityTracker,
  HookDefinition,
  HookDispatcher,
  HookWorkbench,
} from '@pellux/goodvibes-sdk/platform/hooks';
import type { ModalConfig, ModalSection, ModalListItem } from '../../renderer/modal-factory.ts';
import type { BoundModalSurface, ModalAction, ModalViewState } from './modal-surface.ts';

// ---------------------------------------------------------------------------
// Hooks → modal (W6 WO-B). Mirrors src/panels/hooks-panel.ts:
// HooksPanel(hookDispatcher, hookWorkbench, hookActivityTracker). The panel
// wraps those three in a HooksPanelDataSource; this modal talks to them
// directly (per the WO brief) using the same minimal Pick<> shapes the panel
// itself declares for the dispatcher/tracker (hooks-panel.ts:56-59) plus the
// read-only slice of HookWorkbench it calls. `toggleManagedHook` /
// `removeManagedEntry` / `simulate` are DROPPED from the workbench dep shape
// on purpose — those are mutations and route to the `/hooks` command path
// (enable|disable|remove|simulate subcommands, hooks-runtime.ts) instead of
// being called directly from the modal (action-parity charter rule).
// ---------------------------------------------------------------------------

export type HooksModalDispatcher = Pick<HookDispatcher, 'listHooks' | 'getChains'>;

export type HooksModalWorkbench = Pick<
  HookWorkbench,
  'getHooksFilePath' | 'listManagedHooks' | 'listManagedChains' | 'listRecentActions' | 'getLastSimulation'
>;

export type HooksModalActivityTracker = Pick<HookActivityTracker, 'listRecent'>;

export interface HooksModalDeps {
  readonly hookDispatcher: HooksModalDispatcher;
  readonly hookWorkbench: HooksModalWorkbench;
  readonly hookActivityTracker: HooksModalActivityTracker;
}

type HookEntry = { pattern: string; hook: HookDefinition };

function matchesQuery(entry: HookEntry, q: string): boolean {
  if (q === '') return true;
  const needle = q.toLowerCase();
  return (entry.hook.name ?? '').toLowerCase().includes(needle)
    || entry.pattern.toLowerCase().includes(needle)
    || entry.hook.type.toLowerCase().includes(needle);
}

function rowId(entry: HookEntry, index: number): string {
  return `${entry.pattern}#${entry.hook.name ?? index}`;
}

/**
 * Hooks → modal. Contracts, active registrations, managed authoring, recent
 * runtime activity, and simulation matches. All sources here are already
 * in-memory (dispatcher/workbench/tracker hold live state, no disk cache to
 * reload), so buildConfig reads live and refresh() is a no-op — matching
 * plugins-modal.ts's rationale. Toggle/remove/simulate route to their
 * `/hooks` command path; the activity-window expand ('a') and refresh ('r')
 * stay in-modal since they only affect this surface's own render, not
 * managed-hook state.
 */
export function bindHooksModal(deps: HooksModalDeps): BoundModalSurface {
  const { hookDispatcher, hookWorkbench, hookActivityTracker } = deps;
  let activityExpanded = false;

  const visibleHooks = (view: ModalViewState): HookEntry[] =>
    hookDispatcher.listHooks().filter((entry) => matchesQuery(entry, view.query));

  const selectedEntry = (view: ModalViewState): HookEntry | undefined => {
    const visible = visibleHooks(view);
    if (visible.length === 0) return undefined;
    return visible[Math.max(0, Math.min(view.selectedIndex, visible.length - 1))];
  };

  const buildConfig = (view: ModalViewState): ModalConfig => {
    const hooks = hookDispatcher.listHooks();
    const chains = hookDispatcher.getChains();
    const contracts = listHookPointContracts();
    const managedHooks = hookWorkbench.listManagedHooks();
    const managedChains = hookWorkbench.listManagedChains();
    const recentAuthoring = hookWorkbench.listRecentActions(3);
    const lastSimulation = hookWorkbench.getLastSimulation();
    const hooksFilePath = hookWorkbench.getHooksFilePath();

    if (hooks.length === 0) {
      const sections: ModalSection[] = [
        { type: 'text', content: 'No hooks are currently registered.' },
        { type: 'text', content: `contracts ${contracts.length}  chains ${chains.length}  managed ${managedHooks.length}`, style: { dim: true } },
        { type: 'text', content: `hooks file: ${hooksFilePath}`, style: { dim: true } },
        { type: 'separator' },
        { type: 'title', content: 'Next steps' },
        { type: 'text', content: '/hooks     — review hook contracts and managed authoring actions', style: { dim: true } },
        { type: 'text', content: '/settings  — review hook/runtime behavior in the settings surface', style: { dim: true } },
      ];
      return { title: 'Hooks', width: 76, sections, footer: 'no hooks registered · esc close' };
    }

    const sections: ModalSection[] = [];
    const recentActivityForStats = hookActivityTracker.listRecent(3);
    const denials = recentActivityForStats.filter((r) => r.ok && r.decision === 'deny').length;
    const errors = recentActivityForStats.filter((r) => !r.ok).length;
    sections.push({
      type: 'text',
      content: `hooks ${hooks.length}  chains ${chains.length}  contracts ${contracts.length}  denials ${denials}  errors ${errors}`,
      style: { dim: true },
    });
    sections.push({ type: 'separator' });

    const visible = visibleHooks(view);
    const clampedIndex = Math.max(0, Math.min(view.selectedIndex, visible.length - 1));
    const items: ModalListItem[] = visible.map((entry, index) => ({
      label: `${(entry.hook.name ?? '(unnamed)').padEnd(20)} ${entry.pattern.padEnd(28)} ${(entry.hook.enabled === false ? 'DISABLED' : 'ENABLED').padEnd(8)} ${entry.hook.type}`,
      selected: index === clampedIndex,
    }));
    if (items.length === 0) {
      sections.push({ type: 'text', content: `No hooks match “${view.query}”.`, style: { dim: true } });
    } else {
      sections.push({ type: 'list', items });
    }

    const selected = visible[clampedIndex];
    if (selected) {
      sections.push({ type: 'separator' });
      sections.push({
        type: 'text',
        content: `hook ${selected.hook.name ?? '(unnamed)'}  type ${selected.hook.type}  match ${selected.hook.matcher ?? selected.hook.match}`,
      });
      sections.push({ type: 'text', content: `pattern ${selected.pattern}`, style: { dim: true } });

      const contract = contracts.find((c) => c.pattern === selected.pattern);
      if (contract) {
        sections.push({ type: 'text', content: `contract ${contract.authority} / ${contract.executionMode}  policy ${contract.failurePolicy}` });
        sections.push({
          type: 'text',
          content: `capabilities: deny=${contract.canDeny ? 'yes' : 'no'} mutate=${contract.canMutateInput ? 'yes' : 'no'} inject=${contract.canInjectContext ? 'yes' : 'no'}`,
          style: { dim: true },
        });
      } else {
        sections.push({ type: 'text', content: 'No exact contract registered for this pattern.', style: { fg: MODAL_TONES.warn } });
      }
      sections.push({
        type: 'text',
        content: `summary: hooks=${hooks.length} chains=${chains.length} contracts=${contracts.length} managed=${managedHooks.length}/${managedChains.length}`,
        style: { dim: true },
      });
    }

    sections.push({ type: 'separator' });
    sections.push({ type: 'title', content: `Recent Activity${activityExpanded ? ' (expanded)' : ''}` });
    const activityLimit = activityExpanded ? 20 : 3;
    const recentActivity = hookActivityTracker.listRecent(activityLimit);
    if (recentActivity.length === 0) {
      sections.push({ type: 'text', content: 'No hook activity recorded yet.', style: { dim: true } });
    } else {
      for (const record of recentActivity) {
        const decisionText = record.ok ? (record.decision ?? 'ok') : 'error';
        const color = !record.ok ? MODAL_TONES.bad : record.decision === 'deny' ? MODAL_TONES.warn : MODAL_TONES.good;
        sections.push({
          type: 'text',
          content: `${record.hookName.padEnd(18)} ${record.path.padEnd(26)} ${decisionText}`,
          style: { fg: color },
        });
      }
    }

    sections.push({ type: 'title', content: 'Authoring' });
    if (recentAuthoring.length === 0) {
      sections.push({ type: 'text', content: 'No managed hook authoring actions recorded yet.', style: { dim: true } });
    } else {
      for (const action of recentAuthoring) {
        sections.push({ type: 'text', content: `${action.kind.padEnd(14)} ${action.target}`, style: { dim: true } });
      }
    }
    if (lastSimulation) {
      sections.push({ type: 'text', content: `last simulation: ${lastSimulation.eventPath}` });
      sections.push({
        type: 'text',
        content: `matches: hooks=${lastSimulation.matchedHooks.length} chains=${lastSimulation.matchedChains.length}`,
        style: { dim: true },
      });
    }

    return {
      title: 'Hooks',
      width: 76,
      search: view.query,
      sections,
      hints: [
        'up/down move',
        't toggle',
        'x remove',
        's simulate',
        activityExpanded ? 'a collapse activity' : 'a expand activity',
        'r refresh',
        '/ filter',
      ],
    };
  };

  const toggle: ModalAction = (view) => {
    const entry = selectedEntry(view);
    if (!entry) return { kind: 'none' };
    const name = entry.hook.name;
    if (!name) return { kind: 'print', text: 'This hook has no managed name to toggle.' };
    const nextEnabled = entry.hook.enabled === false;
    return { kind: 'runCommand', command: `/hooks ${nextEnabled ? 'enable' : 'disable'} ${name}` };
  };

  const remove: ModalAction = (view) => {
    const entry = selectedEntry(view);
    if (!entry) return { kind: 'none' };
    const name = entry.hook.name;
    if (!name) return { kind: 'print', text: 'This hook has no managed name to remove.' };
    return { kind: 'runCommand', command: `/hooks remove ${name}` };
  };

  const simulate: ModalAction = (view) => {
    const entry = selectedEntry(view);
    if (!entry) return { kind: 'none' };
    return { kind: 'runCommand', command: `/hooks simulate ${entry.pattern}` };
  };

  const toggleActivity: ModalAction = () => {
    activityExpanded = !activityExpanded;
    return { kind: 'none' };
  };

  return {
    name: 'hooks',
    title: 'Hooks',
    refresh: () => {},
    buildConfig,
    rowIds: (view) => visibleHooks(view).map((entry, index) => rowId(entry, index)),
    actions: {
      refresh: () => ({ kind: 'refresh' }),
      toggle,
      remove,
      simulate,
      toggleActivity,
    },
  };
}

/**
 * Deterministic golden fixture: fixed dispatcher/workbench/activity-tracker
 * stand-ins with two managed hooks (one enabled, one disabled) and one
 * recorded activity entry. `listHookPointContracts()` reads the SDK's static
 * contract table (no disk/wall-clock), so it's safe to call for real. All
 * timestamps below are fixed epoch numbers — never rendered directly, but
 * kept literal for determinism regardless.
 */
export function hooksModalGoldenSurface(): BoundModalSurface {
  const hooks: HookEntry[] = [
    { pattern: 'Pre:tool:*', hook: { match: 'Pre:tool:*', type: 'command', command: 'echo pre', name: 'pre-tool-guard', enabled: true } },
    { pattern: 'Post:file:write', hook: { match: 'Post:file:write', type: 'command', command: 'echo post', name: 'post-write-log', enabled: false } },
  ];
  const dispatcher: HooksModalDispatcher = {
    listHooks: () => hooks,
    getChains: () => [],
  };
  const workbench: HooksModalWorkbench = {
    getHooksFilePath: () => '/golden/hooks.json',
    listManagedHooks: () => hooks,
    listManagedChains: () => [],
    listRecentActions: () => [{ kind: 'toggle', target: 'pre-tool-guard', timestamp: 0 }],
    getLastSimulation: () => null,
  };
  const activityTracker: HooksModalActivityTracker = {
    listRecent: () => [{
      timestamp: 0,
      path: 'Pre:tool:*',
      specific: '*',
      pattern: 'Pre:tool:*',
      hookName: 'pre-tool-guard',
      hookType: 'command',
      ok: true,
      decision: 'allow',
      durationMs: 1,
      async: false,
    }],
  };
  const surface = bindHooksModal({ hookDispatcher: dispatcher, hookWorkbench: workbench, hookActivityTracker: activityTracker });
  surface.refresh();
  return surface;
}
