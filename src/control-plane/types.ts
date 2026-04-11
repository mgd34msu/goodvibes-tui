/**
 * Gateway and control-plane contracts shared by the daemon host and clients.
 */

import type { ArtifactAttachment } from '../artifacts/index.ts';

export type ControlPlaneStreamingMode = 'sse' | 'websocket' | 'both';
export type ControlPlaneClientSurface =
  | 'tui'
  | 'web'
  | 'slack'
  | 'discord'
  | 'ntfy'
  | 'webhook'
  | 'telegram'
  | 'google-chat'
  | 'signal'
  | 'whatsapp'
  | 'imessage'
  | 'msteams'
  | 'bluebubbles'
  | 'mattermost'
  | 'matrix'
  | 'service';

export interface ControlPlaneServerConfig {
  enabled: boolean;
  host: string;
  port: number;
  baseUrl?: string;
  streamingMode: ControlPlaneStreamingMode;
  sessionTtlMs: number;
}

export interface ControlPlaneClientDescriptor {
  id: string;
  surface: ControlPlaneClientSurface;
  label: string;
  connectedAt: number;
  lastSeenAt: number;
  userId?: string;
}

export interface ControlPlaneEventSubscription {
  id: string;
  clientId: string;
  domains: string[];
  createdAt: number;
}

export interface ControlPlaneSurfaceMessage {
  id: string;
  surface: ControlPlaneClientSurface;
  createdAt: number;
  title: string;
  body: string;
  level?: 'info' | 'success' | 'warn' | 'error';
  routeId?: string;
  surfaceId?: string;
  clientId?: string;
  attachments?: readonly ArtifactAttachment[];
  metadata?: Record<string, unknown>;
}
