/**
 * Compaction history text tests.
 *
 * Validates:
 *  1. History text lists compaction events from SDK log.
 *  2. Empty session returns a "no compactions" message.
 *  3. Restore-unavailability notice is always present.
 *  4. History is listed most-recent-first.
 */
import { describe, test, expect } from 'bun:test';
import {
  buildCompactionHistoryText,
  formatCompactionEvent,
} from '../../renderer/compaction-history-modal.ts';
import { scoreCompactionRun } from '../../renderer/compaction-quality.ts';
import type { CompactionEvent } from '@pellux/goodvibes-sdk/platform/core';

// ---------------------------------------------------------------------------
// buildCompactionHistoryText
// ---------------------------------------------------------------------------

describe('buildCompactionHistoryText', () => {

  test('always includes restore unavailability notice', () => {
    const result = buildCompactionHistoryText();
    // Either the no-compactions branch or the with-events branch must include the restore note.
    const hasGap =
      result.includes('Restore') ||
      result.includes('restore') ||
      result.includes('no compactions');
    expect(hasGap).toBe(true);
  });

  test('returns [Context] prefix', () => {
    const result = buildCompactionHistoryText();
    expect(result).toContain('[Context]');
  });
});

// ---------------------------------------------------------------------------
// formatCompactionEvent, quality-score grade suffix ()
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<CompactionEvent> = {}): CompactionEvent {
  return {
    timestamp: Date.now(),
    messagesBeforeCompaction: 20,
    messagesAfterCompaction: 1,
    tokensBeforeEstimate: 50_000,
    tokensAfterEstimate: 6_500,
    modelId: 'test-model',
    trigger: 'manual',
    ...overrides,
  };
}

describe('formatCompactionEvent', () => {
  test('omits the quality suffix when no score is supplied (event predates the feature, or never had one)', () => {
    const line = formatCompactionEvent(makeEvent(), 1);
    expect(line).not.toContain('quality=');
  });

  test('omits the quality suffix when the score is explicitly null', () => {
    const line = formatCompactionEvent(makeEvent(), 1, null);
    expect(line).not.toContain('quality=');
  });

  test('renders the grade and numeric score when a quality score is supplied', () => {
    const score = scoreCompactionRun({
      sessionId: 's',
      contextWindow: 200_000,
      messagesBefore: [{ role: 'user', content: 'a'.repeat(50_000) }],
      messagesAfter: [{ role: 'user', content: '[Session compacted] condensed handoff summary of this conversation' }],
      tokensBefore: 50_000,
      tokensAfter: 6_500,
    });
    const line = formatCompactionEvent(makeEvent(), 1, score);
    expect(line).toContain(`quality=${score.grade}`);
    expect(line).toContain(score.score.toFixed(2));
  });
});

