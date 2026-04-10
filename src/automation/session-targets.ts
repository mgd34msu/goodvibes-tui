/**
 * Execution-target types for automation jobs and runs.
 */

import type { AutomationExecutionKind, AutomationSurfaceKind } from './types.ts';

export type AutomationSessionTargetKind =
  | AutomationExecutionKind
  | 'session'
  | 'route';

export interface AutomationSessionTarget {
  readonly kind: AutomationSessionTargetKind;
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly threadId?: string;
  readonly channelId?: string;
  readonly surfaceKind?: AutomationSurfaceKind;
  readonly pinnedSessionId?: string;
  readonly preserveThread?: boolean;
  readonly createIfMissing?: boolean;
}

export type AutomationSandboxMode = 'inherit' | 'isolate' | 'off';
export type AutomationWakeMode = 'next-heartbeat' | 'now';
export type AutomationExternalContentSourceKind =
  | 'gmail'
  | 'email'
  | 'webhook'
  | 'api'
  | 'browser'
  | 'channel_metadata'
  | 'web_search'
  | 'web_fetch'
  | 'slack'
  | 'discord'
  | 'ntfy'
  | 'unknown';

export type AutomationExternalContentSource =
  | AutomationExternalContentSourceKind
  | {
      readonly kind: AutomationExternalContentSourceKind | string;
      readonly id?: string;
      readonly url?: string;
      readonly routeId?: string;
      readonly surfaceKind?: AutomationSurfaceKind;
      readonly metadata?: Record<string, unknown>;
    };

export interface AutomationExecutionPolicy {
  readonly prompt?: string;
  readonly template?: string;
  readonly target: AutomationSessionTarget;
  readonly modelProvider?: string;
  readonly modelId?: string;
  readonly fallbackModels?: readonly string[];
  readonly reasoningEffort?: 'instant' | 'low' | 'medium' | 'high';
  readonly thinking?: string;
  readonly wakeMode?: AutomationWakeMode;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly toolAllowlist?: readonly string[];
  readonly autoApprove?: boolean;
  readonly sandboxMode?: AutomationSandboxMode;
  readonly allowUnsafeExternalContent?: boolean;
  readonly externalContentSource?: AutomationExternalContentSource;
  readonly lightContext?: boolean;
}
