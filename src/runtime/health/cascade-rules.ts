/**
 * Declarative cascade rules table for the goodvibes-tui runtime.
 * Cross-machine error propagation rules.
 *
 * Each entry is pure data — adding a new cascade rule means adding a new object to this array.
 * The CascadeEngine consumes this table; no logic lives here.
 */

import type { CascadeRule } from './types.ts';

/**
 * All cascade rules that govern cross-domain health propagation.
 * Rules are evaluated by the CascadeEngine whenever a domain health changes.
 */
export const CASCADE_RULES: CascadeRule[] = [
  {
    id: 'turn-failed-cancels-tools',
    source: 'turn',
    sourceState: 'failed',
    target: 'toolExecution',
    effect: { type: 'CANCEL_INFLIGHT', scope: 'all-tools' },
    description: 'When the turn lifecycle fails, cancel all in-flight tool executions.',
    recoveryFirst: false,
  },
  {
    id: 'tool-failed-errors-turn',
    source: 'toolExecution',
    sourceState: 'failed',
    target: 'turn',
    effect: { type: 'EMIT_EVENT', eventType: 'TOOL_DISPATCH_ERROR' },
    description: 'When tool execution fails, transition the turn lifecycle to the tool_dispatch error path.',
    recoveryFirst: true,
  },
  {
    id: 'mcp-disconnected-blocks-mcp-tools',
    source: 'mcp',
    sourceState: 'failed',
    target: 'toolExecution',
    effect: { type: 'BLOCK_DISPATCH', scope: 'mcp-tools', queueable: true },
    description: 'When MCP server disconnects, block MCP tool dispatch (queue pending calls).',
    recoveryFirst: true,
  },
  {
    id: 'agent-failed-marks-child-tasks',
    source: 'agents',
    sourceState: 'failed',
    target: 'tasks',
    effect: { type: 'MARK_CHILDREN', status: 'failed', notifyParent: true },
    description: 'When an agent lifecycle fails, mark all owned child tasks as failed and notify the parent.',
    recoveryFirst: false,
  },
  {
    id: 'plugin-error-deregisters-tools',
    source: 'plugins',
    sourceState: 'failed',
    target: 'toolExecution',
    // NOTE: To deregister only the failing plugin's tools (not all plugins),
    // pass sourceContext: { pluginId: '<the-plugin-id>' } when calling evaluate().
    // The CascadeEngine propagates sourceContext into CascadeResult, so callers
    // can read result.sourceContext?.pluginId to scope the DEREGISTER_TOOLS effect.
    effect: { type: 'DEREGISTER_TOOLS' },
    description: 'When a plugin enters error state, deregister its tools and fail any in-flight plugin tool calls.',
    recoveryFirst: false,
  },
  {
    id: 'transport-disconnected-blocks-remote-tasks',
    source: 'transport',
    sourceState: 'failed',
    target: 'tasks',
    effect: { type: 'BLOCK_DISPATCH', scope: 'remote-tasks', queueable: false },
    description: 'When ACP/daemon transport disconnects, mark remote tasks blocked and initiate reconnect.',
    recoveryFirst: true,
  },
  {
    id: 'session-recovery-failed-unrecoverable',
    source: 'session',
    sourceState: 'failed',
    target: 'ALL',
    effect: { type: 'EMIT_EVENT', eventType: 'SESSION_UNRECOVERABLE' },
    description: 'When session recovery fails, emit SESSION_UNRECOVERABLE to all machines.',
    recoveryFirst: false,
  },
  {
    id: 'compaction-failed-blocks-new-turns',
    source: 'compaction',
    sourceState: 'failed',
    target: 'turn',
    effect: { type: 'BLOCK_NEW', scope: 'new-turns' },
    description: 'When compaction fails, block new turns from starting.',
    recoveryFirst: true,
  },
];
