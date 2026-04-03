/**
 * Forensics subsystem — public API.
 *
 * Usage:
 * 1. Create a ForensicsRegistry (singleton per session).
 * 2. Create a ForensicsCollector, passing the RuntimeEventBus and registry.
 * 3. The collector auto-generates reports on terminal failure states.
 * 4. Pass the registry to ForensicsPanel (diagnostic provider) and the
 *    /forensics command handler via CommandContext.forensicsRegistry.
 */
export type { FailureReport, FailureClass, PhaseTimingEntry, CausalChainEntry, ForensicsJumpLink } from './types.ts';
export { classifyFailure, summariseFailure } from './classifier.ts';
export { ForensicsRegistry, DEFAULT_REGISTRY_LIMIT } from './registry.ts';
export { ForensicsCollector } from './collector.ts';
