// ---------------------------------------------------------------------------
// kit-modal-audit.test.ts, the design's layout audit over every modal this
// batch draws with the modal surface kit: nothing past the screen edge, 2
// columns of side padding for text inside any fill, an empty first and last
// row in every fill block of 3+ rows, and ┃ bars spanning their block, at
// 100x24, 80x24 and 140x40, plus the hostile 28-wide screen (no crash).
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { auditLayer, formatIssues } from '../helpers/kit-audit.ts';
import { buildKitFrames } from '../helpers/kit-modal-fixtures.ts';

const SIZES = [
  [100, 24],
  [80, 24],
  [140, 40],
] as const;

describe('kit modal layout audit', () => {
  for (const [W, H] of SIZES) {
    test(`every frame passes the audit at ${W}x${H}`, async () => {
      const frames = await buildKitFrames(W, H);
      const report = frames
        .map((frame) => formatIssues(`${frame.name}@${W}x${H}`, auditLayer(frame.layer, W, H)))
        .filter(Boolean)
        .join('\n');
      expect(report).toBe('');
    });
  }

  test('every frame renders at the hostile 28-wide size without leaving the screen', async () => {
    const frames = await buildKitFrames(28, 40);
    for (const frame of frames) {
      const offscreen = auditLayer(frame.layer, 28, 40).filter((issue) => issue.kind === 'OFFSCREEN');
      expect(formatIssues(frame.name, offscreen)).toBe('');
    }
  });
});
