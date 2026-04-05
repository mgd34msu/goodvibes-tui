/**
 * Runtime permissions safety checks.
 *
 * These checks run first and always, regardless of mode, session overrides,
 * or policy rules. They cannot be disabled by configuration.
 */

import type {
  CommandClassification,
  DecisionReason,
  EvaluationStep,
} from './types.ts';

// ── Dangerous prefix patterns ────────────────────────────────────────────────

/**
 * Shell command prefixes that are unconditionally dangerous.
 * Matched against the first string argument of exec-class tools.
 */
const DESTRUCTIVE_PREFIXES: readonly string[] = [
  // Recursive root deletion
  'rm -rf /',
  'rm -fr /',
  'rm --no-preserve-root',
  // Disk destruction
  'dd if=/dev/',
  'mkfs',
  'shred',
  'wipefs',
  // Privileged escalation
  'chmod 777 /',
  'chmod -R 777 /',
  // Fork bomb patterns
  ':(){ :|:&};:',
  // /dev/null / disk overwrite
  '> /dev/sda',
  '> /dev/hda',
];

/**
 * SQL DML patterns that are unconditionally dangerous.
 * Matched case-insensitively against the first string argument of db-class tools.
 */
const DESTRUCTIVE_SQL_PATTERNS: readonly RegExp[] = [
  /^\s*DROP\s+TABLE\b/i,
  /^\s*DROP\s+DATABASE\b/i,
  /^\s*TRUNCATE\b/i,
  /^\s*DELETE\s+FROM\s+\w+\s*;?\s*$/i, // DELETE without WHERE
];

/**
 * Known dangerous command patterns matched against the full command string.
 */
const DANGEROUS_PATTERNS: readonly RegExp[] = [
  // Writing to /etc/passwd or /etc/shadow
  /\/etc\/(passwd|shadow|sudoers)/,
  // Cron injection
  /\/etc\/cron/,
  // SSH key manipulation
  /\.ssh\/(authorized_keys|known_hosts)/,
  // Bash history clear
  /history\s+-[cw]/,
  // iptables flush
  /iptables\s+-F/,
  // Base64-encoded shell
  /base64\s+.*\|.*sh/,
  // Curl-pipe-bash
  /curl\s+.*\|\s*(ba)?sh/,
  // Wget-pipe-bash
  /wget\s+.*\|\s*(ba)?sh/,
];

/**
 * Path segments that indicate a path escape attempt.
 * Checked against normalized path arguments.
 */
const PATH_ESCAPE_INDICATORS: readonly string[] = [
  // Traversal to root or parent-of-root
  '/../../../',
  '/../../',
  // Null byte injection
  '\0',
];

// ── Safety check result ───────────────────────────────────────────────────────────

export interface SafetyCheckResult {
  /** Whether the call is blocked by a safety check. */
  blocked: boolean;
  /** Reason code if blocked (always a SAFETY_* code). */
  reason?: DecisionReason;
  /** Human-readable explanation for the evaluation trace. */
  detail?: string;
  /** Steps added to the trace during evaluation (one per check run). */
  steps: EvaluationStep[];
  /** Semantic classification if determined by the safety layer. */
  classification?: CommandClassification;
}

// ── Exec-class tool detection ──────────────────────────────────────────────────

/** Tool names that accept shell commands as their primary argument. */
const EXEC_CLASS_TOOLS: ReadonlySet<string> = new Set([
  'exec',
  'bash',
  'sh',
  'run',
]);

/** Tool names that accept file paths as their primary argument. */
const PATH_CLASS_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'write',
  'edit',
  'find',
]);

/** Tool names that accept SQL as their primary argument. */
const DB_CLASS_TOOLS: ReadonlySet<string> = new Set([
  'db',
  'query',
  'sql',
]);

// ── Argument extraction helpers ─────────────────────────────────────────────────

/** Extracts the primary string argument (command, path, query, etc.) from args. */
function extractPrimaryArg(args: Record<string, unknown>): string | null {
  const candidates = ['command', 'cmd', 'path', 'query', 'sql', 'script'];
  for (const key of candidates) {
    if (typeof args[key] === 'string') return args[key] as string;
  }
  // Fallback: first string value
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

// ── Individual safety checks ──────────────────────────────────────────────────

/**
 * Checks whether the command string starts with a known destructive prefix.
 * Only applied to exec-class tools.
 */
function checkDestructivePrefix(
  toolName: string,
  primaryArg: string | null,
): { blocked: boolean; detail?: string } {
  if (!EXEC_CLASS_TOOLS.has(toolName) || primaryArg === null) {
    return { blocked: false };
  }
  const normalized = primaryArg.trim().toLowerCase();
  for (const prefix of DESTRUCTIVE_PREFIXES) {
    if (normalized.startsWith(prefix.toLowerCase())) {
      return { blocked: true, detail: `Command starts with destructive prefix: "${prefix}"` };
    }
  }
  return { blocked: false };
}

/**
 * Checks whether the command matches known dangerous shell patterns.
 * Applied to exec-class tools.
 */
function checkDangerousPattern(
  toolName: string,
  primaryArg: string | null,
): { blocked: boolean; detail?: string } {
  if (!EXEC_CLASS_TOOLS.has(toolName) || primaryArg === null) {
    return { blocked: false };
  }
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(primaryArg)) {
      return { blocked: true, detail: `Command matches dangerous pattern: ${pattern.source}` };
    }
  }
  return { blocked: false };
}

/**
 * Checks whether a path argument attempts to escape safe boundaries.
 * Applied to path-class tools.
 */
function checkPathEscape(
  toolName: string,
  args: Record<string, unknown>,
): { blocked: boolean; detail?: string } {
  if (!PATH_CLASS_TOOLS.has(toolName)) return { blocked: false };

  const pathArgs = Object.entries(args)
    .filter(([, v]) => typeof v === 'string')
    .map(([, v]) => v as string);

  for (const pathArg of pathArgs) {
    for (const indicator of PATH_ESCAPE_INDICATORS) {
      if (pathArg.includes(indicator)) {
        return { blocked: true, detail: `Path argument contains escape indicator: "${indicator}"` };
      }
    }
    // Null byte check applies to all strings
    if (pathArg.includes('\0')) {
      return { blocked: true, detail: 'Path argument contains null byte (injection attempt)' };
    }
  }
  return { blocked: false };
}

/**
 * Checks for destructive SQL patterns.
 * Applied to db-class tools.
 */
function checkDestructiveSQL(
  toolName: string,
  primaryArg: string | null,
): { blocked: boolean; detail?: string } {
  if (!DB_CLASS_TOOLS.has(toolName) || primaryArg === null) {
    return { blocked: false };
  }
  for (const pattern of DESTRUCTIVE_SQL_PATTERNS) {
    if (pattern.test(primaryArg)) {
      return { blocked: true, detail: `SQL matches destructive pattern: ${pattern.source}` };
    }
  }
  return { blocked: false };
}

// ── Public API ───────────────────────────────────────────────────────────────────

/**
 * runSafetyChecks — Executes all bypass-immune safety checks for a tool call.
 *
 * Returns a SafetyCheckResult with `blocked: false` if all checks pass,
 * or `blocked: true` with a SAFETY_* reason code and trace step if any check fires.
 *
 * These checks cannot be bypassed by any policy rule, mode, or session override.
 *
 * @param toolName  — The tool being called.
 * @param args      — Arguments passed to the tool.
 */
export function runSafetyChecks(
  toolName: string,
  args: Record<string, unknown>,
): SafetyCheckResult {
  const steps: EvaluationStep[] = [];
  const primaryArg = extractPrimaryArg(args);

  // — Check 1: Destructive prefix
  const prefixResult = checkDestructivePrefix(toolName, primaryArg);
  steps.push({
    layer: 'safety',
    check: 'destructive-prefix',
    matched: prefixResult.blocked,
    detail: prefixResult.detail,
  });
  if (prefixResult.blocked) {
    return {
      blocked: true,
      reason: 'SAFETY_DENY_DESTRUCTIVE_PREFIX',
      detail: prefixResult.detail,
      steps,
      classification: 'destructive',
    };
  }

  // — Check 2: Dangerous shell pattern
  const patternResult = checkDangerousPattern(toolName, primaryArg);
  steps.push({
    layer: 'safety',
    check: 'dangerous-pattern',
    matched: patternResult.blocked,
    detail: patternResult.detail,
  });
  if (patternResult.blocked) {
    return {
      blocked: true,
      reason: 'SAFETY_DENY_DANGEROUS_PATTERN',
      detail: patternResult.detail,
      steps,
      classification: 'destructive',
    };
  }

  // — Check 3: Path escape
  const pathResult = checkPathEscape(toolName, args);
  steps.push({
    layer: 'safety',
    check: 'path-escape',
    matched: pathResult.blocked,
    detail: pathResult.detail,
  });
  if (pathResult.blocked) {
    return {
      blocked: true,
      reason: 'SAFETY_DENY_PATH_ESCAPE',
      detail: pathResult.detail,
      steps,
      classification: 'escalation',
    };
  }

  // — Check 4: Destructive SQL
  const sqlResult = checkDestructiveSQL(toolName, primaryArg);
  steps.push({
    layer: 'safety',
    check: 'destructive-sql',
    matched: sqlResult.blocked,
    detail: sqlResult.detail,
  });
  if (sqlResult.blocked) {
    return {
      blocked: true,
      reason: 'SAFETY_DENY_DANGEROUS_SQL',
      detail: sqlResult.detail,
      steps,
      classification: 'destructive',
    };
  }

  return { blocked: false, steps };
}
