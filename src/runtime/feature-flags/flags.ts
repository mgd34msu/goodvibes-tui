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
  // ── Tier 2 ───────────────────────────────────────────────────────────────
  {
    id: 'permissions-policy-engine',
    name: 'Permissions Policy Engine',
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
      'Enables the dual-evaluator simulation pipeline for the permissions policy engine. '
      + 'Tracks divergence between actual and candidate evaluators without '
      + 'changing enforcement behaviour until switched to enforce mode.',
    defaultState: 'disabled',
    tier: 2,
    runtimeToggleable: false,
  },

  // ── Tier 3 ───────────────────────────────────────────────────────────────
  {
    id: 'hitl-ux-modes',
    name: 'HITL UX Modes',
    description:
      'Enables the HITL UX mode system (quiet/balanced/operator) for notification verbosity '
      + 'control. When enabled, ModeManager applies the configured HITL preset to the '
      + 'notification router at startup and on mode change. '
      + 'Disable to keep the router on its baseline delivery policy. '
      + '@remarks This flag is informational for dashboard display only. '
      + 'HITL modes are always applied from config at startup regardless of this flag — '
      + 'it does not gate the runtime behaviour of ModeManager.',
    defaultState: 'disabled',
    tier: 3,
    runtimeToggleable: true,
  },

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
    id: 'plugin-lifecycle',
    name: 'Plugin Lifecycle',
    description:
      'Enables the plugin lifecycle with structured init/teardown phases and health integration.',
    defaultState: 'disabled',
    tier: 4,
    runtimeToggleable: false,
  },
  {
    id: 'mcp-lifecycle',
    name: 'MCP Lifecycle',
    description:
      'Enables the MCP server lifecycle with structured connect/disconnect phases and health integration.',
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

  // ── Tier 7 ───────────────────────────────────────────────────────────────
  {
    id: 'tool-result-reconciliation',
    name: 'Tool Result Reconciliation',
    description:
      'Detects and reconciles unresolved tool calls at turn end. '
      + 'When enabled, dangling tool-call state causes synthetic error results '
      + 'to be injected and a reconciliation event to be emitted, preventing '
      + 'silent conversation corruption. Disable to keep warning-only logging '
      + 'without synthetic result injection.',
    defaultState: 'enabled',
    tier: 7,
    runtimeToggleable: true,
  },

  // ── Tier 7 (continued) ──────────────────────────────────────────────────
  // @remarks policy-signing: this flag is informational for UI/ops status display only —
  // it is NOT a runtime gate. Signing always runs when a signing key is provided via
  // `signingKey` in `PolicyLoaderOptions`; the flag does not suppress or bypass that
  // behaviour. Use this flag to surface signing status in dashboards or operational tooling.
  {
    id: 'policy-signing',
    name: 'Policy Signing',
    description:
      'Enables HMAC-SHA256 signature validation on policy bundle load. '
      + 'When enabled, managed mode rejects bundles with invalid or missing signatures. '
      + 'In non-managed mode, unsigned bundles are permitted with a warning status.',
    defaultState: 'disabled',
    tier: 7,
    runtimeToggleable: false,
  },
  {
    id: 'session-compaction',
    name: 'Session Compaction',
    description:
      'Activates structured session compaction with semantic chunking and relevance scoring.',
    defaultState: 'disabled',
    tier: 6,
    runtimeToggleable: true,
  },

  {
    id: 'fetch-sanitization',
    name: 'Fetch Response Sanitization',
    description:
      'Enables fetch response sanitization and host trust tier classification.'
      + ' Sanitizes HTTP response content (none/safe-text/strict modes) and blocks requests'
      + ' to SSRF-risk hosts (private IPs, metadata endpoints, localhost variants).'
      + ' Defaults to safe-text sanitization mode when enabled.'
      + ' Set sanitize_mode: none in fetch config to override for explicitly trusted hosts.',
    defaultState: 'disabled',
    tier: 8,
    runtimeToggleable: true,
  },

  {
    id: 'runtime-tools-budget-enforcement',
    name: 'Runtime Budget Enforcement',
    description:
      'Enables per-phase runtime budget enforcement for tool execution pipelines. '
      + 'Checks wall-clock time (BUDGET_EXCEEDED_MS), token consumption '
      + '(BUDGET_EXCEEDED_TOKENS), and cost (BUDGET_EXCEEDED_COST) limits at phase '
      + 'entry and exit. Terminates the pipeline immediately on hard budget breach '
      + 'and emits a typed diagnostic event. Disable to revert to unlimited execution.',
    defaultState: 'disabled',
    tier: 8,
    runtimeToggleable: true,
  },

  {
    id: 'overflow-spill-backends',
    name: 'Overflow Spill Backends',
    description:
      'Enables the pluggable spill backend system for overflow content. '
      + 'When enabled, spillBackend can be set to file|ledger|diagnostics via config. '
      + 'When disabled, overflow content uses the file spill backend.',
    defaultState: 'disabled',
    tier: 8,
    runtimeToggleable: true,
  },

  {
    id: 'permission-divergence-dashboard',
    name: 'Divergence Dashboard and Enforce Gate',
    description:
      'Enables the divergence dashboard and enforcement gate for permissions simulation. '
      + 'Aggregates divergence by tool/prefix/mode, exposes trend history in diagnostics, '
      + 'and blocks enforce mode transitions when the divergence rate exceeds the configured '
      + 'threshold. Disable to fall back to warn mode (no gate enforcement).',
    defaultState: 'disabled',
    tier: 8,
    runtimeToggleable: true,
  },

  {
    id: 'shell-ast-normalization',
    name: 'Shell AST Normalization',
    description:
      'Enables the Shell AST parser for compound command verdict evaluation. '
      + 'Produces per-segment verdicts (safe/unsafe) with user-facing denial '
      + 'explanations. When disabled, uses the baseline flat segmentation mode.',
    defaultState: 'disabled',
    tier: 8,
    runtimeToggleable: true,
  },

  {
    id: 'local-provider-context-ingestion',
    name: 'Local Provider Context Window Ingestion',
    description:
      'Enables dynamic ingestion of max_context_length from local/custom provider '
      + '/v1/models endpoints. When enabled, local models use the provider-reported '
      + 'context window (provenance: provider_api) for token budgeting and compaction '
      + 'thresholds instead of the statically-configured contextWindow value. '
      + 'Disable to revert to explicit configured or static limits (configured_cap / fallback).',
    defaultState: 'enabled',
    tier: 9,
    runtimeToggleable: true,
  },

  {
    id: 'agent-context-window-awareness',
    name: 'Agent Context Window Awareness',
    description:
      'Enables context window validation and compaction in the AgentOrchestrator. '
      + 'Before each provider.chat() call, estimates total token count (system prompt + '
      + 'messages + tool definitions) and compacts the conversation when usage exceeds '
      + '85% of the model context window. Also applies layered system prompt assembly '
      + '(drops conventions then project context for small windows) and catches '
      + '"context size exceeded" errors from the provider with a single compaction retry. '
      + 'Disable to revert to unchecked provider.chat() calls.',
    defaultState: 'enabled',
    tier: 9,
    runtimeToggleable: true,
  },

  {
    id: 'output-schema-fingerprint',
    name: 'Output Schema Fingerprints',
    description:
      'Appends `_meta.outputSchemaFingerprint` (SHA-256 of sorted result key names) '
      + 'and `_meta.schemaShapeId` (canonical mode identifier) to tool results from '
      + 'the find, analyze, and inspect tools. Enables schema drift detection and '
      + 'diagnostic fingerprint surfaces. Disable to omit fingerprint metadata.',
    defaultState: 'disabled',
    tier: 8,
    runtimeToggleable: true,
  },
  // ── Policy-as-Code ───────────────────────────────────────────────────────────
  {
    id: 'policy-as-code',
    name: 'Policy-as-Code',
    description:
      'Enables the versioned policy bundle registry with promote/rollback semantics. '
      + 'Requires simulation evidence (divergence gate passing) before enforcement. '
      + 'Exposes /policy load, /policy simulate, /policy diff, /policy promote, '
      + 'and /policy rollback commands. Divergence trends visible by command class/prefix '
      + 'via the diagnostics panel.',
    defaultState: 'disabled',
    tier: 5,
    runtimeToggleable: true,
  },

  // Adaptive Execution Planner.
  {
    id: 'adaptive-execution-planner',
    name: 'Adaptive Execution Planner',
    description:
      'Enables the Adaptive Execution Planner, which scores strategy candidates '
      + '(single/cohort/background/remote) using risk, latency, and capability '
      + 'inputs and selects the best execution strategy each turn. '
      + 'Exposes /plan mode, /plan explain, and /plan override commands. '
      + 'Disable to revert to implicit single-call execution.',
    defaultState: 'disabled',
    tier: 5,
    runtimeToggleable: true,
  },
  // Provider Optimizer.
  {
    id: 'provider-optimizer',
    name: 'Provider Optimizer',
    description:
      'Enables the capability-contract-driven provider routing optimizer. '
      + 'In auto mode, selects the best capable provider for each request profile '
      + 'using ProviderCapabilityRegistry contracts. Supports manual, auto, and pinned '
      + 'routing modes with deterministic, fully-explainable route decisions. '
      + 'Exposes /provider route, /provider explain-route, /provider pin, and '
      + '/provider fallback test commands. '
      + 'Disable to revert to implicit provider selection with zero behavior change.',
    defaultState: 'disabled',
    tier: 5,
    runtimeToggleable: true,
  },

  // ── Integration Delivery SLO ────────────────────────────────────────────
  {
    id: 'integration-delivery-slo',
    name: 'Integration Delivery SLO',
    description:
      'Enables SLO enforcement for integration delivery (Slack, Discord, webhooks). '
      + 'When enabled, dead-letter events are logged at error level and surfaced in '
      + 'integration diagnostics. Failures are classified as retryable or terminal '
      + 'and retried with exponential backoff. Dead-letter entries are exposed via '
      + '/notify dlq and replayable via /notify replay. '
      + 'Disable to keep warn-level logging without DLQ tracking.',
    defaultState: 'disabled',
    tier: 6,
    runtimeToggleable: true,
  },

  // ── Adaptive Notification Suppression ──────────────────────────────────────
  {
    id: 'adaptive-notification-suppression',
    name: 'Adaptive Notification Suppression',
    description:
      'Enables mode-context and burst-detection policies in the NotificationRouter. '
      + 'In quiet/minimal mode, operational churn is suppressed before reaching the '
      + 'conversation or status bar. Burst detection collapses rapid domain:level '
      + 'floods into panel_only with a burst_collapsed reason code. '
      + 'Disable to revert to base default + quiet-typing + batch-window policies only.',
    defaultState: 'disabled',
    tier: 3,
    runtimeToggleable: true,
  },

  // ── Token Scope and Rotation Audit ────────────────────────────────────────
  {
    id: 'token-scope-rotation-audit',
    name: 'Token Scope and Rotation Audit',
    description:
      'Enables minimum scope principle checks and rotation cadence audits for API tokens. '
      + 'In managed mode, tokens with excess scopes or overdue rotation are blocked from use. '
      + 'Diagnostics panel surfaces token age, scope violations, and rotation warnings. '
      + 'Emits TOKEN_SCOPE_VIOLATION, TOKEN_ROTATION_WARNING, TOKEN_ROTATION_EXPIRED, '
      + 'and TOKEN_BLOCKED events via the security event domain. '
      + 'Disable to revert to unenforced advisory reporting only.',
    defaultState: 'disabled',
    tier: 7,
    runtimeToggleable: true,
  },

  // Tool Contract Verification.
  {
    id: 'tool-contract-verification',
    name: 'Tool Contract Verification',
    description:
      'Enables registration-time contract checks for all registered tools. '
      + 'Validates schema validity, timeout/cancellation semantics, permission class '
      + 'mapping, output policy compatibility, and idempotency declarations. '
      + 'Invalid tools fail closed with actionable diagnostics. '
      + 'Exposes /tool verify <name>, /tool verify-all, and /tool contract show <name> commands.',
    defaultState: 'enabled',
    tier: 8,
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
