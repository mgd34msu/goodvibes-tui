/**
 * The footer's `hitl:${hitlMode}` context-line label shared
 * vocabulary with tool-approval risk, but /mode (aliased /hitl) only governs
 * UX notification verbosity (quiet/balanced/operator), not auto-approval.
 * A user with hitlMode: 'operator' (careful supervision) could see
 * "! DANGER MODE - ALL CHANGES AUTO-APPROVED" rendered right next to a label
 * that reads as if it's about the same axis. Renamed to `notify:` so it no
 * longer contradicts the DANGER MODE banner.
 */
import { describe, test, expect } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { linesToText } from '../setup.ts';

const W = 120;

function buildFooterLines(dangerMode: boolean, hitlMode: string | undefined): string[] {
  const lines = UIFactory.createFooter(
    W,
    '> prompt',
    { up: 0, down: 0 },
    false,             // showExitNotice
    0,                 // lastCopyTime
    'claude-opus-4',   // model
    5,                 // toolCount
    undefined,         // cursorPos
    '/workspace/proj', // workingDir
    'anthropic',       // provider
    0,                 // contextWindow
    undefined,         // compactThreshold
    dangerMode,
    undefined,         // lastInputTokens
    undefined,         // commandArgsHint
    hitlMode,
  );
  return linesToText(lines);
}

describe('footer: notify label vs DANGER MODE banner', () => {
  test('the hitl-mode context label no longer uses "hitl:" vocabulary', () => {
    const text = buildFooterLines(false, 'operator').join('\n');
    expect(text).not.toContain('hitl:');
    expect(text).toContain('notify:operator');
  });

  test('DANGER MODE banner and the notify label can render together without contradicting each other', () => {
    const text = buildFooterLines(true, 'operator').join('\n');
    expect(text).toContain('DANGER MODE');
    expect(text).toContain('notify:operator');
    expect(text).not.toContain('hitl:');
  });
});
