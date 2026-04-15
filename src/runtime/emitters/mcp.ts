/**
 * MCP emitters — typed emission wrappers for McpEvent domain.
 */
import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventBus } from '../events/index.ts';
import type { McpServerRole, McpTrustMode, QuarantineReason } from '@pellux/goodvibes-sdk/platform/runtime/mcp/types';
import type { EmitterContext } from './index.ts';

/** Emit MCP_CONFIGURED when an MCP server config is parsed. */
export function emitMcpConfigured(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { serverId: string; transport: string; url?: string; role?: McpServerRole; trustMode?: McpTrustMode; allowedPaths?: string[]; allowedHosts?: string[] }
): void {
  bus.emit('mcp', createEventEnvelope('MCP_CONFIGURED', { type: 'MCP_CONFIGURED', ...data }, ctx));
}

/** Emit MCP_CONNECTING when a connection attempt begins. */
export function emitMcpConnecting(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { serverId: string }
): void {
  bus.emit('mcp', createEventEnvelope('MCP_CONNECTING', { type: 'MCP_CONNECTING', ...data }, ctx));
}

/** Emit MCP_CONNECTED when a connection is established. */
export function emitMcpConnected(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { serverId: string; toolCount: number; resourceCount: number }
): void {
  bus.emit('mcp', createEventEnvelope('MCP_CONNECTED', { type: 'MCP_CONNECTED', ...data }, ctx));
}

/** Emit MCP_DEGRADED when partial tools are unavailable. */
export function emitMcpDegraded(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { serverId: string; reason: string; availableTools: string[] }
): void {
  bus.emit('mcp', createEventEnvelope('MCP_DEGRADED', { type: 'MCP_DEGRADED', ...data }, ctx));
}

/** Emit MCP_AUTH_REQUIRED when auth is needed. */
export function emitMcpAuthRequired(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { serverId: string; authType: string }
): void {
  bus.emit('mcp', createEventEnvelope('MCP_AUTH_REQUIRED', { type: 'MCP_AUTH_REQUIRED', ...data }, ctx));
}

/** Emit MCP_RECONNECTING when retrying a dropped connection. */
export function emitMcpReconnecting(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { serverId: string; attempt: number; maxAttempts: number }
): void {
  bus.emit('mcp', createEventEnvelope('MCP_RECONNECTING', { type: 'MCP_RECONNECTING', ...data }, ctx));
}

/** Emit MCP_DISCONNECTED when a connection is closed. */
export function emitMcpDisconnected(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { serverId: string; reason?: string; willRetry: boolean }
): void {
  bus.emit('mcp', createEventEnvelope('MCP_DISCONNECTED', { type: 'MCP_DISCONNECTED', ...data }, ctx));
}

/** Emit MCP_POLICY_UPDATED when server trust posture changes. */
export function emitMcpPolicyUpdated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { serverId: string; role: McpServerRole; trustMode: McpTrustMode; allowedPaths: string[]; allowedHosts: string[] }
): void {
  bus.emit('mcp', createEventEnvelope('MCP_POLICY_UPDATED', { type: 'MCP_POLICY_UPDATED', ...data }, ctx));
}

export function emitMcpSchemaQuarantined(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { serverId: string; reason: QuarantineReason; detail?: string }
): void {
  bus.emit('mcp', createEventEnvelope('MCP_SCHEMA_QUARANTINED', { type: 'MCP_SCHEMA_QUARANTINED', ...data }, ctx));
}

export function emitMcpSchemaQuarantineApproved(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { serverId: string; operatorId: string }
): void {
  bus.emit('mcp', createEventEnvelope('MCP_SCHEMA_QUARANTINE_APPROVED', { type: 'MCP_SCHEMA_QUARANTINE_APPROVED', ...data }, ctx));
}
