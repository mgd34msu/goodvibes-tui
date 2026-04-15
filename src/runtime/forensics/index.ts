/**
 * Forensics subsystem — public API.
 *
 * Usage:
 * 1. Create a ForensicsRegistry owned by the current runtime/session.
 * 2. Create a ForensicsCollector, passing the RuntimeEventBus and registry.
 * 3. The collector auto-generates reports on terminal failure states.
 * 4. Pass the registry to ForensicsPanel (diagnostic provider) and the
 *    /forensics command handler via CommandContext.forensicsRegistry.
 */
export type {
  FailureReport,
  FailureClass,
  PhaseTimingEntry,
  CausalChainEntry,
  ForensicsJumpLink,
  ForensicsBundle,
  ForensicsReplayEvidence,
  ForensicsEvidenceSummary,
} from '@pellux/goodvibes-sdk/platform/runtime/forensics/types';
export { classifyFailure, summariseFailure } from '@pellux/goodvibes-sdk/platform/runtime/forensics/classifier';
export { ForensicsRegistry, DEFAULT_REGISTRY_LIMIT } from '@pellux/goodvibes-sdk/platform/runtime/forensics/registry';
export { ForensicsCollector } from '@pellux/goodvibes-sdk/platform/runtime/forensics/collector';
