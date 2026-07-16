// ---------------------------------------------------------------------------
// memory-diagnostics-gateway.ts
//
// The daemon-backed verb the /health memory (doctor) surface reads:
// ops.memory.get (GET /api/ops/memory) — the read-only MemoryGovernor snapshot.
// No named facade exists on the in-process OperatorClient, so — exactly like
// the memory-consolidation and voice-provisioning gateways — it goes over the
// generic operator invoke path (operator-rpc.ts's resolveOperatorRpc ->
// sdk.operator.invoke), reaching the SAME daemon the command layer does.
//
// A daemon that predates the memory governor answers an honest 501 (the verb is
// cataloged but has no handler when no live governor is composed) or a 404 (an
// older daemon without the route) — both mean "this daemon does not serve
// memory diagnostics", NOT a fabricated all-zero snapshot (see
// classifyMemoryDiagnosticsError). The interface is injectable so the command
// and its tests round-trip against a mocked daemon.
// ---------------------------------------------------------------------------

import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk';
import { resolveOperatorRpc, describeOperatorRpcError } from '../input/commands/operator-rpc.ts';
import { memoryStatusLines, type MemoryGovernorSnapshotResult } from './memory-status.ts';

/** The narrow async verb surface the /health memory (doctor) surface drives. */
export interface MemoryDiagnosticsGateway {
  /** Read the MemoryGovernor snapshot (ops.memory.get). */
  fetchSnapshot(): Promise<MemoryGovernorSnapshotResult>;
}

/**
 * Why the gateway could not be built (daemon disabled / no control-plane URL),
 * surfaced verbatim so the surface prints an honest "unavailable" line rather
 * than guessing — mirrors the memory-consolidation / voice gateways.
 */
export type MemoryDiagnosticsGatewayResolution =
  | { readonly available: true; readonly gateway: MemoryDiagnosticsGateway }
  | { readonly available: false; readonly reason: string };

export interface MemoryDiagnosticsGatewayDeps {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
}

/**
 * Build the live memory-diagnostics gateway over the generic operator invoke
 * path — the same daemon resolution the command layer uses. Returns an honest
 * unavailable reason when no daemon is reachable.
 */
export function createMemoryDiagnosticsGateway(deps: MemoryDiagnosticsGatewayDeps): MemoryDiagnosticsGatewayResolution {
  const rpc = resolveOperatorRpc({ configManager: deps.configManager, homeDirectory: deps.homeDirectory });
  if (!rpc.available) return { available: false, reason: rpc.reason };
  const { sdk } = rpc;
  return {
    available: true,
    gateway: { fetchSnapshot: () => sdk.operator.invoke('ops.memory.get', {}) },
  };
}

/** How an ops.memory.get rejection should render. */
export type MemoryDiagnosticsFailure =
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'error'; readonly message: string };

/** The honest "no memory diagnostics" reason for a daemon that predates the governor verb. */
export const MEMORY_DIAGNOSTICS_UNAVAILABLE = 'this daemon does not serve memory diagnostics.';

/**
 * Classify an ops.memory.get rejection: a 501 (a daemon composed without a live
 * governor — the verb is cataloged but unhandled) or a 404 (an older daemon
 * without the route) are both "verb unavailable"; anything else (network,
 * 401/403, 500) is a generic error.
 */
export function classifyMemoryDiagnosticsError(error: unknown): MemoryDiagnosticsFailure {
  if (error instanceof GoodVibesSdkError && (error.status === 501 || error.status === 404)) {
    return { kind: 'unavailable', reason: MEMORY_DIAGNOSTICS_UNAVAILABLE };
  }
  return { kind: 'error', message: describeOperatorRpcError(error) };
}

/**
 * Render the /health memory (doctor) block from an already-resolved gateway
 * resolution — the testable core the command wraps. Kept separate from the live
 * gateway construction so a wire test injects a fake resolution (available /
 * unavailable / failing) with no HTTP.
 */
export async function renderMemoryDiagnostics(resolution: MemoryDiagnosticsGatewayResolution): Promise<string> {
  if (!resolution.available) {
    return `Health Review: Memory\n  memory diagnostics unavailable: ${resolution.reason}`;
  }
  try {
    const snapshot = await resolution.gateway.fetchSnapshot();
    return ['Health Review: Memory', ...memoryStatusLines(snapshot)].join('\n');
  } catch (error) {
    const failure = classifyMemoryDiagnosticsError(error);
    return failure.kind === 'unavailable'
      ? `Health Review: Memory\n  ${failure.reason}`
      : `Health Review: Memory\n  could not read memory diagnostics: ${failure.message}`;
  }
}
