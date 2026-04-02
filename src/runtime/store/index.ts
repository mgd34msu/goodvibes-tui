/**
 * Runtime store — Zustand vanilla store for goodvibes-tui.
 *
 * Uses `createStore` from `zustand/vanilla` (NOT the React `create` hook)
 * because goodvibes-tui is a terminal app with no React renderer.
 *
 * Per v3 Section 19.2:
 * - No ad hoc direct `set` from arbitrary modules.
 * - All mutations go through typed DomainDispatch APIs.
 * - Transition logic remains pure.
 *
 * The DomainDispatch implementations will be added in later tiers.
 * Event types are defined in src/runtime/events/ (TODO: events agent).
 */

import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand';
import type { RuntimeState } from './state.ts';
import { createInitialRuntimeState } from './state.ts';

// ---------------------------------------------------------------------------
// TODO: Replace these placeholder event types once the events agent creates
// src/runtime/events/
// ---------------------------------------------------------------------------

/** @todo Import from src/runtime/events/turn.ts once created. */
export type TurnEvent = Record<string, unknown>;

/** @todo Import from src/runtime/events/tools.ts once created. */
export type ToolEvent = Record<string, unknown>;

/** @todo Import from src/runtime/events/permissions.ts once created. */
export type PermissionEvent = Record<string, unknown>;

/** @todo Import from src/runtime/events/tasks.ts once created. */
export type TaskEvent = Record<string, unknown>;

/** @todo Import from src/runtime/events/agents.ts once created. */
export type AgentEvent = Record<string, unknown>;

/** @todo Import from src/runtime/events/plugins.ts once created. */
export type PluginEvent = Record<string, unknown>;

/** @todo Import from src/runtime/events/mcp.ts once created. */
export type McpEvent = Record<string, unknown>;

/** @todo Import from src/runtime/events/transport.ts once created. */
export type TransportEvent = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Store type
// ---------------------------------------------------------------------------

/**
 * RuntimeStore — Zustand StoreApi wrapping RuntimeState.
 *
 * Consumers call `store.getState()` to read and `store.subscribe()` to
 * subscribe. Mutations go through DomainDispatch, never direct `.setState()`
 * from feature modules.
 */
export type RuntimeStore = StoreApi<RuntimeState>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates and returns a new RuntimeStore with all domains initialized
 * to their default values.
 *
 * Typically called once at application startup.
 *
 * @example
 * ```ts
 * const store = createRuntimeStore();
 * const state = store.getState();
 * console.log(state.session.status); // 'initializing'
 * ```
 */
export function createRuntimeStore(): RuntimeStore {
  return createStore<RuntimeState>(() => createInitialRuntimeState());
}

// ---------------------------------------------------------------------------
// DomainDispatch interface
// ---------------------------------------------------------------------------

/**
 * DomainDispatch — the typed mutation API for all runtime domains.
 *
 * Per v3 Section 19.2, all state mutations must go through this interface.
 * Implementations will be provided by the domain dispatch layer (Tier 1+).
 *
 * The dispatch functions accept domain-specific events; implementations
 * use pure reducer logic to derive the next state.
 */
export interface DomainDispatch {
  /**
   * Dispatch a turn lifecycle event (TURN_SUBMITTED, PREFLIGHT_OK, etc.).
   * Transitions the conversation domain's turn state machine.
   */
  dispatchTurnEvent(event: TurnEvent): void;

  /**
   * Dispatch a tool execution event (received, validated, permissioned, etc.).
   * Updates the active tool call record in the conversation domain.
   */
  dispatchToolEvent(event: ToolEvent): void;

  /**
   * Dispatch a permission decision machine event.
   * Transitions the permissions domain's decision state machine.
   */
  dispatchPermissionEvent(event: PermissionEvent): void;

  /**
   * Dispatch a task lifecycle event (queued, running, blocked, etc.).
   * Updates the tasks domain's task registry.
   */
  dispatchTaskEvent(event: TaskEvent): void;

  /**
   * Dispatch an agent lifecycle event (spawning, running, completed, etc.).
   * Updates the agents domain's agent registry.
   */
  dispatchAgentEvent(event: AgentEvent): void;

  /**
   * Dispatch a plugin lifecycle event (discovered, loading, active, etc.).
   * Updates the plugins domain's plugin registry.
   */
  dispatchPluginEvent(event: PluginEvent): void;

  /**
   * Dispatch an MCP server lifecycle event (connecting, connected, etc.).
   * Updates the mcp domain's server registry.
   */
  dispatchMcpEvent(event: McpEvent): void;

  /**
   * Dispatch an ACP/daemon transport lifecycle event.
   * Updates the acp and daemon domains' transport state machines.
   */
  dispatchTransportEvent(event: TransportEvent): void;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { RuntimeState } from './state.ts';
export { createInitialRuntimeState } from './state.ts';
export * from './selectors/index.ts';
export * from './domains/index.ts';
