/**
 * wrfc-notice-titles.ts, the plain title of each review-chain line this
 * terminal writes itself.
 *
 * runtime/bootstrap-core.ts and runtime/wrfc-persistence.ts write a few
 * "[WRFC] …" lines of their own (the SDK's lines are titled by its
 * runtimeEventOfNotice). The notification history keeps each such event as
 * one entry under a plain title, with the line's detail as the body
 * (core/notices.ts). The test feeds every producer's template through
 * shellChainNoticeOf so the lines and this table cannot drift apart.
 */

export interface ShellChainNotice {
  readonly title: string;
  readonly level: 'info' | 'warning';
  /** The line without its bracket tag or status mark. */
  readonly detail: string;
}

const SHELL_CHAIN_LINES: ReadonlyArray<{ readonly pattern: RegExp; readonly title: string; readonly level: ShellChainNotice['level'] }> = [
  { pattern: /^\[WRFC\] Engineer enumerated \d+ constraints? for chain \S+/, title: 'Review chain constraints listed', level: 'info' },
  { pattern: /^\[WRFC\] Fix #\d+ targeting \d+ constraints? on chain \S+/, title: 'Review chain fix started', level: 'info' },
  { pattern: /^\[WRFC\] ✗ Chain \S+: \d+ constraint violations? forced failure/, title: 'Review chain failed its constraints', level: 'warning' },
  { pattern: /^\[WRFC\] Guard: .*\(spawn-forced-wrfc\)$/s, title: 'Agent request sent through a review chain', level: 'info' },
  { pattern: /^\[WRFC\] Guard: .*\(spawn-suppressed-wrfc\)$/s, title: 'Agent request kept out of a review chain', level: 'info' },
  { pattern: /^\[WRFC\] Guard: .*\(batch-collapsed-to-wrfc\)$/s, title: 'Agent requests combined into one review chain', level: 'info' },
  { pattern: /^\[WRFC\] Chain \S+ \(.*\) was interrupted by a restart; /s, title: 'Review chain interrupted by a restart', level: 'warning' },
  { pattern: /^\[WRFC\] Pre-router buffer overflowed: /, title: 'Early review chain messages dropped', level: 'warning' },
];

/** The plain title of a review-chain line this terminal writes, or undefined for any other line. */
export function shellChainNoticeOf(text: string): ShellChainNotice | undefined {
  const line = text.trim();
  const match = SHELL_CHAIN_LINES.find((entry) => entry.pattern.test(line));
  if (!match) return undefined;
  return { title: match.title, level: match.level, detail: line.replace(/^\[WRFC\]\s*/, '').replace(/^✗\s*/, '') };
}
