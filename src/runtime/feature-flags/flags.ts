/**
 * Registry of all known feature flags for goodvibes-tui.
 *
 * All flags default to `'disabled'`. They are enabled as their corresponding
 * tier is fully implemented and validated.
 *
 * Flag IDs follow the kebab-case naming convention used throughout the runtime.
 */
import type { FeatureFlag } from './types.ts';

/**
 * The canonical list of feature flags across all implementation tiers.
 *
 * Add new flags here; the manager initialises from this array at startup.
 */
export const FEATURE_FLAGS: FeatureFlag[] = [
  // ── Tier 1 ───────────────────────────────────────────────────────────────
  {
    id: 'phased-tool-executor',
    name: 'Phased Tool Executor',
    description:
      'Routes tool calls through the phased execution pipeline instead of the legacy direct-call path.',
    defaultState: 'disabled',
    tier: 1,
    runtimeToggleable: true,
  },

  // ── Tier 2 ───────────────────────────────────────────────────────────────
  {
    id: 'permissions-v2',
    name: 'Permissions v2',
    description:
      'Activates the redesigned permission model with granular tool-level and path-level rules.',
    defaultState: 'disabled',
    tier: 2,
    runtimeToggleable: false,
  },

  {
    id: 'permissions-simulation',
    name: 'Permissions Simulation Mode',
    description:
      'Enables the dual-evaluator simulation pipeline for Permissions v2. '
      + 'Tracks divergence between actual and candidate evaluators without '
      + 'changing enforcement behaviour until switched to enforce mode.',
    defaultState: 'disabled',
    tier: 2,
    runtimeToggleable: false,
  },

  // ── Tier 3 ───────────────────────────────────────────────────────────────
  {
    id: 'unified-runtime-task',
    name: 'Unified RuntimeTask',
    description:
      'Replaces ad-hoc task tracking with the unified RuntimeTask interface across all subsystems.',
    defaultState: 'disabled',
    tier: 3,
    runtimeToggleable: false,
  },

  // ── Tier 4 ───────────────────────────────────────────────────────────────
  {
    id: 'plugin-lifecycle-v2',
    name: 'Plugin Lifecycle v2',
    description:
      'Enables the v2 plugin lifecycle with structured init/teardown phases and health integration.',
    defaultState: 'disabled',
    tier: 4,
    runtimeToggleable: false,
  },
  {
    id: 'mcp-lifecycle-v2',
    name: 'MCP Lifecycle v2',
    description:
      'Enables the v2 MCP server lifecycle with structured connect/disconnect phases and health integration.',
    defaultState: 'disabled',
    tier: 4,
    runtimeToggleable: false,
  },
  {
    id: 'otel-foundation',
    name: 'OTel Foundation',
    description:
      'Enables the OpenTelemetry instrumentation foundation: SDK init, span creation, and in-process export.',
    defaultState: 'disabled',
    tier: 4,
    runtimeToggleable: false,
  },

  // ── Tier 5 ───────────────────────────────────────────────────────────────
  {
    id: 'otel-remote-export',
    name: 'OTel Remote Export',
    description:
      'Enables OTLP/gRPC remote export of spans to a configured collector endpoint. Requires otel-foundation.',
    defaultState: 'disabled',
    tier: 5,
    runtimeToggleable: true,
  },

  // ── Tier 6 ───────────────────────────────────────────────────────────────
  {
    id: 'session-compaction-v2',
    name: 'Session Compaction v2',
    description:
      'Activates the v2 compaction algorithm with semantic chunking and relevance scoring.',
    defaultState: 'disabled',
    tier: 6,
    runtimeToggleable: true,
  },
];

/**
 * Convenience map for O(1) lookups by flag id.
 * Built once at module load time.
 */
export const FEATURE_FLAG_MAP: ReadonlyMap<string, FeatureFlag> = new Map(
  FEATURE_FLAGS.map((f) => [f.id, f]),
);
