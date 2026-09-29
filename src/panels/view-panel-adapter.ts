/**
 * view-panel-adapter.ts, the operator API's panels.list / panels.open, answered
 * by the modal views.
 *
 * The SDK's IntegrationHelperService serves panels.list and panels.open from a
 * PanelManagerLike. This terminal has no panes; the adapter lists the views a
 * remote client can open (Agents, Usage, Changes, Notifications, Sessions) and
 * opens one as its modal. Nothing is ever "open in a pane", so both pane lists
 * are empty. The opener is set by the shell once the modal host exists.
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
