import { logger } from '../utils/logger.ts';

export interface EventMap {
  // Orchestrator lifecycle
  'turn:start': { prompt: string };
  'turn:llm-response': { content: string; toolCalls: unknown[] };
  'turn:tool-executing': { callId: string; tool: string; args: Record<string, unknown> };
  'turn:tool-result': { callId: string; result: unknown };
  'turn:complete': { response: string };
  'turn:error': { error: Error };

  // Streaming events
  'turn:stream-start': void;
  'turn:stream-delta': { content: string; accumulated: string; reasoning?: string; toolCalls?: import('../providers/interface.ts').PartialToolCall[] };
  'turn:stream-end': void;

  // Subagent events
  'subagent:spawned': { id: string; task: string };
  'subagent:update': { id: string; update: import('../acp/protocol.ts').SessionNotification };
  'subagent:complete': { id: string; result: import('../acp/protocol.ts').SubagentResult };
  'subagent:error': { id: string; error: Error };
  'subagent:stream-delta': { id: string; content: string; accumulated: string };
  'subagent:progress': { id: string; progress: string };

  // WRFC chain events
  'wrfc:chain-created': { chainId: string; task: string };
  'wrfc:state-changed': { chainId: string; from: import('../agents/wrfc-types.ts').WrfcState; to: import('../agents/wrfc-types.ts').WrfcState };
  'wrfc:review-complete': { chainId: string; score: number; passed: boolean };
  'wrfc:fix-attempt': { chainId: string; attempt: number; maxAttempts: number };
  // gate corresponds to QualityGate['name'] (string) from wrfc-types.ts
  'wrfc:gate-result': { chainId: string; gate: string; passed: boolean };
  'wrfc:chain-passed': { chainId: string };
  'wrfc:chain-failed': { chainId: string; reason: string };
  'wrfc:auto-commit': { chainId: string; commitHash?: string };
  'wrfc:cascade-abort': { chainId: string; reason: string };

  // Permission flow
  'permission:request': { callId: string; tool: string; args: Record<string, unknown>; category: import('../permissions/manager.ts').PermissionCategory; resolve: (approved: boolean, remember?: boolean) => void };
  // UI events
  'render:request': void;
  'input:submit': { text: string; content?: import('../providers/interface.ts').ContentPart[] };
  'cancel:generation': void;
  'clear:screen': void;
  'scroll:delta': { delta: number };
  'scroll:to': { line: number };
  'block:toggle-collapse': { blockIndex: number };
  'block:rerun': { blockIndex: number; content: string };

  // Context warnings
  'context:warning': { usage: number; threshold: number };

  // Custom provider events
  'providers:changed': { added: string[]; removed: string[]; updated: string[] };
  'providers:warning': { message: string };

  // Slash command events
  'command:mode-enter': void;
  'command:mode-exit': void;
  'command:autocomplete': { query: string };
  'command:execute': { name: string; args: string[] };
  'command:model-changed': { provider: string; model: string };

  // Model picker events
  'model-picker:select': { model: { id: string; provider: string; displayName: string; registryKey: string } };
  'model-picker:complete': { model: { id: string; provider: string; displayName: string; registryKey: string }; effort: string };

  // Search events
  'search:start': void;
  'search:update': { query: string; matchCount: number; currentMatch: number };
  'search:end': void;

  // Bookmark events
  'bookmark:jump': { key: string };
  'bookmark:removed': { key: string };
  'bookmark:open-file': { key: string; content: string };

  // Help overlay events
  'help:scroll': { delta: number };

  // Execution plan events
  'plan:activate': { planId: string; task: string };

  // Session resume event
  'session:resume': { sessionId: string };

  // Model failover events
  'model:fallback': { from: string; to: string; provider: string };
}

type Listener<T> = T extends void ? () => void : (data: T) => void;

/**
 * EventBus - Typed publish/subscribe event bus for TUI module communication.
 */
/** Maximum listeners per event before a leak warning is emitted. */
const MAX_LISTENERS = 100;

export class EventBus {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  public on<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    const set = this.listeners.get(event)!;
    set.add(listener as (...args: unknown[]) => void);
    if (set.size > MAX_LISTENERS) {
      logger.warn('[EventBus] possible listener leak detected', { event: String(event), count: set.size, max: MAX_LISTENERS });
    }
    // Return unsubscribe function
    return () => this.off(event, listener);
  }

  public off<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): void {
    const set = this.listeners.get(event);
    set?.delete(listener as (...args: unknown[]) => void);
    if (set?.size === 0) this.listeners.delete(event);
  }

  public emit<K extends keyof EventMap>(
    event: K,
    ...args: EventMap[K] extends void ? [] : [data: EventMap[K]]
  ): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(...(args as unknown[]));
      } catch (err) {
        // Isolate listener errors so one failing handler doesn't block others
        logger.error('[EventBus] listener error on event', { event: String(event), error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  public once<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): void {
    const unsubscribe = this.on(event, ((...args: unknown[]) => {
      (listener as (...a: unknown[]) => void)(...args);
      unsubscribe();
    }) as Listener<EventMap[K]>);
  }
}
