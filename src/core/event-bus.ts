export interface EventMap {
  // Orchestrator lifecycle
  'turn:start': { prompt: string };
  'turn:llm-response': { content: string; toolCalls: unknown[] };
  'turn:tool-executing': { callId: string; tool: string; args: Record<string, unknown> };
  'turn:tool-result': { callId: string; result: unknown };
  'turn:complete': { response: string };
  'turn:error': { error: Error };

  // Subagent events
  'subagent:spawned': { id: string; task: string };
  'subagent:update': { id: string; update: unknown };
  'subagent:complete': { id: string; result: unknown };
  'subagent:error': { id: string; error: Error };

  // Permission flow
  'permission:request': { callId: string; tool: string; args: Record<string, unknown>; category: import('../permissions/manager.ts').PermissionCategory; resolve: (approved: boolean, remember?: boolean) => void };
  // UI events
  'render:request': void;
  'input:submit': { text: string };
  'scroll:delta': { delta: number };

  // Slash command events
  'command:mode-enter': void;
  'command:mode-exit': void;
  'command:autocomplete': { query: string };
  'command:execute': { name: string; args: string[] };
  'command:model-changed': { provider: string; model: string };
}

type Listener<T> = T extends void ? () => void : (data: T) => void;

/**
 * EventBus - Typed publish/subscribe event bus for TUI module communication.
 */
export class EventBus {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  public on<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as (...args: unknown[]) => void);
    // Return unsubscribe function
    return () => this.off(event, listener);
  }

  public off<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): void {
    this.listeners.get(event)?.delete(listener as (...args: unknown[]) => void);
  }

  public emit<K extends keyof EventMap>(
    event: K,
    ...args: EventMap[K] extends void ? [] : [data: EventMap[K]]
  ): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(...(args as unknown[]));
    }
  }

  public once<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): void {
    const unsubscribe = this.on(event, ((...args: unknown[]) => {
      (listener as (...a: unknown[]) => void)(...args);
      unsubscribe();
    }) as Listener<EventMap[K]>);
  }
}
