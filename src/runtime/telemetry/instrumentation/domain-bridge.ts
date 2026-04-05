/**
 * DomainBridge — bridges RuntimeEventBus events to OTel span creation.
 *
 * Subscribes to all domain channels on the RuntimeEventBus and routes
 * lifecycle events to the appropriate span helper functions. Maintains
 * an active span map keyed by entity ID so that start events open spans
 * and terminal events close them with outcome context.
 *
 * Design principles:
 * - Span creation is purely observational — bridge failures must not
 *   affect the domain logic that emits events.
 * - All map lookups are safe — missing spans on terminal events are no-ops.
 * - The bridge is opt-in: calling `attach()` wires it; `detach()` unwires.
 */
import type { RuntimeEventBus, RuntimeEventEnvelope } from '../../events/index.ts';
import type { PluginEvent } from '../../events/plugins.ts';
import type { McpEvent } from '../../events/mcp.ts';
import type { TransportEvent } from '../../events/transport.ts';
import type { TaskEvent } from '../../events/tasks.ts';
import type { AgentEvent } from '../../events/agents.ts';
import type { PermissionEvent } from '../../events/permissions.ts';
import type { SessionEvent } from '../../events/session.ts';
import type { CompactionEvent } from '../../events/compaction.ts';
import type { RuntimeTracer } from '../tracer.ts';
import type { Span } from '../types.ts';
import type { CascadeAppliedEvent } from '../../health/types.ts';

/** Shorthand for a typed event envelope. */
type Env<T extends { type: string }> = RuntimeEventEnvelope<T['type'], T>;

// Span helpers — each domain
import { startPluginSpan, recordPluginPhase, endPluginSpan } from '../spans/plugin.ts';
import { startMcpSpan, recordMcpPhase, endMcpSpan } from '../spans/mcp.ts';
import { startTransportSpan, recordTransportPhase, endTransportSpan } from '../spans/transport.ts';
import { startTaskSpan, recordTaskPhase, endTaskSpan } from '../spans/task.ts';
import { startAgentSpan, recordAgentPhase, endAgentSpan } from '../spans/agent.ts';
import { startPermissionSpan, recordPermissionPhase, endPermissionSpan } from '../spans/permission.ts';
import { startSessionSpan, recordSessionPhase, endSessionSpan } from '../spans/session.ts';
import { startCompactionSpan, recordCompactionPhase, endCompactionSpan } from '../spans/compaction.ts';
import { recordHealthCascadeSpan } from '../spans/health.ts';

/** Map keyed by entity ID → active Span instance. */
type SpanMap = Map<string, Span>;

/**
 * DomainBridge wires the RuntimeEventBus to the OTel span system.
 *
 * Usage:
 * ```ts
 * const bridge = new DomainBridge(tracer);
 * const detach = bridge.attach(bus);
 * // later:
 * detach();
 * ```
 */
export class DomainBridge {
  private readonly _tracer: RuntimeTracer;

  /** Active spans per domain, keyed by entity ID. */
  private readonly _pluginSpans: SpanMap = new Map();
  private readonly _mcpSpans: SpanMap = new Map();
  private readonly _transportSpans: SpanMap = new Map();
  private readonly _taskSpans: SpanMap = new Map();
  private readonly _agentSpans: SpanMap = new Map();
  private readonly _permissionSpans: SpanMap = new Map();
  private readonly _sessionSpans: SpanMap = new Map();
  private readonly _compactionSpans: SpanMap = new Map();

  constructor(tracer: RuntimeTracer) {
    this._tracer = tracer;
  }

  /**
   * Attach the bridge to the given event bus.
   *
   * Subscribes to all domain channels. Returns a cleanup function that
   * unsubscribes all listeners when called.
   *
   * @param bus - The RuntimeEventBus to subscribe to.
   * @returns A `detach` function that unsubscribes all domain listeners.
   */
  public attach(bus: RuntimeEventBus): () => void {
    const unsubs: Array<() => void> = [
      this._attachPlugins(bus),
      this._attachMcp(bus),
      this._attachTransport(bus),
      this._attachTasks(bus),
      this._attachAgents(bus),
      this._attachPermissions(bus),
      this._attachSession(bus),
      this._attachCompaction(bus),
    ];

    return () => {
      for (const unsub of unsubs) {
        unsub();
      }
    };
  }

  /**
   * Record a health cascade event as a point-in-time span.
   *
   * Called by the caller when CASCADE_APPLIED events are produced by the
   * CascadeEngine. The caller is responsible for providing the trace ID
   * from their current operational context.
   *
   * @param event - The CASCADE_APPLIED event.
   * @param traceId - Trace ID to use for correlation.
   */
  public recordCascade(event: CascadeAppliedEvent, traceId: string): void {
    this._safe(() => {
      recordHealthCascadeSpan(this._tracer, event, { traceId });
    });
  }

  private _safe(action: () => void): void {
    try {
      action();
    } catch {
      // Bridge failure must not propagate — non-fatal, swallowed intentionally
    }
  }

  private _withSpan(map: SpanMap, key: string, action: (span: Span) => void): void {
    const span = map.get(key);
    if (span) action(span);
  }

  private _closeSpan(map: SpanMap, key: string, action: (span: Span) => void): void {
    const span = map.get(key);
    if (!span) return;
    action(span);
    map.delete(key);
  }

  // ── Plugin domain ─────────────────────────────────────────────────────────

  private _attachPlugins(bus: RuntimeEventBus): () => void {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      bus.on('PLUGIN_DISCOVERED', (env: Env<Extract<PluginEvent, { type: 'PLUGIN_DISCOVERED' }>>) => {
        this._safe(() => {
          const span = startPluginSpan(this._tracer, {
            pluginId: env.payload.pluginId,
            path: env.payload.path,
            version: env.payload.version,
            traceId: env.traceId,
          });
          this._pluginSpans.set(env.payload.pluginId, span);
        });
      })
    );

    unsubs.push(
      bus.on('PLUGIN_LOADING', (env: Env<Extract<PluginEvent, { type: 'PLUGIN_LOADING' }>>) => {
        this._safe(() => {
          this._withSpan(this._pluginSpans, env.payload.pluginId, (span) => recordPluginPhase(span, 'loading'));
        });
      })
    );

    unsubs.push(
      bus.on('PLUGIN_LOADED', (env: Env<Extract<PluginEvent, { type: 'PLUGIN_LOADED' }>>) => {
        this._safe(() => {
          this._withSpan(this._pluginSpans, env.payload.pluginId, (span) => {
            recordPluginPhase(span, 'loaded', {
              'plugin.capability_count': env.payload.capabilities.length,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('PLUGIN_ACTIVE', (env: Env<Extract<PluginEvent, { type: 'PLUGIN_ACTIVE' }>>) => {
        this._safe(() => {
          this._withSpan(this._pluginSpans, env.payload.pluginId, (span) => recordPluginPhase(span, 'active'));
        });
      })
    );

    unsubs.push(
      bus.on('PLUGIN_DEGRADED', (env: Env<Extract<PluginEvent, { type: 'PLUGIN_DEGRADED' }>>) => {
        this._safe(() => {
          this._withSpan(this._pluginSpans, env.payload.pluginId, (span) => {
            recordPluginPhase(span, 'degraded', {
              'plugin.degraded_reason': env.payload.reason,
              'plugin.affected_capability_count': env.payload.affectedCapabilities.length,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('PLUGIN_ERROR', (env: Env<Extract<PluginEvent, { type: 'PLUGIN_ERROR' }>>) => {
        this._safe(() => {
          this._closeSpan(this._pluginSpans, env.payload.pluginId, (span) => {
            endPluginSpan(span, {
              outcome: 'error',
              error: env.payload.error,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('PLUGIN_UNLOADING', (env: Env<Extract<PluginEvent, { type: 'PLUGIN_UNLOADING' }>>) => {
        this._safe(() => {
          this._withSpan(this._pluginSpans, env.payload.pluginId, (span) => recordPluginPhase(span, 'unloading'));
        });
      })
    );

    unsubs.push(
      bus.on('PLUGIN_DISABLED', (env: Env<Extract<PluginEvent, { type: 'PLUGIN_DISABLED' }>>) => {
        this._safe(() => {
          this._closeSpan(this._pluginSpans, env.payload.pluginId, (span) => {
            endPluginSpan(span, {
              outcome: 'disabled',
              reason: env.payload.reason,
            });
          });
        });
      })
    );

    return () => unsubs.forEach((u) => u());
  }

  // ── MCP domain ────────────────────────────────────────────────────────────

  private _attachMcp(bus: RuntimeEventBus): () => void {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      bus.on('MCP_CONFIGURED', (env: Env<Extract<McpEvent, { type: 'MCP_CONFIGURED' }>>) => {
        this._safe(() => {
          const span = startMcpSpan(this._tracer, {
            serverId: env.payload.serverId,
            transport: env.payload.transport,
            url: env.payload.url,
            traceId: env.traceId,
          });
          this._mcpSpans.set(env.payload.serverId, span);
        });
      })
    );

    unsubs.push(
      bus.on('MCP_CONNECTING', (env: Env<Extract<McpEvent, { type: 'MCP_CONNECTING' }>>) => {
        this._safe(() => {
          this._withSpan(this._mcpSpans, env.payload.serverId, (span) => recordMcpPhase(span, 'connecting'));
        });
      })
    );

    unsubs.push(
      bus.on('MCP_CONNECTED', (env: Env<Extract<McpEvent, { type: 'MCP_CONNECTED' }>>) => {
        this._safe(() => {
          this._withSpan(this._mcpSpans, env.payload.serverId, (span) => {
            recordMcpPhase(span, 'connected', {
              'mcp.tool_count': env.payload.toolCount,
              'mcp.resource_count': env.payload.resourceCount,
            });
            // MCP_CONNECTED is an intermediate state — span stays open
            // for subsequent DEGRADED/DISCONNECTED/AUTH_REQUIRED events
          });
        });
      })
    );

    unsubs.push(
      bus.on('MCP_DEGRADED', (env: Env<Extract<McpEvent, { type: 'MCP_DEGRADED' }>>) => {
        this._safe(() => {
          this._withSpan(this._mcpSpans, env.payload.serverId, (span) => {
            recordMcpPhase(span, 'degraded', {
              'mcp.degraded_reason': env.payload.reason,
              'mcp.available_tool_count': env.payload.availableTools.length,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('MCP_AUTH_REQUIRED', (env: Env<Extract<McpEvent, { type: 'MCP_AUTH_REQUIRED' }>>) => {
        this._safe(() => {
          this._closeSpan(this._mcpSpans, env.payload.serverId, (span) => {
            recordMcpPhase(span, 'auth_required', {
              'mcp.auth_type': env.payload.authType,
            });
            endMcpSpan(span, { outcome: 'auth_failed' });
          });
        });
      })
    );

    unsubs.push(
      bus.on('MCP_RECONNECTING', (env: Env<Extract<McpEvent, { type: 'MCP_RECONNECTING' }>>) => {
        this._safe(() => {
          this._withSpan(this._mcpSpans, env.payload.serverId, (span) => {
            recordMcpPhase(span, 'reconnecting', {
              'mcp.reconnect_attempt': env.payload.attempt,
              'mcp.reconnect_max_attempts': env.payload.maxAttempts,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('MCP_DISCONNECTED', (env: Env<Extract<McpEvent, { type: 'MCP_DISCONNECTED' }>>) => {
        this._safe(() => {
          this._closeSpan(this._mcpSpans, env.payload.serverId, (span) => {
            endMcpSpan(span, {
              outcome: 'disconnected',
              reason: env.payload.reason,
              willRetry: env.payload.willRetry,
            });
          });
        });
      })
    );

    return () => unsubs.forEach((u) => u());
  }

  // ── Transport domain ──────────────────────────────────────────────────────

  private _attachTransport(bus: RuntimeEventBus): () => void {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      bus.on('TRANSPORT_INITIALIZING', (env: Env<Extract<TransportEvent, { type: 'TRANSPORT_INITIALIZING' }>>) => {
        this._safe(() => {
          const span = startTransportSpan(this._tracer, {
            transportId: env.payload.transportId,
            protocol: env.payload.protocol,
            traceId: env.traceId,
          });
          this._transportSpans.set(env.payload.transportId, span);
        });
      })
    );

    unsubs.push(
      bus.on('TRANSPORT_AUTHENTICATING', (env: Env<Extract<TransportEvent, { type: 'TRANSPORT_AUTHENTICATING' }>>) => {
        this._safe(() => {
          this._withSpan(this._transportSpans, env.payload.transportId, (span) => recordTransportPhase(span, 'authenticating'));
        });
      })
    );

    unsubs.push(
      bus.on('TRANSPORT_CONNECTED', (env: Env<Extract<TransportEvent, { type: 'TRANSPORT_CONNECTED' }>>) => {
        this._safe(() => {
          this._withSpan(this._transportSpans, env.payload.transportId, (span) => {
            recordTransportPhase(span, 'connected', {
              'transport.endpoint': env.payload.endpoint,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('TRANSPORT_SYNCING', (env: Env<Extract<TransportEvent, { type: 'TRANSPORT_SYNCING' }>>) => {
        this._safe(() => {
          this._withSpan(this._transportSpans, env.payload.transportId, (span) => recordTransportPhase(span, 'syncing'));
        });
      })
    );

    unsubs.push(
      bus.on('TRANSPORT_DEGRADED', (env: Env<Extract<TransportEvent, { type: 'TRANSPORT_DEGRADED' }>>) => {
        this._safe(() => {
          this._withSpan(this._transportSpans, env.payload.transportId, (span) => {
            recordTransportPhase(span, 'degraded', {
              'transport.degraded_reason': env.payload.reason,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('TRANSPORT_RECONNECTING', (env: Env<Extract<TransportEvent, { type: 'TRANSPORT_RECONNECTING' }>>) => {
        this._safe(() => {
          this._withSpan(this._transportSpans, env.payload.transportId, (span) => {
            recordTransportPhase(span, 'reconnecting', {
              'transport.reconnect_attempt': env.payload.attempt,
              'transport.reconnect_max_attempts': env.payload.maxAttempts,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('TRANSPORT_DISCONNECTED', (env: Env<Extract<TransportEvent, { type: 'TRANSPORT_DISCONNECTED' }>>) => {
        this._safe(() => {
          this._closeSpan(this._transportSpans, env.payload.transportId, (span) => {
            endTransportSpan(span, {
              outcome: 'disconnected',
              reason: env.payload.reason,
              willRetry: env.payload.willRetry,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('TRANSPORT_TERMINAL_FAILURE', (env: Env<Extract<TransportEvent, { type: 'TRANSPORT_TERMINAL_FAILURE' }>>) => {
        this._safe(() => {
          this._closeSpan(this._transportSpans, env.payload.transportId, (span) => {
            endTransportSpan(span, {
              outcome: 'terminal_failure',
              reason: env.payload.error,
            });
          });
        });
      })
    );

    return () => unsubs.forEach((u) => u());
  }

  // ── Task domain ───────────────────────────────────────────────────────────

  private _attachTasks(bus: RuntimeEventBus): () => void {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      bus.on('TASK_CREATED', (env: Env<Extract<TaskEvent, { type: 'TASK_CREATED' }>>) => {
        this._safe(() => {
          const span = startTaskSpan(this._tracer, {
            taskId: env.payload.taskId,
            agentId: env.payload.agentId,
            description: env.payload.description,
            priority: env.payload.priority,
            traceId: env.traceId,
          });
          this._taskSpans.set(env.payload.taskId, span);
        });
      })
    );

    unsubs.push(
      bus.on('TASK_STARTED', (env: Env<Extract<TaskEvent, { type: 'TASK_STARTED' }>>) => {
        this._safe(() => {
          this._withSpan(this._taskSpans, env.payload.taskId, (span) => recordTaskPhase(span, 'started'));
        });
      })
    );

    unsubs.push(
      bus.on('TASK_BLOCKED', (env: Env<Extract<TaskEvent, { type: 'TASK_BLOCKED' }>>) => {
        this._safe(() => {
          this._withSpan(this._taskSpans, env.payload.taskId, (span) => {
            recordTaskPhase(span, 'blocked', {
              'task.blocked_reason': env.payload.reason,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('TASK_PROGRESS', (env: Env<Extract<TaskEvent, { type: 'TASK_PROGRESS' }>>) => {
        this._safe(() => {
          this._withSpan(this._taskSpans, env.payload.taskId, (span) => {
            recordTaskPhase(span, 'progress', {
              'task.progress': env.payload.progress,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('TASK_COMPLETED', (env: Env<Extract<TaskEvent, { type: 'TASK_COMPLETED' }>>) => {
        this._safe(() => {
          this._closeSpan(this._taskSpans, env.payload.taskId, (span) => {
            endTaskSpan(span, {
              outcome: 'completed',
              durationMs: env.payload.durationMs,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('TASK_FAILED', (env: Env<Extract<TaskEvent, { type: 'TASK_FAILED' }>>) => {
        this._safe(() => {
          this._closeSpan(this._taskSpans, env.payload.taskId, (span) => {
            endTaskSpan(span, {
              outcome: 'failed',
              durationMs: env.payload.durationMs,
              error: env.payload.error,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('TASK_CANCELLED', (env: Env<Extract<TaskEvent, { type: 'TASK_CANCELLED' }>>) => {
        this._safe(() => {
          this._closeSpan(this._taskSpans, env.payload.taskId, (span) => {
            endTaskSpan(span, {
              outcome: 'cancelled',
              durationMs: 0,
              reason: env.payload.reason,
            });
          });
        });
      })
    );

    return () => unsubs.forEach((u) => u());
  }

  // ── Agent domain ──────────────────────────────────────────────────────────

  private _attachAgents(bus: RuntimeEventBus): () => void {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      bus.on('AGENT_SPAWNING', (env: Env<Extract<AgentEvent, { type: 'AGENT_SPAWNING' }>>) => {
        this._safe(() => {
          const span = startAgentSpan(this._tracer, {
            agentId: env.payload.agentId,
            taskId: env.payload.taskId,
            task: env.payload.task,
            traceId: env.traceId,
          });
          this._agentSpans.set(env.payload.agentId, span);
        });
      })
    );

    unsubs.push(
      bus.on('AGENT_RUNNING', (env: Env<Extract<AgentEvent, { type: 'AGENT_RUNNING' }>>) => {
        this._safe(() => {
          this._withSpan(this._agentSpans, env.payload.agentId, (span) => recordAgentPhase(span, 'running'));
        });
      })
    );

    unsubs.push(
      bus.on('AGENT_AWAITING_MESSAGE', (env: Env<Extract<AgentEvent, { type: 'AGENT_AWAITING_MESSAGE' }>>) => {
        this._safe(() => {
          this._withSpan(this._agentSpans, env.payload.agentId, (span) => recordAgentPhase(span, 'awaiting_message'));
        });
      })
    );

    unsubs.push(
      bus.on('AGENT_AWAITING_TOOL', (env: Env<Extract<AgentEvent, { type: 'AGENT_AWAITING_TOOL' }>>) => {
        this._safe(() => {
          this._withSpan(this._agentSpans, env.payload.agentId, (span) => {
            recordAgentPhase(span, 'awaiting_tool', {
              'agent.tool': env.payload.tool,
              'agent.call_id': env.payload.callId,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('AGENT_FINALIZING', (env: Env<Extract<AgentEvent, { type: 'AGENT_FINALIZING' }>>) => {
        this._safe(() => {
          this._withSpan(this._agentSpans, env.payload.agentId, (span) => recordAgentPhase(span, 'finalizing'));
        });
      })
    );

    unsubs.push(
      bus.on('AGENT_COMPLETED', (env: Env<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>) => {
        this._safe(() => {
          this._closeSpan(this._agentSpans, env.payload.agentId, (span) => {
            endAgentSpan(span, {
              outcome: 'completed',
              durationMs: env.payload.durationMs,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('AGENT_FAILED', (env: Env<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>) => {
        this._safe(() => {
          this._closeSpan(this._agentSpans, env.payload.agentId, (span) => {
            endAgentSpan(span, {
              outcome: 'failed',
              durationMs: env.payload.durationMs,
              error: env.payload.error,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('AGENT_CANCELLED', (env: Env<Extract<AgentEvent, { type: 'AGENT_CANCELLED' }>>) => {
        this._safe(() => {
          this._closeSpan(this._agentSpans, env.payload.agentId, (span) => {
            endAgentSpan(span, {
              outcome: 'cancelled',
              durationMs: 0,
              reason: env.payload.reason,
            });
          });
        });
      })
    );

    return () => unsubs.forEach((u) => u());
  }

  // ── Permission domain ─────────────────────────────────────────────────────

  private _attachPermissions(bus: RuntimeEventBus): () => void {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      bus.on('PERMISSION_REQUESTED', (env: Env<Extract<PermissionEvent, { type: 'PERMISSION_REQUESTED' }>>) => {
        this._safe(() => {
          const span = startPermissionSpan(this._tracer, {
            callId: env.payload.callId,
            tool: env.payload.tool,
            category: env.payload.category,
            traceId: env.traceId,
          });
          this._permissionSpans.set(env.payload.callId, span);
        });
      })
    );

    unsubs.push(
      bus.on('RULES_COLLECTED', (env: Env<Extract<PermissionEvent, { type: 'RULES_COLLECTED' }>>) => {
        this._safe(() => {
          this._withSpan(this._permissionSpans, env.payload.callId, (span) => {
            recordPermissionPhase(span, 'rules_collected', {
              'permission.rule_count': env.payload.ruleCount,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('INPUT_NORMALIZED', (env: Env<Extract<PermissionEvent, { type: 'INPUT_NORMALIZED' }>>) => {
        this._safe(() => {
          this._withSpan(this._permissionSpans, env.payload.callId, (span) => recordPermissionPhase(span, 'input_normalized'));
        });
      })
    );

    unsubs.push(
      bus.on('POLICY_EVALUATED', (env: Env<Extract<PermissionEvent, { type: 'POLICY_EVALUATED' }>>) => {
        this._safe(() => {
          this._withSpan(this._permissionSpans, env.payload.callId, (span) => {
            recordPermissionPhase(span, 'policy_evaluated', {
              'permission.policy_result': env.payload.result,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('MODE_EVALUATED', (env: Env<Extract<PermissionEvent, { type: 'MODE_EVALUATED' }>>) => {
        this._safe(() => {
          this._withSpan(this._permissionSpans, env.payload.callId, (span) => {
            recordPermissionPhase(span, 'mode_evaluated', {
              'permission.mode': env.payload.mode,
              'permission.mode_result': env.payload.result,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('SESSION_OVERRIDE_EVALUATED', (env: Env<Extract<PermissionEvent, { type: 'SESSION_OVERRIDE_EVALUATED' }>>) => {
        this._safe(() => {
          this._withSpan(this._permissionSpans, env.payload.callId, (span) => {
            recordPermissionPhase(span, 'session_override_evaluated', {
              'permission.override_applied': env.payload.overrideApplied,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('SAFETY_CHECKED', (env: Env<Extract<PermissionEvent, { type: 'SAFETY_CHECKED' }>>) => {
        this._safe(() => {
          this._withSpan(this._permissionSpans, env.payload.callId, (span) => {
            recordPermissionPhase(span, 'safety_checked', {
              'permission.safe': env.payload.safe,
              'permission.warning_count': env.payload.warnings.length,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('DECISION_EMITTED', (env: Env<Extract<PermissionEvent, { type: 'DECISION_EMITTED' }>>) => {
        this._safe(() => {
          this._closeSpan(this._permissionSpans, env.payload.callId, (span) => {
            endPermissionSpan(span, {
              approved: env.payload.approved,
              source: env.payload.source,
            });
          });
        });
      })
    );

    return () => unsubs.forEach((u) => u());
  }

  // ── Session domain ────────────────────────────────────────────────────────

  private _attachSession(bus: RuntimeEventBus): () => void {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      bus.on('SESSION_STARTED', (env: Env<Extract<SessionEvent, { type: 'SESSION_STARTED' }>>) => {
        this._safe(() => {
          const span = startSessionSpan(this._tracer, {
            sessionId: env.payload.sessionId,
            traceId: env.traceId,
            profileId: env.payload.profileId,
            workingDir: env.payload.workingDir,
          });
          this._sessionSpans.set(env.payload.sessionId, span);
        });
      })
    );

    unsubs.push(
      bus.on('SESSION_LOADING', (env: Env<Extract<SessionEvent, { type: 'SESSION_LOADING' }>>) => {
        this._safe(() => {
          // SESSION_LOADING fires when resuming — open a span if not already open
          if (!this._sessionSpans.has(env.payload.sessionId)) {
            const span = startSessionSpan(this._tracer, {
              sessionId: env.payload.sessionId,
              traceId: env.traceId,
              path: env.payload.path,
            });
            this._sessionSpans.set(env.payload.sessionId, span);
          } else {
            this._withSpan(this._sessionSpans, env.payload.sessionId, (span) => recordSessionPhase(span, 'loading'));
          }
        });
      })
    );

    unsubs.push(
      bus.on('SESSION_RESUMED', (env: Env<Extract<SessionEvent, { type: 'SESSION_RESUMED' }>>) => {
        this._safe(() => {
          this._withSpan(this._sessionSpans, env.payload.sessionId, (span) => {
            recordSessionPhase(span, 'resumed', {
              'session.turn_count': env.payload.turnCount,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('SESSION_REPAIRING', (env: Env<Extract<SessionEvent, { type: 'SESSION_REPAIRING' }>>) => {
        this._safe(() => {
          this._withSpan(this._sessionSpans, env.payload.sessionId, (span) => {
            recordSessionPhase(span, 'repairing', {
              'session.repair_reason': env.payload.reason,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('SESSION_RECONCILING', (env: Env<Extract<SessionEvent, { type: 'SESSION_RECONCILING' }>>) => {
        this._safe(() => {
          this._withSpan(this._sessionSpans, env.payload.sessionId, (span) => {
            recordSessionPhase(span, 'reconciling', {
              'session.message_count': env.payload.messageCount,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('SESSION_READY', (env: Env<Extract<SessionEvent, { type: 'SESSION_READY' }>>) => {
        this._safe(() => {
          this._closeSpan(this._sessionSpans, env.payload.sessionId, (span) => {
            endSessionSpan(span, { outcome: 'ready' });
          });
        });
      })
    );

    unsubs.push(
      bus.on('SESSION_RECOVERY_FAILED', (env: Env<Extract<SessionEvent, { type: 'SESSION_RECOVERY_FAILED' }>>) => {
        this._safe(() => {
          this._closeSpan(this._sessionSpans, env.payload.sessionId, (span) => {
            endSessionSpan(span, {
              outcome: 'recovery_failed',
              error: env.payload.error,
            });
          });
        });
      })
    );

    return () => unsubs.forEach((u) => u());
  }

  // ── Compaction domain ─────────────────────────────────────────────────────

  private _attachCompaction(bus: RuntimeEventBus): () => void {
    const unsubs: Array<() => void> = [];

    // COMPACTION_CHECK is a poll event — open a span keyed by sessionId
    unsubs.push(
      bus.on('COMPACTION_CHECK', (env: Env<Extract<CompactionEvent, { type: 'COMPACTION_CHECK' }>>) => {
        this._safe(() => {
          // Only open a new span if there's not already a compaction running for this session
          if (!this._compactionSpans.has(env.payload.sessionId)) {
            const span = startCompactionSpan(this._tracer, {
              sessionId: env.payload.sessionId,
              strategy: 'check',
              tokenCount: env.payload.tokenCount,
              threshold: env.payload.threshold,
              traceId: env.traceId,
            });
            this._compactionSpans.set(env.payload.sessionId, span);
          }
        });
      })
    );

    unsubs.push(
      bus.on('COMPACTION_AUTOCOMPACT', (env: Env<Extract<CompactionEvent, { type: 'COMPACTION_AUTOCOMPACT' }>>) => {
        this._safe(() => {
          // Upgrade or open a new span with the resolved strategy
          const existing = this._compactionSpans.get(env.payload.sessionId);
          if (!existing) {
            const span = startCompactionSpan(this._tracer, {
              sessionId: env.payload.sessionId,
              strategy: env.payload.strategy,
              tokenCount: env.payload.tokensBefore,
              traceId: env.traceId,
            });
            this._compactionSpans.set(env.payload.sessionId, span);
          }
        });
      })
    );

    unsubs.push(
      bus.on('COMPACTION_REACTIVE', (env: Env<Extract<CompactionEvent, { type: 'COMPACTION_REACTIVE' }>>) => {
        this._safe(() => {
          if (!this._compactionSpans.has(env.payload.sessionId)) {
            const span = startCompactionSpan(this._tracer, {
              sessionId: env.payload.sessionId,
              strategy: 'reactive',
              tokenCount: env.payload.tokenCount,
              limit: env.payload.limit,
              traceId: env.traceId,
            });
            this._compactionSpans.set(env.payload.sessionId, span);
          }
        });
      })
    );

    unsubs.push(
      bus.on('COMPACTION_MICROCOMPACT', (env: Env<Extract<CompactionEvent, { type: 'COMPACTION_MICROCOMPACT' }>>) => {
        this._safe(() => {
          this._withSpan(this._compactionSpans, env.payload.sessionId, (span) => {
            recordCompactionPhase(span, 'microcompact', {
              'compaction.turn_count': env.payload.turnCount,
              'compaction.tokens_before': env.payload.tokensBefore,
              'compaction.tokens_after': env.payload.tokensAfter,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('COMPACTION_COLLAPSE', (env: Env<Extract<CompactionEvent, { type: 'COMPACTION_COLLAPSE' }>>) => {
        this._safe(() => {
          this._withSpan(this._compactionSpans, env.payload.sessionId, (span) => {
            recordCompactionPhase(span, 'collapse', {
              'compaction.message_count': env.payload.messageCount,
              'compaction.tokens_before': env.payload.tokensBefore,
              'compaction.tokens_after': env.payload.tokensAfter,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('COMPACTION_BOUNDARY_COMMIT', (env: Env<Extract<CompactionEvent, { type: 'COMPACTION_BOUNDARY_COMMIT' }>>) => {
        this._safe(() => {
          this._withSpan(this._compactionSpans, env.payload.sessionId, (span) => {
            recordCompactionPhase(span, 'boundary_commit', {
              'compaction.checkpoint_id': env.payload.checkpointId,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('COMPACTION_DONE', (env: Env<Extract<CompactionEvent, { type: 'COMPACTION_DONE' }>>) => {
        this._safe(() => {
          this._closeSpan(this._compactionSpans, env.payload.sessionId, (span) => {
            endCompactionSpan(span, {
              outcome: 'done',
              tokensBefore: env.payload.tokensBefore,
              tokensAfter: env.payload.tokensAfter,
              durationMs: env.payload.durationMs,
            });
          });
        });
      })
    );

    unsubs.push(
      bus.on('COMPACTION_FAILED', (env: Env<Extract<CompactionEvent, { type: 'COMPACTION_FAILED' }>>) => {
        this._safe(() => {
          this._closeSpan(this._compactionSpans, env.payload.sessionId, (span) => {
            endCompactionSpan(span, {
              outcome: 'failed',
              // COMPACTION_FAILED does not carry tokensBefore in its event payload;
              // defaulting to 0 is a known limitation.
              tokensBefore: 0,
              error: env.payload.error,
            });
          });
        });
      })
    );

    return () => unsubs.forEach((u) => u());
  }
}
