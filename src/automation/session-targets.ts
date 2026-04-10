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

export interface AutomationExecutionPolicy {
  readonly prompt?: string;
  readonly template?: string;
  readonly target: AutomationSessionTarget;
  readonly modelProvider?: string;
  readonly modelId?: string;
  readonly reasoningEffort?: 'instant' | 'low' | 'medium' | 'high';
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly toolAllowlist?: readonly string[];
  readonly autoApprove?: boolean;
  readonly sandboxMode?: AutomationSandboxMode;
}
