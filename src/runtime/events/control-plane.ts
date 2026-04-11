/**
 * ControlPlaneEvent — discriminated union covering gateway/control-plane client lifecycle events.
 */

export const CONTROL_PLANE_CLIENT_KINDS = [
  'tui',
  'web',
  'slack',
  'discord',
  'ntfy',
  'daemon',
  'webhook',
  'service',
  'telegram',
  'google-chat',
  'signal',
  'whatsapp',
  'imessage',
  'msteams',
  'bluebubbles',
  'mattermost',
  'matrix',
] as const;
export const CONTROL_PLANE_TRANSPORT_KINDS = ['local', 'http', 'sse', 'ws', 'websocket', 'webhook'] as const;
export const CONTROL_PLANE_PRINCIPAL_KINDS = ['user', 'bot', 'service', 'token'] as const;

export type ControlPlaneClientKind = (typeof CONTROL_PLANE_CLIENT_KINDS)[number];

export type ControlPlaneTransportKind = (typeof CONTROL_PLANE_TRANSPORT_KINDS)[number];

export type ControlPlanePrincipalKind = (typeof CONTROL_PLANE_PRINCIPAL_KINDS)[number];

export type ControlPlaneEvent =
  | {
      type: 'CONTROL_PLANE_CLIENT_CONNECTED';
      clientId: string;
      clientKind: ControlPlaneClientKind;
      transport: ControlPlaneTransportKind;
    }
  | {
      type: 'CONTROL_PLANE_CLIENT_DISCONNECTED';
      clientId: string;
      reason: string;
    }
  | {
      type: 'CONTROL_PLANE_SUBSCRIPTION_CREATED';
      clientId: string;
      subscriptionId: string;
      topics: string[];
    }
  | {
      type: 'CONTROL_PLANE_SUBSCRIPTION_DROPPED';
      clientId: string;
      subscriptionId: string;
      reason: string;
    }
  | {
      type: 'CONTROL_PLANE_AUTH_GRANTED';
      clientId: string;
      principalId: string;
      principalKind: ControlPlanePrincipalKind;
      scopes: string[];
    }
  | {
      type: 'CONTROL_PLANE_AUTH_REJECTED';
      clientId: string;
      principalId: string;
      reason: string;
    };

export type ControlPlaneEventType = ControlPlaneEvent['type'];
