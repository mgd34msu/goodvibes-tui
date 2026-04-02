/**
 * DiagnosticsProvider — aggregates all diagnostic panel data providers
 * into a single unified interface.
 *
 * Implements the provider contract from v3 Section 18.3 and Section 26.
 * Wire this up once during runtime initialization and pass it to all
 * panels that need diagnostic data.
 *
 * Usage:
 * ```ts
 * import { createDiagnosticsProvider } from './diagnostics/index.ts';
 *
 * const provider = createDiagnosticsProvider({
 *   eventBus,
 *   healthAggregator,
 *   domains: [...],
 * });
 *
 * const toolCalls = provider.getToolCalls({ limit: 50 });
 * const unsubscribe = provider.subscribe('tool-calls', () => render());
 * ```
 */
import type { RuntimeEventBus } from '../events/index.ts';
import type { RuntimeHealthAggregator } from '../health/aggregator.ts';
import type {
  ToolCallEntry,
  AgentEntry,
  TaskEntry,
  EventEntry,
  RuntimeStateSnapshot,
  HealthDashboardData,
  DiagnosticFilter,
  PanelConfig,
} from './types.ts';
import { ToolCallsPanel } from './panels/tool-calls.ts';
import { AgentsPanel } from './panels/agents.ts';
import { TasksPanel } from './panels/tasks.ts';
import { EventsPanel } from './panels/events.ts';
import { StateInspectorPanel, type InspectableDomain } from './panels/state-inspector.ts';
import { HealthPanel } from './panels/health.ts';

/** Configuration for creating a DiagnosticsProvider. */
export interface DiagnosticsProviderConfig {
  /** The runtime event bus to subscribe to. */
  readonly eventBus: RuntimeEventBus;
  /** The runtime health aggregator to monitor. */
  readonly healthAggregator: RuntimeHealthAggregator;
  /**
   * Domain adapters to expose in the state inspector.
   * Pass one adapter per runtime store domain.
   */
  readonly domains?: readonly InspectableDomain[];
  /** Optional per-panel buffer configuration. */
  readonly panelConfig?: PanelConfig;
}

/** Panel name literals for use with subscribe(). */
export type DiagnosticPanelName =
  | 'tool-calls'
  | 'agents'
  | 'tasks'
  | 'events'
  | 'state-inspector'
  | 'health';

/**
 * DiagnosticsProvider — unified data access layer for all diagnostic panels.
 *
 * Each panel is self-contained and subscribes to its own event sources.
 * The provider exposes a stable interface for retrieving snapshots and
 * registering change listeners.
 */
export class DiagnosticsProvider {
  private readonly _toolCalls: ToolCallsPanel;
  private readonly _agents: AgentsPanel;
  private readonly _tasks: TasksPanel;
  private readonly _events: EventsPanel;
  private readonly _stateInspector: StateInspectorPanel;
  private readonly _health: HealthPanel;

  constructor(config: DiagnosticsProviderConfig) {
    const pc = config.panelConfig;
    this._toolCalls = new ToolCallsPanel(config.eventBus, pc);
    this._agents = new AgentsPanel(config.eventBus, pc);
    this._tasks = new TasksPanel(config.eventBus, pc);
    this._events = new EventsPanel(config.eventBus, pc);
    this._stateInspector = new StateInspectorPanel(
      config.domains ? [...config.domains] : []
    );
    this._health = new HealthPanel(config.healthAggregator);
  }

  // ── Data access ──────────────────────────────────────────────────────────────

  /**
   * Retrieve tool call diagnostic entries.
   *
   * @param filter - Optional filter for domain, time range, trace/session/turn/task IDs, and limit.
   * @returns Filtered tool call entries, most recent first.
   */
  public getToolCalls(filter?: DiagnosticFilter): ToolCallEntry[] {
    return this._toolCalls.getSnapshot(filter);
  }

  /**
   * Retrieve agent diagnostic entries.
   *
   * @param filter - Optional filter.
   * @returns Filtered agent entries, most recent first.
   */
  public getAgents(filter?: DiagnosticFilter): AgentEntry[] {
    return this._agents.getSnapshot(filter);
  }

  /**
   * Retrieve task diagnostic entries.
   *
   * @param filter - Optional filter.
   * @returns Filtered task entries, most recent first.
   */
  public getTasks(filter?: DiagnosticFilter): TaskEntry[] {
    return this._tasks.getSnapshot(filter);
  }

  /**
   * Retrieve event timeline entries.
   *
   * @param filter - Optional filter. The `domains` field filters by domain name.
   * @returns Filtered event entries, most recent first.
   */
  public getEvents(filter?: DiagnosticFilter): EventEntry[] {
    return this._events.getSnapshot(filter);
  }

  /**
   * Capture a point-in-time snapshot of all registered runtime domain states.
   *
   * @returns A RuntimeStateSnapshot with all domain states serialized.
   */
  public getStateSnapshot(): RuntimeStateSnapshot {
    return this._stateInspector.getSnapshot();
  }

  /**
   * Retrieve the current health dashboard data.
   *
   * @returns Aggregated health data sorted by severity.
   */
  public getHealthDashboard(): HealthDashboardData {
    return this._health.getSnapshot();
  }

  /**
   * Register a domain adapter for inclusion in state inspector snapshots.
   *
   * @param domain - Domain adapter implementing InspectableDomain.
   */
  public registerDomain(domain: InspectableDomain): void {
    this._stateInspector.registerDomain(domain);
  }

  // ── Change subscriptions ──────────────────────────────────────────────────────

  /**
   * Subscribe to change notifications for a specific panel.
   *
   * The callback is invoked whenever the panel's data changes. Call the
   * corresponding `get*` method inside the callback to retrieve the latest data.
   *
   * @param panel - The panel to subscribe to.
   * @param callback - Called whenever the panel's data updates.
   * @returns An unsubscribe function; call it to stop receiving notifications.
   */
  public subscribe(panel: DiagnosticPanelName, callback: () => void): () => void {
    switch (panel) {
      case 'tool-calls': return this._toolCalls.subscribe(callback);
      case 'agents': return this._agents.subscribe(callback);
      case 'tasks': return this._tasks.subscribe(callback);
      case 'events': return this._events.subscribe(callback);
      case 'state-inspector': return this._stateInspector.subscribe(callback);
      case 'health': return this._health.subscribe(callback);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  /**
   * Dispose all panel data providers, releasing event bus subscriptions
   * and clearing all internal buffers.
   *
   * Call this when the diagnostics system is shut down.
   */
  public dispose(): void {
    this._toolCalls.dispose();
    this._agents.dispose();
    this._tasks.dispose();
    this._events.dispose();
    this._health.dispose();
    // StateInspectorPanel has no disposable resources (no event bus subscriptions)
  }
}
