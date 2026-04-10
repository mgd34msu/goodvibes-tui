/**
 * Source registry types for automation inputs and origin tracking.
 */

import type { AutomationSourceKind, AutomationSurfaceKind } from './types.ts';

export interface AutomationSourceRecord {
  readonly id: string;
  readonly kind: AutomationSourceKind;
  readonly label: string;
  readonly surfaceKind?: AutomationSurfaceKind;
  readonly routeId?: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastSeenAt?: number;
  readonly metadata: Record<string, unknown>;
}

export interface AutomationSourceSnapshot {
  readonly sourceId: string;
  readonly routeBindingId?: string;
  readonly watcherId?: string;
  readonly lastEventAt?: number;
  readonly description?: string;
}
