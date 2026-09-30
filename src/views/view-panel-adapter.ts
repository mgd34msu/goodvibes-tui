/**
 * view-panel-adapter.ts, the operator API's panels.list / panels.open, answered
 * by the modal views.
 *
 * THE ONLY PLACE PANE VOCABULARY IS KEPT IN THE TUI. The terminal has no panes:
 * every view opens as a modal. The names here (ViewPanelAdapter, PanelManagerLike,
 * getTopPane/getBottomPane, NO_PANES, the `panels` field) are kept on purpose
 * because they are the SDK's contract, not TUI design:
 *   - the SDK's IntegrationHelperService serves the operator API verbs
 *     panels.list and panels.open (and the /api/panels/* HTTP routes) from the
 *     `panelManager` option, typed PanelManagerLike;
 *   - remote clients, the web UI and the daemon already speak those verb names.
 * Renaming them is an SDK and wire change, so the TUI keeps one adapter that
 * satisfies the contract and translates it: panels.list lists the views a
 * remote client can open (Agents, Usage, Changes, Notifications, Sessions),
 * panels.open opens one as its modal, and both pane lists are always empty
 * because nothing is ever open in a pane. The opener is set by the shell once
 * the modal host exists. See docs/architecture.md ("The operator API bridge").
 */

import type { IntegrationHelperService } from '@/runtime/index.ts';

/** The SDK's panel-manager contract, as IntegrationHelperService takes it. */
type PanelManagerLike = ConstructorParameters<typeof IntegrationHelperService>[0]['panelManager'];
type PanelPaneLike = ReturnType<PanelManagerLike['getTopPane']>;
type PanelRegistrationLike = ReturnType<PanelManagerLike['getRegisteredTypes']>[number];

const VIEWS: readonly PanelRegistrationLike[] = [
  { id: 'agents', name: 'Agents', category: 'views', description: 'Running and finished agents, chains, workflows and hosted sessions; steer, stop, open a transcript' },
  { id: 'usage', name: 'Usage', category: 'views', description: 'Context pressure, session tokens and cost, per-turn history, per-agent costs, budget alert' },
  { id: 'changes', name: 'Changes', category: 'views', description: 'Changed files with a tinted diff, semantic summary, hunk staging, review comments and recent commits' },
  { id: 'notifications', name: 'Notifications', category: 'views', description: 'Everything the notification feed collected, newest first' },
  { id: 'sessions', name: 'Sessions', category: 'views', description: 'Saved, hosted and cross-surface sessions' },
];

const NO_PANES: PanelPaneLike = { panels: [], activeIndex: 0 };

export interface ViewPanelAdapter extends PanelManagerLike {
  /** Set how a view name is opened (returns false when nothing holds it). */
  setOpener(open: (id: string) => boolean): void;
}

export function createViewPanelAdapter(): ViewPanelAdapter {
  let opener: ((id: string) => boolean) | null = null;
  return {
    getTopPane: () => NO_PANES,
    getBottomPane: () => NO_PANES,
    getRegisteredTypes: () => VIEWS,
    open: (id: string) => opener?.(id) ?? false,
    show: () => {},
    setOpener: (open) => { opener = open; },
  };
}
