/**
 * SurfaceEvent — discriminated union covering configured client surfaces and their health.
 */

import type { RouteSurfaceKind } from './routes.ts';

export { ROUTE_SURFACE_KINDS as SURFACE_KINDS } from './routes.ts';

export type SurfaceKind = RouteSurfaceKind;

export type SurfaceEvent =
  | {
      type: 'SURFACE_ENABLED';
      surfaceKind: SurfaceKind;
      surfaceId: string;
      accountId: string;
    }
  | {
      type: 'SURFACE_DISABLED';
      surfaceKind: SurfaceKind;
      surfaceId: string;
      reason: string;
    }
  | {
      type: 'SURFACE_ACCOUNT_CONNECTED';
      surfaceKind: SurfaceKind;
      surfaceId: string;
      accountId: string;
      displayName: string;
    }
  | {
      type: 'SURFACE_ACCOUNT_DEGRADED';
      surfaceKind: SurfaceKind;
      surfaceId: string;
      accountId: string;
      error: string;
    }
  | {
      type: 'SURFACE_CAPABILITY_CHANGED';
      surfaceKind: SurfaceKind;
      surfaceId: string;
      capability: string;
      enabled: boolean;
    };

export type SurfaceEventType = SurfaceEvent['type'];
