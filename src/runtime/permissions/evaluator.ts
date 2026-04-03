/**
 * Permissions v2 — LayeredPolicyEvaluator.
 *
 * Evaluates tool calls through a layered priority stack. First match wins.
 *
 * Layer order (highest to lowest priority):
 *   1. Safety checks (bypass-immune, always run)
 *   2. Mode constraints (active-mode-specific restrictions)
 *   3. Session overrides (cached per-session allow/deny)
 *   4. Policy rules (user rules first, then managed rules)
 *   5. Default policy (fallback)
 *
 * Returns a PermissionDecision with a full evaluation trace.
 */

import type {
  PermissionDecision,
  PermissionMode,
  CommandClassification,
  DecisionReason,
  EvaluationStep,
  PolicyRule,
  SourceLayer,
  PermissionsV2Config,
} from './types.ts';
import type { BundleProvenance } from './policy-loader.ts';

import { runSafetyChecks } from './safety-checks.ts';
import { DecisionLog } from './decision-log.ts';
import { evaluatePrefixRule } from './rules/prefix.ts';
import { evaluateArgShapeRule } from './rules/arg-shape.ts';
import { evaluatePathScopeRule } from './rules/path-scope.ts';
import { evaluateNetworkScopeRule } from './rules/network-scope.ts';
import { evaluateModeConstraintRule } from './rules/mode-constraint.ts';

// ── Tool classification ──────────────────────────────────────────────────────────

const READ_TOOLS: ReadonlySet<string> = new Set([
  'read', 'find', 'fetch', 'analyze', 'inspect', 'state', 'registry',
  'file_read', 'grep', 'list_dir', 'glob',
]);

const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write', 'edit', 'file_write', 'file_edit',
]);

const NETWORK_TOOLS: ReadonlySet<string> = new Set([
  'fetch', 'http', 'request', 'curl',
]);

const ESCALATION_TOOLS: ReadonlySet<string> = new Set([
  'agent', 'delegate', 'workflow', 'mcp',
]);

/**
 * classifyTool — Returns the semantic classification of a tool call.
 * For exec/execute, we classify based on arg content (destructive check
 * is done in safety layer; here we return 'write' as the baseline).
 */
function classifyTool(toolName: string): CommandClassification {
  if (NETWORK_TOOLS.has(toolName)) return 'network';
  if (ESCALATION_TOOLS.has(toolName)) return 'escalation';
  if (WRITE_TOOLS.has(toolName)) return 'write';
  if (READ_TOOLS.has(toolName)) return 'read';
  // exec-class tools are treated as 'write' (potentially destructive) by default
  return 'write';
}

// ── Mode constraint evaluation ──────────────────────────────────────────────────

interface ModeCheckResult {
  deny: boolean;
  allow: boolean;
  reason?: DecisionReason;
  step: EvaluationStep;
}

/**
 * evaluateModeLayer — Applies mode-level constraints.
 *
 * Returns a deny decision for certain tool/classification combinations
 * depending on the active mode, or allow for `allow-all` mode.
 */
function evaluateModeLayer(
  mode: PermissionMode,
  toolName: string,
  classification: CommandClassification,
): ModeCheckResult {
  switch (mode) {
    case 'allow-all':
      return {
        deny: false,
        allow: true,
        reason: 'MODE_ALLOW_ALL',
        step: {
          layer: 'mode',
          check: 'mode-allow-all',
          matched: true,
          detail: 'allow-all mode: all tools auto-approved',
        },
      };

    case 'plan':
      // Plan mode blocks write, network, and destructive
      if (classification === 'write' || classification === 'network' || classification === 'destructive') {
        return {
          deny: true,
          allow: false,
          reason: 'MODE_DENY_PLAN',
          step: {
            layer: 'mode',
            check: 'mode-plan-constraint',
            matched: true,
            detail: `plan mode denies ${classification} tool "${toolName}"`,
          },
        };
      }
      break;

    case 'background-restricted':
      // Background mode blocks escalation (agent/delegate) tools
      if (classification === 'escalation') {
        return {
          deny: true,
          allow: false,
          reason: 'MODE_DENY_BACKGROUND',
          step: {
            layer: 'mode',
            check: 'mode-background-constraint',
            matched: true,
            detail: `background-restricted mode denies escalation tool "${toolName}"`,
          },
        };
      }
      break;

    case 'remote-restricted':
      // Remote-restricted mode blocks network tools
      if (classification === 'network') {
        return {
          deny: true,
          allow: false,
          reason: 'MODE_DENY_REMOTE_RESTRICTED',
          step: {
            layer: 'mode',
            check: 'mode-remote-restricted-constraint',
            matched: true,
            detail: `remote-restricted mode denies network tool "${toolName}"`,
          },
        };
      }
      break;

    default:
      // 'default' and 'custom' modes: no mode-level constraints
      break;
  }

  return {
    deny: false,
    allow: false,
    step: {
      layer: 'mode',
      check: `mode-${mode}-constraint`,
      matched: false,
      detail: `mode "${mode}" imposes no constraint on "${toolName}" (${classification})`,
    },
  };
}

// ── Policy rule dispatch ──────────────────────────────────────────────────────────

interface PolicyRuleCheckResult {
  matched: boolean;
  effect: 'allow' | 'deny';
  reason: DecisionReason;
  step: EvaluationStep;
}

/**
 * dispatchPolicyRule — Routes a PolicyRule to its typed evaluator.
 */
function dispatchPolicyRule(
  rule: PolicyRule,
  toolName: string,
  args: Record<string, unknown>,
  activeMode: PermissionMode,
  classification: CommandClassification,
): PolicyRuleCheckResult {
  let matched = false;
  let step: EvaluationStep;

  switch (rule.type) {
    case 'prefix': {
      const result = evaluatePrefixRule(rule, toolName, args);
      matched = result.matched;
      step = result.step;
      break;
    }
    case 'arg-shape': {
      const result = evaluateArgShapeRule(rule, toolName, args);
      matched = result.matched;
      step = result.step;
      break;
    }
    case 'path-scope': {
      const result = evaluatePathScopeRule(rule, toolName, args);
      matched = result.matched;
      step = result.step;
      break;
    }
    case 'network-scope': {
      const result = evaluateNetworkScopeRule(rule, toolName, args);
      matched = result.matched;
      step = result.step;
      break;
    }
    case 'mode-constraint': {
      const result = evaluateModeConstraintRule(rule, toolName, activeMode, classification);
      matched = result.matched;
      step = result.step;
      break;
    }
  }

  const reason: DecisionReason =
    rule.effect === 'allow'
      ? rule.origin === 'user'
        ? 'RULE_ALLOW_USER'
        : 'RULE_ALLOW_MANAGED'
      : rule.origin === 'user'
        ? 'RULE_DENY_USER'
        : 'RULE_DENY_MANAGED';

  return { matched, effect: rule.effect, reason, step };
}

// ── LayeredPolicyEvaluator ───────────────────────────────────────────────────────

/**
 * LayeredPolicyEvaluator — Core evaluator for Permissions v2.
 *
 * Evaluates tool calls through five layers in priority order.
 * Maintains a session approval cache and a structured audit log.
 *
 * Usage:
 * ```ts
 * const evaluator = new LayeredPolicyEvaluator({ mode: 'default', rules: [] });
 * const decision = evaluator.evaluate('write', { path: '/tmp/out.txt' });
 * ```
 */
export class LayeredPolicyEvaluator {
  private readonly mode: PermissionMode;
  private readonly rules: PolicyRule[];
  private readonly defaultEffect: 'allow' | 'deny';
  private readonly sessionCache: Map<string, boolean> = new Map();
  private sessionCacheInsertOrder: string[] = [];
  readonly log: DecisionLog;
  /** GC-PERM-011: Provenance from the loaded policy bundle, if any. */
  private readonly provenance?: BundleProvenance;

  private static readonly MAX_SESSION_CACHE_SIZE = 500;

  constructor(config: PermissionsV2Config, provenance?: BundleProvenance) {
    this.mode = config.mode ?? 'default';
    this.rules = config.rules ?? [];
    this.defaultEffect = config.defaultEffect ?? 'deny';
    this.log = new DecisionLog();
    this.provenance = provenance;
  }

  /**
   * evaluate — Evaluates a tool call and returns a PermissionDecision.
   *
   * Runs all five layers in priority order. Populates a full evaluation trace.
   * Appends the decision to the audit log if `auditLog` is enabled (default: true).
   *
   * @param toolName — The tool name being called.
   * @param args     — The arguments passed to the tool.
   */
  evaluate(
    toolName: string,
    args: Record<string, unknown>,
  ): PermissionDecision {
    const trace: EvaluationStep[] = [];
    const classification = classifyTool(toolName);

    // ── Layer 1: Safety checks (bypass-immune) ──────────────────────────
    const safety = runSafetyChecks(toolName, args);
    trace.push(...safety.steps);
    if (safety.blocked) {
      return this.finalize({
        allowed: false,
        reason: safety.reason ?? 'SAFETY_DENY_GUARDRAIL',
        sourceLayer: 'safety',
        toolName,
        args,
        classification: safety.classification ?? classification,
        trace,
      });
    }

    // ── Layer 2: Mode constraints ───────────────────────────────────
    const modeResult = evaluateModeLayer(this.mode, toolName, classification);
    trace.push(modeResult.step);
    if (modeResult.deny) {
      return this.finalize({
        allowed: false,
        reason: modeResult.reason ?? 'MODE_DENY_PLAN',
        sourceLayer: 'mode',
        toolName,
        args,
        classification,
        trace,
      });
    }
    if (modeResult.allow) {
      return this.finalize({
        allowed: true,
        reason: modeResult.reason ?? 'MODE_ALLOW_ALL',
        sourceLayer: 'mode',
        toolName,
        args,
        classification,
        trace,
      });
    }

    // ── Layer 3: Session overrides ─────────────────────────────────
    const sessionKey = this.getSessionKey(toolName, args);
    const cached = this.sessionCache.get(sessionKey);
    if (cached !== undefined) {
      const cacheReason: DecisionReason = cached
        ? 'SESSION_CACHED_ALLOW'
        : 'SESSION_CACHED_DENY';
      trace.push({
        layer: 'session',
        check: 'session-cache',
        matched: true,
        detail: `cache hit for key "${sessionKey}" → ${cached ? 'allow' : 'deny'}`,
      });
      return this.finalize({
        allowed: cached,
        reason: cacheReason,
        sourceLayer: 'session',
        toolName,
        args,
        classification,
        trace,
      });
    }
    trace.push({
      layer: 'session',
      check: 'session-cache',
      matched: false,
      detail: `no session cache entry for key "${sessionKey}"`,
    });

    // ── Layer 4: Policy rules (user before managed, first match wins) ─────
    const userRules = this.rules.filter((r) => r.origin === 'user');
    const managedRules = this.rules.filter((r) => r.origin === 'managed');
    const orderedRules = [...userRules, ...managedRules];

    for (const rule of orderedRules) {
      const result = dispatchPolicyRule(rule, toolName, args, this.mode, classification);
      trace.push(result.step);
      if (result.matched) {
        return this.finalize({
          allowed: result.effect === 'allow',
          reason: result.reason,
          sourceLayer: 'policy',
          toolName,
          args,
          classification,
          trace,
        });
      }
    }

    // ── Layer 5: Default policy ─────────────────────────────────────
    // Default: auto-allow reads, apply configured defaultEffect for everything else
    const defaultAllow =
      this.defaultEffect === 'allow' || classification === 'read';
    const defaultReason: DecisionReason = defaultAllow ? 'DEFAULT_ALLOW' : 'DEFAULT_DENY';
    trace.push({
      layer: 'default',
      check: 'default-policy',
      matched: true,
      detail: `no rule matched; default=${defaultAllow ? 'allow' : 'deny'} (classification=${classification})`,
    });

    return this.finalize({
      allowed: defaultAllow,
      reason: defaultReason,
      sourceLayer: 'default',
      toolName,
      args,
      classification,
      trace,
    });
  }

  /**
   * recordSessionOverride — Records a user-provided session approval/denial
   * in the cache (used after a user prompt resolves).
   *
   * @param toolName  — Tool name.
   * @param args      — Tool arguments.
   * @param approved  — Whether the user approved or denied.
   * @param remember  — Whether to persist for the session (default: false = once only).
   */
  recordSessionOverride(
    toolName: string,
    args: Record<string, unknown>,
    approved: boolean,
    remember = false,
  ): void {
    if (remember) {
      const key = this.getSessionKey(toolName, args);
      if (!this.sessionCache.has(key)) {
        // Evict oldest entry if at capacity
        if (this.sessionCacheInsertOrder.length >= LayeredPolicyEvaluator.MAX_SESSION_CACHE_SIZE) {
          const oldest = this.sessionCacheInsertOrder.shift()!;
          this.sessionCache.delete(oldest);
        }
        this.sessionCacheInsertOrder.push(key);
      }
      this.sessionCache.set(key, approved);
    }
  }

  /**
   * getMode — Returns the active PermissionMode.
   */
  getMode(): PermissionMode {
    return this.mode;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private finalize(params: {
    allowed: boolean;
    reason: DecisionReason;
    sourceLayer: SourceLayer;
    toolName: string;
    args: Record<string, unknown>;
    classification: CommandClassification;
    trace: EvaluationStep[];
  }): PermissionDecision {
    const decision: PermissionDecision = {
      allowed: params.allowed,
      reason: params.reason,
      sourceLayer: params.sourceLayer,
      toolName: params.toolName,
      args: params.args,
      classification: params.classification,
      timestamp: Date.now(),
      evaluationTrace: params.trace,
      // GC-PERM-011: Attach provenance from the loaded policy bundle
      ...(this.provenance !== undefined && {
        policyBundleId: this.provenance.policyBundleId,
        signatureStatus: this.provenance.signatureStatus,
        provenanceSource: this.provenance.provenanceSource,
      }),
    };
    this.log.append(decision);
    return decision;
  }

  private getSessionKey(
    toolName: string,
    args: Record<string, unknown>,
  ): string {
    if (typeof args['path'] === 'string') return `${toolName}:path:${args['path']}`;
    if (typeof args['command'] === 'string') return `${toolName}:cmd:${args['command']}`;
    if (typeof args['url'] === 'string') return `${toolName}:url:${args['url']}`;
    const argKeysHash = JSON.stringify(Object.keys(args).sort());
    return `${toolName}:${argKeysHash}`;
  }
}
