/**
 * Tool Contract Verifier — registration-time contract checks for all registered tools.
 *
 * Validates five contract dimensions for every tool:
 * 1. Schema validity
 * 2. Timeout/cancellation semantics
 * 3. Permission class mapping
 * 4. Output policy compatibility
 * 5. Idempotency declaration for side-effecting tools
 *
 * Invalid tools fail closed: a tool with contract violations is rejected at
 * registration time with actionable diagnostics surfaced to the caller.
 */

import type { Tool, ToolDefinition } from '../../types/tools.ts';
import type { PhasedTool } from './adapter.ts';
import type { ToolClass } from './output-policy.ts';

// ── Constants ────────────────────────────────────────────────────────────────

/** Tool categories that produce side effects and require idempotency declarations. */
const SIDE_EFFECTING_CATEGORIES: ReadonlySet<string> = new Set([
  'write',
  'execute',
  'network',
  'delegate',
]);

/** Mapping from PhasedTool.category to ToolClass for output policy checks. */
const CATEGORY_TO_TOOL_CLASS: Readonly<Record<string, ToolClass>> = {
  read: 'read',
  write: 'write',
  execute: 'execute',
  network: 'network',
  delegate: 'read', // delegate spawns sub-agents; output is typically small
  analyze: 'analyze',
};

/** Valid JSON Schema primitive types. */
const VALID_JSON_SCHEMA_TYPES: ReadonlySet<string> = new Set([
  'object', 'array', 'string', 'number', 'integer', 'boolean', 'null',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

/** Severity of a single contract violation. */
export type ContractViolationSeverity = 'error' | 'warn';

/** A single contract check that failed or produced a warning. */
export interface ContractViolation {
  /** Which of the 5 contract dimensions this belongs to. */
  readonly dimension:
    | 'schema'
    | 'timeout-cancellation'
    | 'permission-class'
    | 'output-policy'
    | 'idempotency';
  /** Severity of the violation. */
  readonly severity: ContractViolationSeverity;
  /** Human-readable explanation of what is wrong. */
  readonly message: string;
  /** Optional hint for how to fix the violation. */
  readonly hint?: string;
}

/** Full contract verification result for a single tool. */
export interface ContractVerificationResult {
  /** Tool name. */
  readonly toolName: string;
  /** Whether the tool passed all required (error-level) checks. */
  readonly passed: boolean;
  /** All violations found. May include warnings even if passed. */
  readonly violations: readonly ContractViolation[];
  /** Unix timestamp (ms) when this result was produced. */
  readonly verifiedAt: number;
  /** Whether this tool was verified as a PhasedTool (has extended metadata). */
  readonly isPhasedTool: boolean;
}

/**
 * Options controlling which contract checks run and how strictly.
 */
export interface ContractVerifierOptions {
  /**
   * Whether to treat missing idempotency declarations on side-effecting tools
   * as errors (true, default) or warnings (false).
   *
   * Set to false while tightening tool metadata requirements incrementally.
   */
  strictIdempotency?: boolean;
  /**
   * Whether to treat missing permission class metadata as errors (true) or
   * warnings (false, default for tool definitions that omit that metadata).
   */
  strictPermissionClass?: boolean;
}

// ── Dimension checkers ────────────────────────────────────────────────────────

/**
 * Check 1 — Schema validity.
 *
 * Validates that the tool definition's parameters object is a structurally
 * sound JSON Schema. Does not make network calls or validate against a meta-schema;
 * checks for the most common structural mistakes that cause LLM call failures.
 */
function checkSchema(def: ToolDefinition): ContractViolation[] {
  const violations: ContractViolation[] = [];
  const params = def.parameters;

  if (!params || typeof params !== 'object') {
    violations.push({
      dimension: 'schema',
      severity: 'error',
      message: `Tool '${def.name}': parameters must be a non-null object (JSON Schema).`,
      hint: 'Set parameters to at least { type: "object", properties: {} }.',
    });
    return violations;
  }

  // Must have a type field
  if (!('type' in params)) {
    violations.push({
      dimension: 'schema',
      severity: 'error',
      message: `Tool '${def.name}': parameters schema missing required 'type' field.`,
      hint: 'Add type: "object" to your parameters schema.',
    });
  } else if (!VALID_JSON_SCHEMA_TYPES.has((params as Record<string, unknown>).type as string)) {
    violations.push({
      dimension: 'schema',
      severity: 'error',
      message: `Tool '${def.name}': parameters schema has invalid 'type' value '${(params as Record<string, unknown>).type}'.`,
      hint: `Use one of: ${[...VALID_JSON_SCHEMA_TYPES].join(', ')}.`,
    });
  }

  // If type is object, should have properties
  if ((params as Record<string, unknown>).type === 'object' && !('properties' in params)) {
    violations.push({
      dimension: 'schema',
      severity: 'warn',
      message: `Tool '${def.name}': object schema has no 'properties' field.`,
      hint: 'Add a properties object even if empty to clarify tool interface.',
    });
  }

  // Name must be non-empty and safe for LLM function naming
  if (!def.name || typeof def.name !== 'string' || def.name.trim().length === 0) {
    violations.push({
      dimension: 'schema',
      severity: 'error',
      message: `Tool has an empty or missing name.`,
      hint: 'Set a non-empty name string on the tool definition.',
    });
  } else if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(def.name)) {
    violations.push({
      dimension: 'schema',
      severity: 'warn',
      message: `Tool '${def.name}': name contains characters that may be rejected by some LLM providers.`,
      hint: 'Use only letters, digits, underscores, or hyphens, starting with a letter or underscore.',
    });
  }

  // Description must be present and non-trivial
  if (!def.description || typeof def.description !== 'string') {
    violations.push({
      dimension: 'schema',
      severity: 'error',
      message: `Tool '${def.name}': missing or non-string description.`,
      hint: 'Provide a clear description so the LLM knows when to call this tool.',
    });
  } else if (def.description.trim().length < 10) {
    violations.push({
      dimension: 'schema',
      severity: 'warn',
      message: `Tool '${def.name}': description is very short (${def.description.trim().length} chars).`,
      hint: 'Write a description of at least 10 characters so the LLM can use this tool correctly.',
    });
  }

  return violations;
}

/**
 * Check 2 — Timeout and cancellation semantics.
 *
 * For PhasedTools: validates that phase timeouts are positive integers and that
 * long-running tool categories declare cancellable=true.
 */
function checkTimeoutCancellation(phased: Partial<PhasedTool>, toolName: string): ContractViolation[] {
  const violations: ContractViolation[] = [];

  if (phased.phaseTimeouts !== undefined) {
    for (const [phase, ms] of Object.entries(phased.phaseTimeouts)) {
      if (typeof ms !== 'number' || !Number.isInteger(ms) || ms <= 0) {
        violations.push({
          dimension: 'timeout-cancellation',
          severity: 'error',
          message: `Tool '${toolName}': phaseTimeouts['${phase}'] must be a positive integer (got ${JSON.stringify(ms)}).`,
          hint: 'Set phase timeouts to positive integer values in milliseconds.',
        });
      } else if (ms > 600_000) {
        violations.push({
          dimension: 'timeout-cancellation',
          severity: 'warn',
          message: `Tool '${toolName}': phaseTimeouts['${phase}'] = ${ms}ms exceeds 10 minutes.`,
          hint: 'Consider whether a timeout above 10 minutes is intentional. Use cancellable=true for long-running tools.',
        });
      }
    }
  }

  // Side-effecting tools should support cancellation to avoid dangling state
  if (phased.category !== undefined && SIDE_EFFECTING_CATEGORIES.has(phased.category)) {
    if (phased.cancellable === false) {
      violations.push({
        dimension: 'timeout-cancellation',
        severity: 'warn',
        message: `Tool '${toolName}' (category='${phased.category}') declares cancellable=false.`,
        hint: 'Side-effecting tools (write/execute/network/delegate) should support cancellation to prevent dangling state on abort.',
      });
    }
  }

  return violations;
}

/**
 * Check 3 — Permission class mapping.
 *
 * For PhasedTools: validates that a category is declared and maps to a known
 * permission class. Plain Tools receive a warning about missing classification.
 */
function checkPermissionClass(phased: Partial<PhasedTool>, toolName: string, strict: boolean): ContractViolation[] {
  const violations: ContractViolation[] = [];

  const knownCategories = new Set(['read', 'write', 'execute', 'delegate', 'network', 'analyze']);

  if (phased.category === undefined) {
    violations.push({
      dimension: 'permission-class',
      severity: strict ? 'error' : 'warn',
      message: `Tool '${toolName}': no permission class (category) declared.`,
      hint: 'Implement PhasedTool and set category to read|write|execute|delegate|network|analyze so the permission evaluator can classify this tool.',
    });
  } else if (!knownCategories.has(phased.category)) {
    violations.push({
      dimension: 'permission-class',
      severity: 'error',
      message: `Tool '${toolName}': unknown category '${phased.category}'.`,
      hint: `Use one of: ${[...knownCategories].join(', ')}.`,
    });
  }

  return violations;
}

/**
 * Check 4 — Output policy compatibility.
 *
 * For PhasedTools: validates that the tool's category maps to a known ToolClass
 * with a configured output policy. All default policies exist, but third-party
 * categories would fail this check.
 */
function checkOutputPolicy(phased: Partial<PhasedTool>, toolName: string): ContractViolation[] {
  const violations: ContractViolation[] = [];

  if (phased.category === undefined) {
    // Already flagged in permission-class check; skip to avoid duplicate messages
    return violations;
  }

  const toolClass = CATEGORY_TO_TOOL_CLASS[phased.category];
  if (toolClass === undefined) {
    violations.push({
      dimension: 'output-policy',
      severity: 'error',
      message: `Tool '${toolName}': category '${phased.category}' has no output policy mapping.`,
      hint: `Add a CATEGORY_TO_TOOL_CLASS entry or register a custom output policy for '${phased.category}'.`,
    });
  }

  return violations;
}

/**
 * Check 5 — Idempotency declaration.
 *
 * Side-effecting tools (write/execute/network/delegate) must explicitly declare
 * their idempotency posture. This is surfaced as a contract property on the tool
 * definition's metadata or via a dedicated `idempotent` field on PhasedTool.
 *
 * For now, we check for the presence of an `idempotent` boolean field on the
 * tool object (duck-typed). If strict mode is on and the field is absent for
 * a side-effecting tool, it is flagged as an error.
 */
function checkIdempotency(phased: Partial<PhasedTool> & { idempotent?: unknown }, toolName: string, strict: boolean): ContractViolation[] {
  const violations: ContractViolation[] = [];

  // Only applies to side-effecting categories
  if (phased.category === undefined || !SIDE_EFFECTING_CATEGORIES.has(phased.category)) {
    return violations;
  }

  if (!('idempotent' in phased) || phased.idempotent === undefined) {
    violations.push({
      dimension: 'idempotency',
      severity: strict ? 'error' : 'warn',
      message: `Tool '${toolName}' (category='${phased.category}') has no idempotency declaration.`,
      hint: 'Add idempotent: true|false to the PhasedTool to declare whether repeated calls with the same args are safe. '
        + 'This enables the executor to deduplicate in-flight calls and surface dedup status in diagnostics.',
    });
  } else if (typeof phased.idempotent !== 'boolean') {
    violations.push({
      dimension: 'idempotency',
      severity: 'error',
      message: `Tool '${toolName}': idempotent field must be boolean (got ${typeof phased.idempotent}).`,
      hint: 'Set idempotent to exactly true or false.',
    });
  }

  return violations;
}

// ── Main verifier ─────────────────────────────────────────────────────────────

/**
 * ToolContractVerifier — runs all 5 contract checks on a single tool.
 *
 * Usage:
 * ```ts
 * const verifier = new ToolContractVerifier();
 * const result = verifier.verify(myTool);
 * if (!result.passed) {
 *   for (const v of result.violations.filter(v => v.severity === 'error')) {
 *     throw new Error(v.message);
 *   }
 * }
 * ```
 */
export class ToolContractVerifier {
  private readonly _opts: Required<ContractVerifierOptions>;

  constructor(opts: ContractVerifierOptions = {}) {
    this._opts = {
      strictIdempotency: opts.strictIdempotency ?? true,
      strictPermissionClass: opts.strictPermissionClass ?? false,
    };
  }

  /**
   * Verify a single tool against all 5 contract dimensions.
   *
   * @param tool - The tool to verify.
   * @returns A ContractVerificationResult with all violations and a pass/fail flag.
   */
  verify(tool: Tool): ContractVerificationResult {
    const phased = tool as Partial<PhasedTool>;
    const isPhasedTool = 'category' in phased && phased.category !== undefined;

    const violations: ContractViolation[] = [
      ...checkSchema(tool.definition),
      ...checkTimeoutCancellation(phased, tool.definition.name),
      ...checkPermissionClass(phased, tool.definition.name, this._opts.strictPermissionClass),
      ...checkOutputPolicy(phased, tool.definition.name),
      ...checkIdempotency(phased, tool.definition.name, this._opts.strictIdempotency),
    ];

    const passed = !violations.some((v) => v.severity === 'error');

    return {
      toolName: tool.definition.name,
      passed,
      violations,
      verifiedAt: Date.now(),
      isPhasedTool,
    };
  }

  /**
   * Verify multiple tools at once.
   *
   * @param tools - Array of tools to verify.
   * @returns Map of tool name to verification result.
   */
  verifyAll(tools: readonly Tool[]): Map<string, ContractVerificationResult> {
    const results = new Map<string, ContractVerificationResult>();
    for (const tool of tools) {
      results.set(tool.definition.name, this.verify(tool));
    }
    return results;
  }

  /**
   * Format a verification result as a human-readable diagnostic string.
   * Suitable for printing to the console or a diagnostics panel.
   *
   * @param result - The result to format.
   * @returns Multi-line formatted diagnostic string.
   */
  static formatResult(result: ContractVerificationResult): string {
    const lines: string[] = [];
    const status = result.passed ? 'PASS' : 'FAIL';
    const phasedNote = result.isPhasedTool ? ' [phased]' : ' [basic]';
    lines.push(`[${status}] ${result.toolName}${phasedNote}`);

    if (result.violations.length === 0) {
      lines.push('  All contract checks passed.');
    } else {
      for (const v of result.violations) {
        const prefix = v.severity === 'error' ? '  [ERROR]' : '  [WARN] ';
        lines.push(`${prefix} [${v.dimension}] ${v.message}`);
        if (v.hint) {
          lines.push(`           Hint: ${v.hint}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Format a map of results (from verifyAll) as a human-readable summary.
   *
   * @param results - Map of tool name to verification result.
   * @returns Multi-line formatted diagnostic string.
   */
  static formatAllResults(results: Map<string, ContractVerificationResult>): string {
    const lines: string[] = [];
    let passed = 0;
    let failed = 0;
    let warned = 0;

    for (const result of results.values()) {
      lines.push(ToolContractVerifier.formatResult(result));
      if (result.passed) {
        if (result.violations.some((v) => v.severity === 'warn')) warned++;
        else passed++;
      } else {
        failed++;
      }
    }

    lines.push('');
    lines.push(`Summary: ${passed} passed, ${warned} passed with warnings, ${failed} failed.`);
    return lines.join('\n');
  }
}
