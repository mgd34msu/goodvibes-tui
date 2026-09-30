// ---------------------------------------------------------------------------
// memory-consolidation-gateway.ts
//
// The async, daemon-backed verb the Memory modal's Proposals tab reads:
// memory.consolidation.receipts (GET /api/memory/consolidation/receipts), the
// retained memory-consolidation run receipts plus the flattened
// pendingProposals (contradiction / cross-scope-duplicate / stale-delete)
// awaiting human review. The records a proposal references are already
// marked into the review queue by the daemon (reviewState 'contradicted' with
// a staleReason, or 'fresh' for cross-scope duplicates); this gateway is only
// how the Memory modal learns WHAT was proposed and WHY, so it can show that
// reason next to the affected records and offer a jump to them.
//
// No named facade exists on the in-process OperatorClient for this verb, so,
// exactly like the Fleet gateway (fleet-gateway.ts), it goes over the
// generic operator invoke path (operator-rpc.ts's resolveOperatorRpc ->
// sdk.operator.invoke), reaching the SAME daemon the command layer does. A
// runtime without the consolidation scheduler answers an honest 501; an older
// daemon that has not wired this route yet answers 404, both are "verb
// unavailable", not "no proposals" (see classifyConsolidationFetchError).
//
// The interface is injectable so the modal's proposals fetch round-trips
// against a mocked daemon in tests; the live builder
// (createMemoryConsolidationGateway) is wired in builtin-modals.ts, resolved
// lazily (a fresh factory call per fetch) exactly like the Fleet gateway.
// ---------------------------------------------------------------------------

import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { OperatorMethodOutput } from '@pellux/goodvibes-sdk';
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk';
import { resolveOperatorRpc, describeOperatorRpcError } from '../input/commands/operator-rpc.ts';

/** memory.consolidation.receipts output, retained receipts + the flattened pending proposals. */
export type MemoryConsolidationReceiptsResult = OperatorMethodOutput<'memory.consolidation.receipts'>;
/** One pending judgment proposal (contradiction / cross-scope-duplicate / stale-delete) awaiting human review. */
export type MemoryConsolidationProposal = MemoryConsolidationReceiptsResult['pendingProposals'][number];

/** The narrow async verb surface the Memory modal's Proposals tab drives. */
export interface MemoryConsolidationGateway {
  /** Fetch the retained consolidation receipts + flattened pending proposals. */
  fetchReceipts(): Promise<MemoryConsolidationReceiptsResult>;
}

/**
 * Why the gateway could not be built (daemon disabled / no control-plane URL),
 * surfaced verbatim so the modal can print an honest "unavailable" line
 * rather than guessing, mirrors FleetGatewayResolution.
 */
export type MemoryConsolidationGatewayResolution =
  | { readonly available: true; readonly gateway: MemoryConsolidationGateway }
  | { readonly available: false; readonly reason: string };

export interface MemoryConsolidationGatewayDeps {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string;
}

/**
 * Build the live consolidation-receipts gateway over the generic operator
 * invoke path, the same daemon resolution the command layer and the Fleet
 * gateway use. Returns an honest unavailable reason when no daemon is
 * reachable, so the modal can refuse cleanly instead of throwing mid-render.
 */
export function createMemoryConsolidationGateway(deps: MemoryConsolidationGatewayDeps): MemoryConsolidationGatewayResolution {
  const rpc = resolveOperatorRpc({ configManager: deps.configManager, homeDirectory: deps.homeDirectory });
  if (!rpc.available) return { available: false, reason: rpc.reason };
  const { sdk } = rpc;
  return {
    available: true,
    gateway: { fetchReceipts: () => sdk.operator.invoke('memory.consolidation.receipts', {}) },
  };
}

/** How a `fetchReceipts()` rejection should render in the Proposals tab. */
export type MemoryConsolidationFetchFailure =
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Classify a `fetchReceipts()` rejection: a 501 (the documented "no
 * consolidation scheduler on this runtime" response) or a 404 (an older
 * daemon that has not wired this route yet) are both "verb unavailable",
 * distinct from a generic request failure (network error, 401/403, 500),
 * which renders as an honest fetch error instead. Reuses
 * describeOperatorRpcError's wording so the two call sites (command layer,
 * Fleet gateway, this gateway) never diverge on how they describe the same
 * daemon response.
 */
export function classifyConsolidationFetchError(error: unknown): MemoryConsolidationFetchFailure {
  if (error instanceof GoodVibesSdkError && (error.status === 501 || error.status === 404)) {
    return { kind: 'unavailable', reason: describeOperatorRpcError(error) };
  }
  return { kind: 'error', message: describeOperatorRpcError(error) };
}
