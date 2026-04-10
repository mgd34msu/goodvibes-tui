/**
 * DeliveryEvent — discriminated union covering outbound delivery attempts and outcomes.
 */

import type { RouteSurfaceKind } from './routes.ts';

export const DELIVERY_KINDS = ['notification', 'reply', 'action', 'callback'] as const;

export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

export type DeliveryEvent =
  | {
      type: 'DELIVERY_QUEUED';
      deliveryId: string;
      jobId: string;
      runId: string;
      surfaceKind: RouteSurfaceKind;
      targetId: string;
      deliveryKind: DeliveryKind;
    }
  | {
      type: 'DELIVERY_STARTED';
      deliveryId: string;
      jobId: string;
      runId: string;
      surfaceKind: RouteSurfaceKind;
      targetId: string;
      startedAt: number;
    }
  | {
      type: 'DELIVERY_SUCCEEDED';
      deliveryId: string;
      jobId: string;
      runId: string;
      surfaceKind: RouteSurfaceKind;
      targetId: string;
      completedAt: number;
      durationMs: number;
      statusCode: number;
    }
  | {
      type: 'DELIVERY_FAILED';
      deliveryId: string;
      jobId: string;
      runId: string;
      surfaceKind: RouteSurfaceKind;
      targetId: string;
      failedAt: number;
      error: string;
      retryable: boolean;
    }
  | {
      type: 'DELIVERY_DEAD_LETTERED';
      deliveryId: string;
      jobId: string;
      runId: string;
      surfaceKind: RouteSurfaceKind;
      targetId: string;
      reason: string;
      attempts: number;
    };

export type DeliveryEventType = DeliveryEvent['type'];
