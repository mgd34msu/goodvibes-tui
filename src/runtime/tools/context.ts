import type { HookDispatcher } from '../../hooks/dispatcher.ts';
import type { PermissionManager } from '../../permissions/manager.ts';
import type { FileStateCache } from '../../state/file-cache.ts';
import type { ProjectIndex } from '../../state/project-index.ts';
import type { RuntimeEventBus } from '../events/index.ts';

/**
 * Minimal read/subscribe interface over the Zustand RuntimeStore.
 * Mirrors StoreApi<RuntimeState> without importing RuntimeState directly,
 * keeping this module decoupled from the full store domain tree.
 */
export interface RuntimeStoreAccess {
  /** Returns a snapshot of the current store state. */
  getState(): Record<string, unknown>;
  /** Subscribes to store changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/**
 * TaskHooks — lifecycle callbacks for task/subtask tracking.
 * Populated by higher tiers; all fields optional until wired.
 */
export interface TaskHooks {
  /** Called when the tool begins execution. */
  onStart?: (callId: string, toolName: string) => void;
  /** Called when the tool completes (success or failure). */
  onComplete?: (callId: string, durationMs: number) => void;
  /** Called when the tool fails. */
  onError?: (callId: string, error: string) => void;
}

/**
 * ToolRuntimeContext — full context passed to each phase and to the tool itself.
 *
 * Based on v3 Section 6. Fields required for Tier 1 are non-optional;
 * fields wired in later tiers are optional until those tiers land.
 */
export interface ToolRuntimeContext {
  /** Read/subscribe access to the Zustand runtime store. */
  runtime: RuntimeStoreAccess;

  /** Correlation identifiers for the current execution context. */
  ids: {
    sessionId: string;
    conversationId: string;
    turnId: string;
    toolCallId: string;
    traceId: string;
  };

  /** Task lifecycle callbacks. */
  tasks: TaskHooks;

  /** Shared caches from the runtime context. */
  resources: {
    fileCache: FileStateCache;
    projectIndex: ProjectIndex;
  };

  /** Active provider and model identifiers. */
  provider: {
    providerId: string;
    modelId: string;
    contextWindow: number;
  };

  /** Agent context — present only when executing inside an agent scope. */
  agent?: {
    agentId: string;
    parentAgentId?: string;
    isolationMode: 'full' | 'partial' | 'none';
  };

  /**
   * Execution budget constraints.
   * All fields optional — absent means unlimited.
   */
  budget?: {
    maxMs?: number;
    maxTokens?: number;
    maxCostUsd?: number;
  };

  /**
   * Cancellation signal.
   * Phases check `signal.aborted` at boundaries to support cooperative cancellation.
   */
  cancellation: {
    signal: AbortSignal;
    /** Human-readable reason set when the call is cancelled. */
    reason?: string;
  };

  /** Execution mode — determines prompt and timeout behaviour. */
  executionMode: 'interactive' | 'background' | 'remote';

  /**
   * Optional runtime event bus.
   * Present when enableEvents is true in ExecutorConfig.
   * Optional during migration — consumers must guard before emitting.
   */
  runtimeBus?: RuntimeEventBus;

  /** Full PermissionManager instance (used by permission phase). */
  permissionManager: PermissionManager;

  /** Full HookDispatcher instance (used by pre/post hook phases). */
  hookDispatcher: HookDispatcher;
}
