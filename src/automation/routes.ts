/**
 * Route binding types for external conversation and thread context.
 */

import type { AutomationRouteKind, AutomationSurfaceKind } from './types.ts';

export interface AutomationRouteBinding {
  readonly id: string;
  readonly kind: AutomationRouteKind;
  readonly surfaceKind: AutomationSurfaceKind;
  readonly surfaceId: string;
  readonly externalId: string;
  readonly threadId?: string;
  readonly channelId?: string;
  readonly sessionId?: string;
  readonly jobId?: string;
  readonly runId?: string;
  readonly title?: string;
  readonly lastSeenAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly metadata: Record<string, unknown>;
}

export interface AutomationRouteResolution {
  readonly bindingId?: string;
  readonly surfaceKind: AutomationSurfaceKind;
  readonly externalId: string;
  readonly threadId?: string;
  readonly confidence?: number;
  readonly reason?: string;
}
