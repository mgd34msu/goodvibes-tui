/**
 * Surface domain state — Slack, Discord, web, ntfy, webhook, and TUI surfaces.
 */

import type { AutomationSurfaceKind } from '../../../automation/types.ts';

export type SurfaceConnectionState = 'disabled' | 'connecting' | 'healthy' | 'degraded' | 'error';

export interface SurfaceRecord {
  readonly id: string;
  readonly kind: AutomationSurfaceKind;
  readonly label: string;
  readonly enabled: boolean;
  readonly state: SurfaceConnectionState;
  readonly configuredAt: number;
  readonly lastSeenAt?: number;
  readonly defaultRouteId?: string;
  readonly accountId?: string;
  readonly capabilities: readonly string[];
  readonly metadata: Record<string, unknown>;
}

export interface SurfaceDomainState {
  readonly revision: number;
  readonly lastUpdatedAt: number;
  readonly source: string;
  readonly surfaces: Map<string, SurfaceRecord>;
  readonly surfaceIds: string[];
  readonly enabledSurfaceIds: string[];
  readonly problemSurfaceIds: string[];
  readonly totalHealthy: number;
  readonly totalDegraded: number;
  readonly totalDisabled: number;
}

export function createInitialSurfaceState(): SurfaceDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    surfaces: new Map(),
    surfaceIds: [],
    enabledSurfaceIds: [],
    problemSurfaceIds: [],
    totalHealthy: 0,
    totalDegraded: 0,
    totalDisabled: 0,
  };
}
