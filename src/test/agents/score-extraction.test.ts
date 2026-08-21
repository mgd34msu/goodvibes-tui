import { describe, test, expect } from 'bun:test';
import {
  extractScoreFromText,
  extractPassedFromText,
  extractIssuesFromText,
} from '@pellux/goodvibes-sdk/platform/agents';

// ---------------------------------------------------------------------------
// extractScoreFromText
// ---------------------------------------------------------------------------

describe('extractScoreFromText', () => {
  test('extracts "Score: X/10" pattern', () => {
    expect(extractScoreFromText('Score: 8/10')).toBe(8);
  });

  test('extracts "Score: X.X/10" pattern', () => {
    expect(extractScoreFromText('Score: 8.5/10')).toBe(8.5);
  });

  test('extracts bold markdown "**Score: X.X/10**"', () => {
    expect(extractScoreFromText('**Score: 9.2/10**')).toBe(9.2);
  });

  test('extracts "Overall Score: X/10"', () => {
    expect(extractScoreFromText('Overall Score: 7/10')).toBe(7);
  });

  test('extracts standalone "X/10" pattern', () => {
    expect(extractScoreFromText('This implementation deserves 9/10.')).toBe(9);
  });

  test('extracts "X.X/10" standalone', () => {
    expect(extractScoreFromText('Rating: 8.1 out of 10\n\nFinal: 8.1/10')).toBe(8.1);
  });

  test('extracts "scored X" pattern', () => {
    expect(extractScoreFromText('This code scored 8.5 overall.')).toBe(8.5);
  });

  test('extracts "rated X" pattern', () => {
    expect(extractScoreFromText('I rated 7 for this implementation.')).toBe(7);
  });

  test('extracts "rating: X" pattern', () => {
    expect(extractScoreFromText('rating: 6.5')).toBe(6.5);
  });

  test('ignores rated pattern if value > 10', () => {
    // "scored 42" is nonsensical for a /10 scale, should not match via pattern 3
    // but pattern 2 (X/10) would only match if followed by /10
    expect(extractScoreFromText('scored 42 goals')).toBeNull();
  });

  test('returns null for "42/10" (value > 10 in slash pattern)', () => {
    expect(extractScoreFromText('42/10')).toBeNull();
  });

  test('returns null for "rate 5 requests per second" (partial word match)', () => {
    expect(extractScoreFromText('rate 5 requests per second')).toBeNull();
  });

  test('returns null for text with no score', () => {
    expect(extractScoreFromText('The implementation looks correct.')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(extractScoreFromText('')).toBeNull();
  });

  test('score: 0/10 is a valid score (returns 0)', () => {
    expect(extractScoreFromText('Score: 0/10')).toBe(0);
  });

  test('score: 10/10 is valid', () => {
    expect(extractScoreFromText('Score: 10/10')).toBe(10);
  });

  test('returns null for "Score: 42/10" (labeled pattern, value > 10)', () => {
    expect(extractScoreFromText('Score: 42/10')).toBeNull();
  });

  test('prefers pattern 1 (Score: X/10) over standalone X/10', () => {
    // Text has both, pattern 1 should win and return the first match
    const text = 'Score: 9/10. The implementation is 8/10 on style.';
    expect(extractScoreFromText(text)).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// extractPassedFromText
// ---------------------------------------------------------------------------

describe('extractPassedFromText', () => {
  test('returns true when score >= threshold', () => {
    expect(extractPassedFromText('anything', 8.5, 7)).toBe(true);
  });

  test('returns false when score < threshold and no pass language', () => {
    expect(extractPassedFromText('The code has many issues.', 5, 7)).toBe(false);
  });

  // As of goodvibes-sdk 0.33.37+, pass/fail is score-driven: prose can no
  // longer lift a sub-threshold score to a pass. Explicit fail language
  // remains a safety override that can force a fail even when score clears.
  test('sub-threshold score fails even when text contains "passed"', () => {
    expect(extractPassedFromText('The review passed all criteria.', 5, 7)).toBe(false);
  });

  test('sub-threshold score fails even when text contains "approved"', () => {
    expect(extractPassedFromText('Approved for merge.', 5, 7)).toBe(false);
  });

  test('sub-threshold score fails for "passes" variant', () => {
    expect(extractPassedFromText('This passes the quality bar.', 5, 7)).toBe(false);
  });

  test('sub-threshold score fails for "passing" variant', () => {
    expect(extractPassedFromText('Currently passing minimum threshold.', 5, 7)).toBe(false);
  });

  test('passing score with explicit fail language is overridden to fail', () => {
    expect(extractPassedFromText('The review failed on critical issues.', 8, 7)).toBe(false);
  });

  test('passing score with mixed pass/fail language stays a pass', () => {
    expect(extractPassedFromText('The test passed but one check failed.', 8, 7)).toBe(true);
  });

  test('exact threshold boundary: score === threshold returns true', () => {
    expect(extractPassedFromText('nothing special', 7, 7)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractIssuesFromText
// ---------------------------------------------------------------------------

describe('extractIssuesFromText', () => {
  test('extracts numbered list with bracket severity', () => {
    const text = '1. [critical] Null pointer dereference\n2. [major] Missing error handling';
    const issues = extractIssuesFromText(text);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ severity: 'critical', description: 'Null pointer dereference', pointValue: 3 });
    expect(issues[1]).toMatchObject({ severity: 'major', description: 'Missing error handling', pointValue: 2 });
  });

  test('extracts bullet list with bracket severity', () => {
    const text = '- [minor] Inconsistent naming\n- [suggestion] Consider extracting function';
    const issues = extractIssuesFromText(text);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ severity: 'minor', pointValue: 1 });
    expect(issues[1]).toMatchObject({ severity: 'suggestion', pointValue: 1 });
  });

  test('assigns correct pointValues', () => {
    const text = '1. [critical] A\n2. [major] B\n3. [minor] C\n4. [suggestion] D';
    const issues = extractIssuesFromText(text);
    expect(issues.map(i => i.pointValue)).toEqual([3, 2, 1, 1]);
  });

  test('returns empty array when no issues found', () => {
    expect(extractIssuesFromText('Everything looks great!')).toEqual([]);
  });

  test('returns empty array for empty string', () => {
    expect(extractIssuesFromText('')).toEqual([]);
  });

  test('extracts bold markdown "**Critical:** description"', () => {
    const text = '**Critical:** Null pointer dereference';
    const issues = extractIssuesFromText(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'critical', description: 'Null pointer dereference' });
  });

  test('extracts parenthetical "- (major) description"', () => {
    const text = '- (major) Missing validation';
    const issues = extractIssuesFromText(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'major', description: 'Missing validation' });
  });

  test('is case-insensitive for severity labels', () => {
    const text = '1. [CRITICAL] Big problem\n2. [Major] Medium issue';
    const issues = extractIssuesFromText(text);
    expect(issues[0].severity).toBe('critical');
    expect(issues[1].severity).toBe('major');
  });
});
