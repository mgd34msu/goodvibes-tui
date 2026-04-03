/**
 * Shell AST guard for the exec tool (GC-EXEC-005).
 *
 * Integrates the Shell AST normalization pipeline with the exec tool to
 * provide per-segment verdict evaluation and user-facing denial explanations.
 *
 * When the `shell-ast-normalization` feature flag is enabled, every exec
 * command is parsed into an AST, evaluated segment-by-segment, and denied
 * with a structured explanation if any segment fails policy.
 *
 * When the flag is disabled, this module falls back to the legacy segmentation
 * mode (flat token-based normalization).
 *
 * @module tools/exec/ast-guard
 */

import { parseCommandAST } from '../../runtime/permissions/normalization/parser.ts';
import { evaluateCommandAST, DEFAULT_ALLOWED_CLASSES } from '../../runtime/permissions/normalization/verdict.ts';
import { normalizeCommand } from '../../runtime/permissions/normalization/index.ts';
import type { CompoundVerdict } from '../../runtime/permissions/normalization/verdict.ts';
import type { CommandClassification } from '../../runtime/permissions/normalization/types.ts';

// ── Feature flag integration ───────────────────────────────────────────────────

/**
 * Module-level cached flag manager. Populated on first successful resolution.
 * `null` means "not yet resolved or unavailable"; `false` means "permanently unavailable".
 */
type FlagManagerLike = { isEnabled(id: string): boolean };
let _flagManager: FlagManagerLike | false | null = null;

/**
 * Lazily resolves the FeatureFlagManager singleton via dynamic import.
 * Uses a module-level cache so the import is attempted at most once per process.
 */
async function resolveFlagManager(): Promise<FlagManagerLike | null> {
  if (_flagManager !== null) return _flagManager || null;
  try {
    const mod = await import('../../runtime/feature-flags/manager.ts');
    const mgr = (mod.FeatureFlagManager as { getInstance?: () => FlagManagerLike } | undefined)?.getInstance?.() ?? null;
    _flagManager = mgr ?? false;
    return mgr;
  } catch {
    _flagManager = false;
    return null;
  }
}

/**
 * Thin adapter: checks the runtime feature flag manager if available.
 * Falls back to `false` (disabled) when the manager is not initialised.
 *
 * We import lazily via dynamic import to avoid circular dependency between
 * tools and runtime. The manager is resolved once and cached at module level.
 */
async function isASTNormalizationEnabled(): Promise<boolean> {
  const manager = await resolveFlagManager();
  return manager?.isEnabled('shell-ast-normalization') ?? false;
}

// ── Allowed classification set ─────────────────────────────────────────────────

// DEFAULT_ALLOWED_CLASSES is imported from verdict.ts

// ── Guard result ───────────────────────────────────────────────────────────────

/**
 * The result of an AST guard evaluation for a single exec command.
 */
export interface ASTGuardResult {
  /** Whether the command is permitted by the AST guard. */
  allowed: boolean;
  /**
   * Human-readable denial explanation for user display.
   * Only set when `allowed` is false.
   */
  denialMessage?: string;
  /**
   * The full CompoundVerdict, available for upstream audit logging.
   * Only set when AST normalization is active.
   */
  verdict?: CompoundVerdict;
  /** Whether AST normalization was active (vs. legacy mode). */
  astModeActive: boolean;
}

// ── Legacy mode guard ──────────────────────────────────────────────────────────

/**
 * Evaluates a command using the legacy flat segmentation pipeline.
 *
 * Returns `allowed: true` for non-destructive, non-escalation commands.
 * This mirrors the pre-GC-EXEC-005 behaviour of the exec tool.
 *
 * @param command - The raw shell command string.
 * @returns ASTGuardResult with legacy mode flag set.
 */
function legacyGuard(command: string): ASTGuardResult {
  const normalized = normalizeCommand(command);
  const cls = normalized.highestClassification;

  if (cls === 'destructive' || cls === 'escalation') {
    return {
      allowed: false,
      denialMessage:
        `Command denied (legacy mode): "${command}"\n` +
        `Classification: ${cls}\n` +
        `Highest-risk operation in compound command is classified as ${cls}.`,
      astModeActive: false,
    };
  }

  return { allowed: true, astModeActive: false };
}

// ── AST mode guard ─────────────────────────────────────────────────────────────

/**
 * Evaluates a command using the Shell AST pipeline (GC-EXEC-005).
 *
 * Parses the command into a ShellNode AST, evaluates each segment
 * independently, and returns a CompoundVerdict.
 *
 * @param command        - The raw shell command string.
 * @param allowedClasses - Classification tiers to allow.
 * @returns ASTGuardResult with full CompoundVerdict attached.
 */
function astGuard(
  command: string,
  allowedClasses: ReadonlySet<CommandClassification>,
): ASTGuardResult {
  const ast = parseCommandAST(command);
  const verdict = evaluateCommandAST(command, ast, allowedClasses);

  if (!verdict.allowed) {
    return {
      allowed: false,
      denialMessage: verdict.denialExplanation,
      verdict,
      astModeActive: true,
    };
  }

  return {
    allowed: true,
    verdict,
    astModeActive: true,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Evaluates a shell command string through the AST guard.
 *
 * Routes to the AST pipeline when the `shell-ast-normalization` feature flag
 * is enabled, otherwise falls back to the legacy segmentation mode.
 *
 * @param command        - The raw shell command string to evaluate.
 * @param allowedClasses - Override for the default allowed classification set.
 *                         Only used in AST mode.
 * @returns ASTGuardResult with allow/deny decision and optional denial message.
 *
 * @example
 * const result = guardExecCommand('ls /tmp && rm -rf /');
 * if (!result.allowed) {
 *   console.error(result.denialMessage);
 * }
 */
export async function guardExecCommand(
  command: string,
  allowedClasses: ReadonlySet<CommandClassification> = DEFAULT_ALLOWED_CLASSES,
): Promise<ASTGuardResult> {
  if (await isASTNormalizationEnabled()) {
    return astGuard(command, allowedClasses);
  }
  return legacyGuard(command);
}

/**
 * Formats an ASTGuardResult denial into a structured exec tool error response.
 *
 * @param result - A denied ASTGuardResult.
 * @param cmd    - The original command string (for the error message).
 * @returns A structured error object suitable for returning from the exec tool.
 */
export function formatDenialResponse(
  result: ASTGuardResult,
  cmd: string,
): Record<string, unknown> {
  const segmentDetails = result.verdict?.segments.map((s) => ({
    command: s.command,
    classification: s.classification,
    allowed: s.allowed,
    reason: s.reason,
    ...(s.hasObfuscation ? { obfuscation: s.obfuscationPatterns } : {}),
  }));

  return {
    success: false,
    cmd,
    denied: true,
    denial_reason: result.denialMessage ?? 'Command denied by policy',
    ...(segmentDetails ? { segments: segmentDetails } : {}),
    ast_mode: result.astModeActive,
  };
}
