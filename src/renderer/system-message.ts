import { type Line } from '@pellux/goodvibes-sdk/platform/types';
import { BORDERS } from './layout.ts';
import { renderConversationNotice } from './conversation-surface.ts';
import { activeUiTones } from './theme.ts';

/** Exported for use by typeOverride callers and tests. */
export type SystemMessageType = 'error' | 'warning' | 'info';

const FAILURE_MARKERS = ['✗', '\u2717'] as const;

export function classifySystemMessage(content: string): SystemMessageType {
  // Bracket-prefixed messages: classify by prefix first to prevent task
  // descriptions (which may contain words like "error" or "failed") from
  // incorrectly coloring status messages as red.

  // [WRFC] messages
  if (/^\[WRFC\]/.test(content)) {
    // Failed gate result → error (red) — must be checked before generic FAILED
    if (/Gate:.*FAILED/i.test(content)) return 'error';
    // Hard failures and cascade aborts → error (red)
    if (/FAILED|cascade abort/i.test(content)) return 'error';
    // Review failed to reach threshold → warning (yellow, retry in progress)
    if (/spawning a fix agent/i.test(content)) return 'warning';
    // All other WRFC messages (started, passed, auto-committed, gate passed, review ok) → info
    return 'info';
  }

  // [Agents] messages
  if (/^\[Agents\]/.test(content)) {
    // ✗ individual agent failure → error (red)
    if (FAILURE_MARKERS.some((marker) => content.startsWith(`[Agents] ${marker}`))) return 'error';
    // Cohort summary: warn only if ≥1 agent failed, otherwise info
    if (/^\[Agents\] Cohort/.test(content)) {
      return /\b[1-9]\d* failed\b/.test(content) ? 'warning' : 'info';
    }
    // All other [Agents] messages (running, ✓ completed) → info
    return 'info';
  }

  // [Plan] messages are always informational
  if (/^\[Plan\]/.test(content)) return 'info';

  // [Model] messages — "Unknown model" is a warning, switch is info
  if (/^\[Model\]/.test(content)) {
    if (/Unknown model/i.test(content)) return 'warning';
    return 'info';
  }

  // [Routing] chip — a mid-session model change is informational (the [Failover]
  // line, not this, carries the alarming transport-error cases).
  if (/^\[Routing\]/.test(content)) return 'info';

  // [Local] and [Recovery] messages
  if (/^\[Local\]/.test(content)) return 'info';
  if (/^\[Recovery\]/.test(content)) {
    if (/Failed to restore/i.test(content)) return 'error';
    return 'info';
  }

  // Generic messages: strip quoted substrings before keyword scan to avoid
  // false positives from task descriptions like "Fix the error in auth.ts".
  const stripped = content.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"..."');
  // error: catches runtime failures, permission denials, crash and variants (crashed, crashing, etc.), unhandled exceptions
  if (/\b(error|failed|denied|crash\w*|exception)\b/i.test(stripped)) return 'error';
  // warning: catches advisory notices, high-usage alerts, deprecation notices
  if (/\b(warning|context usage|caution|deprecated)\b/i.test(stripped)) return 'warning';
  return 'info';
}

/**
 * Render a system message with a colored left border.
 */
export function renderSystemMessage(
  content: string,
  width: number,
  typeOverride?: SystemMessageType,
): Line[] {
  const msgType = typeOverride ?? classifySystemMessage(content);
  // System-message notices paint the ▌ marker and body text on the TRANSPARENT
  // terminal background (renderConversationNotice passes no bodyBg), so the
  // accent and dim text resolve per-render through activeUiTones() to stay
  // legible on a light terminal. Dark values are byte-identical to the prior
  // static reads (chrome.bad == state.bad, chrome.warn == state.warn,
  // state.info unchanged, chrome.faint == fg.dim). The ▌ marker glyph is still
  // sourced from the BORDERS table.
  const t = activeUiTones();
  const border = msgType === 'error' ? BORDERS.ERROR
    : msgType === 'warning' ? BORDERS.WARNING
    : BORDERS.INFO;
  const accent = msgType === 'error' ? t.chrome.bad
    : msgType === 'warning' ? t.chrome.warn
    : t.state.info;
  const textColor = msgType === 'info' ? t.chrome.faint : accent;
  return renderConversationNotice(content, width, {
    accent,
    text: textColor,
    dim: msgType === 'info',
  }, border.char);
}
