/**
 * Permissions v2 — Core types for the layered policy evaluator.
 *
 * These types represent the full evaluation model: modes, decisions, reason
 * codes, classification, policy rules, and per-step evaluation trace.
 */

// ── Permission Mode ────────────────────────────────────────────────────────────

/**
 * The active permission mode controlling how the evaluator applies its layers.
 *
 * - `default`              — Standard prompt mode; reads auto-approved.
 * - `plan`                 — Planning mode; write/execute/network blocked.
 * - `allow-all`            — All tools auto-approved (⚠ use with caution).
 * - `custom`               — Per-rule policy applies exclusively.
 * - `background-restricted`— Agent/delegate tools blocked; exec restricted.
 * - `remote-restricted`    — Network tools blocked; local reads/writes allowed.
 */
export type PermissionMode =
  | 'default'
  | 'plan'
  | 'allow-all'
  | 'custom'
  | 'background-restricted'
  | 'remote-restricted';

// ── Command Classification ─────────────────────────────────────────────────────

/**
 * Semantic classification of a tool call, derived from tool name and args.
 *
 * Used by safety checks, mode constraints, and policy rules to reason about
 * what a tool call actually does.
 */
export type CommandClassification =
  | 'read'
  | 'write'
  | 'network'
  | 'destructive'
  | 'escalation';

// ── Decision Reason Codes ──────────────────────────────────────────────────────

/**
 * Canonical reason codes emitted with every PermissionDecision.
 *
 * Prefix conventions:
 *   RULE_   — a policy rule matched (allow or deny)
 *   PROMPT_ — user was prompted and responded
 *   SAFETY_ — bypass-immune safety guardrail fired
 *   MODE_   — active permission mode determined the outcome
 *   DEFAULT_— fallback default policy
 */
export type DecisionReason =
  // Policy layer — user-defined allow rules
  | 'RULE_ALLOW_USER'
  // Policy layer — managed (system/plugin) allow rules
  | 'RULE_ALLOW_MANAGED'
  // Policy layer — managed deny rules
  | 'RULE_DENY_MANAGED'
  // Policy layer — user-defined deny rules
  | 'RULE_DENY_USER'
  // Session override — user approved once
  | 'PROMPT_ALLOW_ONCE'
  // Session override — user approved for entire session
  | 'PROMPT_ALLOW_SESSION'
  // Session override — user denied
  | 'PROMPT_DENY'
  // Session override — cached approval hit
  | 'SESSION_CACHED_ALLOW'
  // Session override — cached denial hit
  | 'SESSION_CACHED_DENY'
  // Safety — destructive prefix pattern matched
  | 'SAFETY_DENY_DESTRUCTIVE_PREFIX'
  // Safety — path escape attempt detected
  | 'SAFETY_DENY_PATH_ESCAPE'
  // Safety — known dangerous command pattern
  | 'SAFETY_DENY_DANGEROUS_PATTERN'
  // Safety — dangerous SQL pattern matched
  | 'SAFETY_DENY_DANGEROUS_SQL'
  // Safety — general guardrail
  | 'SAFETY_DENY_GUARDRAIL'
  // Mode — allow-all mode active
  | 'MODE_ALLOW_ALL'
  // Mode — plan mode blocks write/network/destructive
  | 'MODE_DENY_PLAN'
  // Mode — background-restricted mode blocks agent/delegate
  | 'MODE_DENY_BACKGROUND'
  // Mode — remote-restricted mode blocks network tools
  | 'MODE_DENY_REMOTE_RESTRICTED'
  // Default policy fallback allow
  | 'DEFAULT_ALLOW'
  // Default policy fallback deny
  | 'DEFAULT_DENY';

// ── Evaluation Source Layer ────────────────────────────────────────────────────

/**
 * Which layer in the evaluation stack produced the final decision.
 * Layers are evaluated in priority order; first match wins.
 */
export type SourceLayer =
  | 'safety'  // Layer 1: bypass-immune safety checks
  | 'mode'    // Layer 2: mode constraints
  | 'session' // Layer 3: session overrides / cache
  | 'policy'  // Layer 4: policy rules (prefix, arg-shape, path, network)
  | 'default' // Layer 5: default policy fallback
  ;

// ── Evaluation Trace ──────────────────────────────────────────────────────────

/** A single step recorded during evaluation for audit and debugging. */
export interface EvaluationStep {
  /** Evaluation layer where this step occurred. */
  layer: SourceLayer;
  /** Human-readable description of what was checked. */
  check: string;
  /** Whether this step produced a match (true = this step resolved the decision). */
  matched: boolean;
  /** Optional additional context (rule id, pattern, path matched, etc.). */
  detail?: string;
}

// ── Permission Decision ────────────────────────────────────────────────────────

/**
 * The result of a single permission evaluation. Returned by LayeredPolicyEvaluator.
 *
 * Contains the final allow/deny outcome, the reason code, the source layer,
 * the semantic classification of the tool call, and a full evaluation trace
 * for audit logging and debugging.
 */
export interface PermissionDecision {
  /** Whether the tool call is permitted. */
  allowed: boolean;
  /** Primary reason code for the decision. */
  reason: DecisionReason;
  /** Which layer in the evaluation stack produced this decision. */
  sourceLayer: SourceLayer;
  /** The tool being evaluated. */
  toolName: string;
  /** Arguments passed to the tool. */
  args: Record<string, unknown>;
  /** Semantic classification of this tool call (set by the evaluator). */
  classification?: CommandClassification;
  /** Unix epoch milliseconds when the decision was produced. */
  timestamp: number;
  /** Full ordered trace of evaluation steps that led to this decision. */
  evaluationTrace: EvaluationStep[];
}

// ── Simulation Types ──────────────────────────────────────────────────────────

/**
 * Controls how the permission simulator behaves during evaluation.
 *
 * - `simulation-only`     — Both evaluators run; only the actual decision is
 *                           enforced. Divergence is logged silently.
 * - `warn-on-divergence`  — Both evaluators run; actual enforced. Divergence
 *                           emits a warning to the decision log.
 * - `enforce`             — The simulated evaluator becomes the authoritative
 *                           evaluator. Blocked if the divergence gate fails.
 */
export type SimulationMode =
  | 'simulation-only'
  | 'warn-on-divergence'
  | 'enforce';

/**
 * Categorises how two decisions diverged from one another.
 *
 * - `allow-vs-deny`  — Actual allowed; simulated denied.
 * - `deny-vs-allow`  — Actual denied; simulated allowed.
 * - `reason-mismatch`— Both produced the same allow/deny but with different
 *                      reason codes or source layers.
 */
export type DivergenceType =
  | 'allow-vs-deny'
  | 'deny-vs-allow'
  | 'reason-mismatch';

/**
 * The result of a single simulation evaluation — pairing the actual decision
 * with the simulated decision and describing any observed divergence.
 */
export interface SimulationResult {
  /** Decision produced by the actual (authoritative) evaluator. */
  actualDecision: PermissionDecision;
  /** Decision produced by the simulated (candidate) evaluator. */
  simulatedDecision: PermissionDecision;
  /**
   * The decision that should be enforced by the caller.
   *
   * - `simulation-only` and `warn-on-divergence` — equals `actualDecision`.
   * - `enforce` — equals `simulatedDecision` (simulated becomes authoritative).
   */
  authoritativeDecision: PermissionDecision;
  /** Whether the two decisions diverged in any way. */
  diverged: boolean;
  /** How the decisions diverged; only set when `diverged` is `true`. */
  divergenceType?: DivergenceType;
}

/**
 * A single divergence observation recorded for aggregation.
 *
 * Stored by `PermissionSimulator` and surfaced via `getDivergenceReport()`.
 */
export interface DivergenceRecord {
  /** Unix epoch milliseconds when the divergence was recorded. */
  timestamp: number;
  /** Tool name at the time of divergence. */
  toolName: string;
  /** Semantic classification of the tool call. */
  toolClass: CommandClassification;
  /** First token of the command/path/url argument, if present. */
  commandPrefix: string | undefined;
  /** Active simulation mode at the time of divergence. */
  mode: SimulationMode;
  /** How the two decisions diverged. */
  divergenceType: DivergenceType;
  /** Reason from the actual decision. */
  actualReason: DecisionReason;
  /** Reason from the simulated decision. */
  simulatedReason: DecisionReason;
}

/**
 * Aggregated statistics for a group of divergence records.
 */
export interface DivergenceStats {
  /** Total number of divergences observed. */
  total: number;
  /** Breakdown by divergence type. */
  byType: Record<DivergenceType, number>;
  /** Rate: divergences / total evaluations (0–1). */
  divergenceRate: number;
  /** Total evaluations against which this rate is computed. */
  totalEvaluations: number;
}

/**
 * Full report returned by `PermissionSimulator.getDivergenceReport()`.
 *
 * Aggregated statistics broken down by tool class and command prefix.
 */
export interface DivergenceReport {
  /** Aggregate statistics across all evaluations. */
  overall: DivergenceStats;
  /** Per-tool-class breakdown (keyed by CommandClassification). */
  byToolClass: Partial<Record<CommandClassification, DivergenceStats>>;
  /** Per-command-prefix breakdown (keyed by prefix string). */
  byCommandPrefix: Record<string, DivergenceStats>;
  /** Per-mode breakdown (keyed by SimulationMode). */
  byMode: Partial<Record<SimulationMode, DivergenceStats>>;
  /** Raw divergence records (capped at internal limit). */
  records: DivergenceRecord[];
}

/**
 * Configuration for `PermissionSimulator`.
 */
export interface PermissionSimulatorConfig {
  /**
   * Maximum number of divergence records to retain in memory.
   * Oldest records are evicted when the limit is reached. Defaults to 500.
   */
  maxDivergenceRecords?: number;
  /**
   * Maximum divergence rate (0–1) allowed before enforcement mode is blocked.
   * Only relevant when `mode` is `'enforce'`.
   * Defaults to 0.05 (5%).
   */
  divergenceThreshold?: number;
  /**
   * Optional callback invoked when a divergence is detected in `warn-on-divergence` mode.
   *
   * Receives the full `DivergenceRecord` for the diverging evaluation.
   * If omitted, warnings are written to `process.stderr` as a fallback.
   */
  onWarning?: (record: DivergenceRecord) => void;
}

// ── Policy Rules ───────────────────────────────────────────────────────────────

/**
 * Who authored this rule — affects precedence within the policy layer.
 * User rules take precedence over managed (system/plugin) rules.
 */
export type RuleOrigin = 'user' | 'managed';

/** Shared metadata present on every policy rule type. */
interface BaseRule {
  /** Unique rule identifier (used in trace output and logs). */
  id: string;
  /** Human-readable description of what this rule does. */
  description?: string;
  /** Who authored this rule. */
  origin: RuleOrigin;
  /** Whether the rule grants (allow) or blocks (deny) matching calls. */
  effect: 'allow' | 'deny';
}

/**
 * PrefixRule — matches tool names and/or command prefixes.
 *
 * Example: deny any exec call whose first argument starts with `rm -rf`.
 */
export interface PrefixRule extends BaseRule {
  type: 'prefix';
  /** Tool name(s) this rule applies to. Use `'*'` for any tool. */
  toolPattern: string | string[];
  /**
   * Prefix pattern(s) matched against the first string argument of the call.
   * If omitted, the rule matches any call to the specified tool(s).
   */
  commandPrefixes?: string[];
}

/**
 * ArgShapeRule — matches against argument shape/content via predicate.
 *
 * Example: deny calls where args contain `{ force: true }` combined with a
 * destructive tool name.
 */
export interface ArgShapeRule extends BaseRule {
  type: 'arg-shape';
  /** Tool name(s) this rule applies to. Use `'*'` for any tool. */
  toolPattern: string | string[];
  /**
   * Key/value pairs that must ALL be present in `args` for the rule to match.
   * Values may be the literal expected value or a regex string (prefixed `/`).
   */
  argMatchers: Record<string, unknown>;
}

/**
 * PathScopeRule — restricts or allows tool calls based on file path arguments.
 *
 * Example: deny any write tool call whose `path` arg escapes the project root.
 */
export interface PathScopeRule extends BaseRule {
  type: 'path-scope';
  /** Tool name(s) this rule applies to. Use `'*'` for any tool. */
  toolPattern: string | string[];
  /**
   * Allowed or denied path prefixes. Relative paths are resolved against cwd.
   * Supports glob-style `**` wildcards via micromatch semantics.
   */
  pathPatterns: string[];
}

/**
 * NetworkScopeRule — restricts or allows tool calls based on network host/URL.
 *
 * Example: deny any fetch call to hosts not in the allowed list.
 */
export interface NetworkScopeRule extends BaseRule {
  type: 'network-scope';
  /** Tool name(s) this rule applies to. Use `'*'` for any tool. */
  toolPattern: string | string[];
  /**
   * Allowed or denied hostnames/IP patterns. Supports glob wildcards.
   * Example: `['*.anthropic.com', 'localhost']`.
   */
  hostPatterns: string[];
  /**
   * Optional port restriction. If set, only the specified ports are matched.
   * Use `0` to match any port.
   */
  ports?: number[];
}

/**
 * ModeConstraintRule — activates only when a specific PermissionMode is active.
 *
 * Example: deny all write tools when mode is `'plan'`.
 */
export interface ModeConstraintRule extends BaseRule {
  type: 'mode-constraint';
  /** Mode(s) in which this rule is active. */
  activeModes: PermissionMode[];
  /** Tool name(s) or classifications this rule applies to. */
  toolPattern: string | string[];
  /** Optional: restrict by command classification instead of tool name. */
  classifications?: CommandClassification[];
}

/** Discriminated union of all policy rule types. */
export type PolicyRule =
  | PrefixRule
  | ArgShapeRule
  | PathScopeRule
  | NetworkScopeRule
  | ModeConstraintRule;

// ── Evaluator Configuration ────────────────────────────────────────────────────

/** Configuration object passed to `createPermissionsV2()`. */
export interface PermissionsV2Config {
  /** Active permission mode. Defaults to `'default'`. */
  mode?: PermissionMode;
  /**
   * Ordered list of policy rules applied in Layer 4.
   * User rules are evaluated before managed rules within this layer.
   */
  rules?: PolicyRule[];
  /**
   * Default decision when no rule or safety check fires.
   * Defaults to `'allow'` for read tools, `'deny'` for everything else.
   */
  defaultEffect?: 'allow' | 'deny';
  /** Whether to emit structured audit log entries for every decision. Defaults to true. */
  auditLog?: boolean;
}
