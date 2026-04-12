import { validateEventFields } from './shared.ts';
import type { ContractResult } from './shared.ts';

export function validateAgentSpawning(v: unknown): ContractResult {
  return validateEventFields('AGENT_SPAWNING', v, [
    { key: 'agentId', kind: 'string' },
    { key: 'role', kind: 'string' },
    { key: 'task', kind: 'string' },
  ]);
}

export function validateAgentCompleted(v: unknown): ContractResult {
  return validateEventFields('AGENT_COMPLETED', v, [
    { key: 'agentId', kind: 'string' },
    { key: 'durationMs', kind: 'number' },
  ]);
}

export function validateAgentFailed(v: unknown): ContractResult {
  return validateEventFields('AGENT_FAILED', v, [
    { key: 'agentId', kind: 'string' },
    { key: 'error', kind: 'string' },
  ]);
}

export function validateMcpConnected(v: unknown): ContractResult {
  return validateEventFields('MCP_CONNECTED', v, [
    { key: 'serverId', kind: 'string' },
    { key: 'toolCount', kind: 'number' },
    { key: 'resourceCount', kind: 'number' },
  ]);
}

export function validateMcpDisconnected(v: unknown): ContractResult {
  return validateEventFields('MCP_DISCONNECTED', v, [
    { key: 'serverId', kind: 'string' },
    { key: 'willRetry', kind: 'boolean' },
  ]);
}

export function validateMcpReconnecting(v: unknown): ContractResult {
  return validateEventFields('MCP_RECONNECTING', v, [
    { key: 'serverId', kind: 'string' },
    { key: 'attempt', kind: 'number' },
    { key: 'maxAttempts', kind: 'number' },
  ]);
}
