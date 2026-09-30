/**
 * The terminal's own review-chain lines read under plain titles in the
 * notification history (ui-live-run-9 item 2). The lines below are built
 * from the same templates runtime/bootstrap-core.ts and
 * runtime/wrfc-persistence.ts use.
 */
import { describe, expect, test } from 'bun:test';
import { shellChainNoticeOf } from '../../core/wrfc-notice-titles.ts';
import { publishNotice } from '../../core/notices.ts';
import { NotificationFeed } from '../../views/notifications-feed.ts';

const LINES: Array<[line: string, title: string]> = [
  ['[WRFC] Engineer enumerated 1 constraint for chain wrfc-ac4cd7f', 'Review chain constraints listed'],
  ['[WRFC] Fix #2 targeting 3 constraints on chain wrfc-ac4cd7f', 'Review chain fix started'],
  ['[WRFC] ✗ Chain wrfc-ac4cd7f: 2 constraint violations forced failure', 'Review chain failed its constraints'],
  ['[WRFC] Guard: reviewMode explicitly set to wrfc; task: "In src/retry.ts change delayFor" (spawn-forced-wrfc)', 'Agent request sent through a review chain'],
  ['[WRFC] Guard: nested WRFC chain suppressed; task: "x" (spawn-suppressed-wrfc)', 'Agent request kept out of a review chain'],
  ['[WRFC] Guard: 3 spawns collapsed; task: "x" (batch-collapsed-to-wrfc)', 'Agent requests combined into one review chain'],
  ["[WRFC] Chain wrfc-ac4cd7f (Cap the retry delay) was interrupted by a restart; state was 'reviewing' after 1 review cycle", 'Review chain interrupted by a restart'],
  ['[WRFC] Pre-router buffer overflowed: 3 earliest messages were dropped', 'Early review chain messages dropped'],
];

describe("the terminal's own review-chain lines", () => {
  for (const [line, title] of LINES) {
    test(`"${line.slice(0, 48)}…" reads "${title}"`, () => {
      const notice = shellChainNoticeOf(line);
      expect(notice?.title).toBe(title);
      expect(notice?.detail.startsWith('[')).toBe(false);
      const feed = new NotificationFeed();
      publishNotice(feed, line, { now: () => 1 });
      expect(feed.list().map((entry) => entry.title)).toEqual([title]);
    });
  }

  test('other lines are left as they are', () => {
    expect(shellChainNoticeOf('[Failover] Restored abacusai:route-llm for the next turn.')).toBeUndefined();
  });
});
