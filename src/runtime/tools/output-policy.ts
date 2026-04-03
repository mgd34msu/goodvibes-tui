import type { ToolResult } from '../../types/tools.ts';
import { overflowHandler } from '../../tools/shared/overflow.ts';
import type { SpillBackendType } from '../../tools/shared/overflow.ts';

// ─── Tool Class ─────────────────────────────────────────────────────────────

/**
 * ToolClass — semantic classification of a tool's output characteristics.
 *
 * Mirrors `PhasedTool.category` but adds `analyze` for analytical/inspection
 * tools that produce structured summaries rather than raw data.
 */
export type ToolClass = 'read' | 'write' | 'execute' | 'network' | 'analyze';

// ─── Policy Types ────────────────────────────────────────────────────────────

/**
 * ToolOutputPolicy — limits and behaviour rules applied to every tool result
 * of a given class before it reaches the LLM context window.
 */
export interface ToolOutputPolicy {
  /**
   * Identifies which tool class this policy governs.
   * Used as the stable `policyId` in audit records.
   */
  toolClass: ToolClass;

  /**
   * Soft token ceiling (estimated as chars / 4).
   * Enforcement is informational — `maxBytes` is the hard limit.
   */
  maxTokens: number;

  /**
   * Hard byte ceiling for the serialised output string.
   * Output exceeding this limit is truncated or spilled.
   */
  maxBytes: number;

  /**
   * Where to cut when output exceeds `maxBytes`.
   *
   * - `tail`    — keep the beginning, drop the end (default for most classes)
   * - `head`    — keep the end, drop the beginning (useful for execute stdout)
   * - `middle`  — keep both ends, drop the middle
   * - `summary` — replace with a size/type summary (not yet implemented; falls back to `tail`)
   */
  truncationMode: 'tail' | 'head' | 'middle' | 'summary';

  /**
   * Where to put content that exceeds the byte limit.
   *
   * - `inline`    — truncate in-place, append an ellipsis note
   * - `file`      — spill to `.goodvibes/.overflow/`, embed a path reference
   * - `reference` — replace content with a compact reference marker only
   */
  spillMode: 'inline' | 'file' | 'reference';

  /**
   * Whether to attach an `OutputPolicyResult` audit record to the transformed
   * `ToolResult`.  Always `true` for production policies; can be set `false`
   * in lightweight / test contexts.
   */
  auditMetadata: boolean;
}

/**
 * OutputPolicyResult — audit record produced by `applyOutputPolicy`.
 * Attached to the transformed `ToolResult` as `_policyAudit`.
 */
export interface OutputPolicyResult {
  /** Stable identifier matching `ToolOutputPolicy.toolClass`. */
  policyId: string;
  /**
   * What the policy enforcement actually did:
   * - `none`       — output was within limits; no transformation applied
   * - `truncated`  — output was cut to fit within `maxBytes`
   * - `spilled`    — overflow was written to disk; a reference was embedded
   * - `referenced` — output replaced by a compact reference marker
   */
  actionTaken: 'none' | 'truncated' | 'spilled' | 'referenced';
  /** Original output byte length before policy enforcement. */
  originalSize: number;
  /** Output byte length after policy enforcement. */
  resultSize: number;
  /**
   * Backend type used when `actionTaken === 'spilled'`.
   * Undefined for other action types.
   */
  spillBackend?: SpillBackendType;
}

/**
 * ToolResultWithAudit — a `ToolResult` with an optional policy audit record
 * injected by `applyOutputPolicy`.
 *
 * The base `ToolResult` interface is left unmodified; this extension is the
 * only carrier of audit data so the core type surface stays stable.
 */
export interface ToolResultWithAudit extends ToolResult {
  /** Policy audit record — present on every result that passed through output-policy. */
  _policyAudit?: OutputPolicyResult;
}

// ─── Default Policies ────────────────────────────────────────────────────────

/** Approximate bytes-per-token ratio used for the soft token estimate. */
const BYTES_PER_TOKEN = 4;

/**
 * DEFAULT_POLICIES — one policy per tool class.
 *
 * Byte limits are calibrated to stay well under typical LLM context windows:
 * - read    : 200 KB — file reads can be large; spill remainder to disk
 * - write   : 32 KB  — confirmations should be concise; inline truncation
 * - execute : 128 KB — command output can be chatty; keep tail (most recent)
 * - network : 256 KB — remote responses can be large; spill to disk
 * - analyze : 64 KB  — structured summaries; inline truncation
 */
export const DEFAULT_POLICIES: Readonly<Record<ToolClass, ToolOutputPolicy>> = {
  read: {
    toolClass: 'read',
    maxBytes: 200 * 1024,
    maxTokens: Math.round((200 * 1024) / BYTES_PER_TOKEN),
    truncationMode: 'tail',
    spillMode: 'file',
    auditMetadata: true,
  },
  write: {
    toolClass: 'write',
    maxBytes: 32 * 1024,
    maxTokens: Math.round((32 * 1024) / BYTES_PER_TOKEN),
    truncationMode: 'tail',
    spillMode: 'inline',
    auditMetadata: true,
  },
  execute: {
    toolClass: 'execute',
    maxBytes: 128 * 1024,
    maxTokens: Math.round((128 * 1024) / BYTES_PER_TOKEN),
    truncationMode: 'head',
    spillMode: 'file',
    auditMetadata: true,
  },
  network: {
    toolClass: 'network',
    maxBytes: 256 * 1024,
    maxTokens: Math.round((256 * 1024) / BYTES_PER_TOKEN),
    truncationMode: 'tail',
    spillMode: 'file',
    auditMetadata: true,
  },
  analyze: {
    toolClass: 'analyze',
    maxBytes: 64 * 1024,
    maxTokens: Math.round((64 * 1024) / BYTES_PER_TOKEN),
    truncationMode: 'tail',
    spillMode: 'inline',
    auditMetadata: true,
  },
};

// ─── Policy Lookup ───────────────────────────────────────────────────────────

/**
 * Returns the output policy for the given tool class.
 * Always returns a defined policy — falls back to the `read` policy if
 * an unrecognised class is supplied (should never happen in strict TypeScript
 * but guards against runtime extension points).
 *
 * @param toolClass - The class of the tool whose policy to retrieve.
 */
export function getPolicy(toolClass: ToolClass): ToolOutputPolicy {
  return DEFAULT_POLICIES[toolClass] ?? DEFAULT_POLICIES.read;
}

// ─── Truncation Helpers ──────────────────────────────────────────────────────

/**
 * Apply the configured truncation mode to `content`, cutting to `maxBytes`.
 * Returns the truncated string.
 */
function truncate(content: string, maxBytes: number, mode: ToolOutputPolicy['truncationMode']): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(content);

  if (encoded.length <= maxBytes) {
    return content;
  }

  // Byte length of the full content (for truncation messages only)
  const byteLen = encoded.length;

  switch (mode) {
    case 'head': {
      // Keep the tail (most recent output) — slice at string level to avoid
      // splitting multi-byte UTF-8 code points that byte-slicing would corrupt.
      const dropChars = Math.floor(content.length * (1 - maxBytes / byteLen));
      const tail = content.slice(dropChars);
      const droppedBytes = byteLen - encoder.encode(tail).length;
      return `[... truncated ${droppedBytes} bytes from start]\n` + tail;
    }
    case 'middle': {
      // Keep equal portions from start and end at string level.
      const keepRatio = maxBytes / byteLen;
      const halfChars = Math.floor((content.length * keepRatio) / 2);
      const start = content.slice(0, halfChars);
      const end = content.slice(content.length - halfChars);
      const dropped = byteLen - encoder.encode(start).length - encoder.encode(end).length;
      return start + `\n[... ${dropped} bytes omitted ...]\n` + end;
    }
    case 'summary':
      // Future: replace with AI-generated summary; fall through to tail for now
      // falls through
    case 'tail':
    default: {
      // Keep the head — slice at string level to avoid corrupting multi-byte chars.
      const keepRatio = maxBytes / byteLen;
      const keepChars = Math.floor(content.length * keepRatio);
      const head = content.slice(0, keepChars);
      const droppedBytes = byteLen - encoder.encode(head).length;
      return head + `\n[... truncated ${droppedBytes} bytes]`;
    }
  }
}

// ─── Policy Enforcement ──────────────────────────────────────────────────────

/**
 * Applies the output policy to a tool result, enforcing byte limits and
 * attaching an audit record.
 *
 * The input `result` is **mutated in place** (output field updated) and also
 * returned as `ToolResultWithAudit` so callers can use the return value
 * directly without re-reading `record.result`.
 *
 * @param result - The raw tool result to enforce limits on.
 * @param policy - The policy to apply (obtain via `getPolicy`).
 * @returns The mutated result with `_policyAudit` attached, plus a standalone
 *          `OutputPolicyResult` audit record.
 */
export function applyOutputPolicy(
  result: ToolResult,
  policy: ToolOutputPolicy,
): { result: ToolResultWithAudit; audit: OutputPolicyResult } {
  const output = typeof result.output === 'string' ? result.output : '';
  const encoder = new TextEncoder();
  const originalSize = encoder.encode(output).length;

  const audit: OutputPolicyResult = {
    policyId: policy.toolClass,
    actionTaken: 'none',
    originalSize,
    resultSize: originalSize,
  };

  const auditResult = result as ToolResultWithAudit;

  // Within limits — no transformation needed
  if (originalSize <= policy.maxBytes) {
    if (policy.auditMetadata) {
      auditResult._policyAudit = audit;
    }
    return { result: auditResult, audit };
  }

  // Over limit — enforce according to spillMode
  switch (policy.spillMode) {
    case 'file': {
      const overflowResult = overflowHandler.handle(output, {
        // Convert bytes to a conservative char estimate (worst-case 4 bytes per
        // UTF-8 char). The overflow handler works in chars, not bytes.
        maxChars: Math.floor(policy.maxBytes / 4),
        label: policy.toolClass,
      });
      result.output = overflowResult.content;
      const actionTaken: OutputPolicyResult['actionTaken'] = overflowResult.overflowRef
        ? 'spilled'
        : 'truncated';
      audit.actionTaken = actionTaken;
      audit.resultSize = encoder.encode(overflowResult.content).length;
      if (overflowResult.spillBackend) {
        audit.spillBackend = overflowResult.spillBackend;
      }
      break;
    }

    case 'reference': {
      const sizeKb = (originalSize / 1024).toFixed(1);
      result.output = `[output omitted: ${sizeKb} KB — ${policy.toolClass} tool output exceeded policy limit of ${policy.maxBytes} bytes]`;
      audit.actionTaken = 'referenced';
      audit.resultSize = encoder.encode(result.output as string).length;
      break;
    }

    case 'inline':
    default: {
      result.output = truncate(output, policy.maxBytes, policy.truncationMode);
      audit.actionTaken = 'truncated';
      audit.resultSize = encoder.encode(result.output as string).length;
      break;
    }
  }

  if (policy.auditMetadata) {
    auditResult._policyAudit = audit;
  }

  return { result: auditResult, audit };
}
