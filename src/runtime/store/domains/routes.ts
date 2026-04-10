/**
 * Route binding domain state — external conversation, thread, and session mappings.
 */

import type { AutomationRouteBinding } from '../../../automation/routes.ts';

export interface RoutesDomainState {
  readonly revision: number;
  readonly lastUpdatedAt: number;
  readonly source: string;
  readonly bindings: Map<string, AutomationRouteBinding>;
  readonly bindingIds: string[];
  readonly bindingIdsBySurface: Readonly<Record<string, readonly string[]>>;
  readonly activeBindingIds: string[];
  readonly recentBindingIds: string[];
  readonly totalBindings: number;
  readonly totalResolved: number;
  readonly totalFailures: number;
}

export function createInitialRoutesState(): RoutesDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    bindings: new Map(),
    bindingIds: [],
    bindingIdsBySurface: {
      slack: [],
      discord: [],
      web: [],
      ntfy: [],
      webhook: [],
      tui: [],
      service: [],
    },
    activeBindingIds: [],
    recentBindingIds: [],
    totalBindings: 0,
    totalResolved: 0,
    totalFailures: 0,
  };
}
