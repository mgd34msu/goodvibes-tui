/**
 * RouteEvent — discriminated union covering external route binding lifecycle events.
 */

export const ROUTE_SURFACE_KINDS = [
  'tui',
  'web',
  'slack',
  'discord',
  'ntfy',
  'webhook',
  'telegram',
  'google-chat',
  'signal',
  'whatsapp',
  'imessage',
  'msteams',
  'bluebubbles',
  'mattermost',
  'matrix',
  'service',
] as const;
export const ROUTE_TARGET_KINDS = ['session', 'run', 'job', 'task', 'message'] as const;

export type RouteSurfaceKind = (typeof ROUTE_SURFACE_KINDS)[number];

export type RouteTargetKind = (typeof ROUTE_TARGET_KINDS)[number];

export type RouteEvent =
  | {
      type: 'ROUTE_BINDING_CREATED';
      bindingId: string;
      surfaceKind: RouteSurfaceKind;
      externalId: string;
      targetKind: RouteTargetKind;
      targetId: string;
    }
  | {
      type: 'ROUTE_BINDING_UPDATED';
      bindingId: string;
      changedFields: string[];
    }
  | {
      type: 'ROUTE_BINDING_RESOLVED';
      bindingId: string;
      surfaceKind: RouteSurfaceKind;
      externalId: string;
      targetKind: RouteTargetKind;
      targetId: string;
    }
  | {
      type: 'ROUTE_REPLY_TARGET_CAPTURED';
      bindingId: string;
      surfaceKind: RouteSurfaceKind;
      externalId: string;
      replyTargetId: string;
      threadId: string;
    }
  | {
      type: 'ROUTE_BINDING_FAILED';
      surfaceKind: RouteSurfaceKind;
      externalId: string;
      error: string;
    };

export type RouteEventType = RouteEvent['type'];
