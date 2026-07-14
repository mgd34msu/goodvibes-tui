import { describe, expect, test } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { linesToText } from '../setup.ts';

// ---------------------------------------------------------------------------
// STEP 3 — the always-visible "sleep disabled" chip in the footer posture
// block (the danger-mode idiom), present only while power.keepAwake holds.
// Full-string render at 80x24 and 60 columns, both states.
// ---------------------------------------------------------------------------

function footerText(width: number, powerKeepAwake: boolean): string {
  const lines = UIFactory.createFooter(
    width,
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
    false,             // dangerMode
    undefined,         // lastInputTokens
    undefined,         // commandArgsHint
    'balanced',        // hitlMode
    true,              // promptFocused
    undefined,         // composerMode
    undefined,         // composerStatus
    undefined,         // composerFlags
    undefined,         // composerPendingRisk
    false,             // compact
    undefined,         // sessionSpineStatus
    'normal',          // permissionMode
    undefined,         // webSurfaceUrl
    powerKeepAwake,    // powerKeepAwake
  );
  return linesToText(lines).join('\n');
}

describe('footer "sleep disabled" chip (STEP 3)', () => {
  test('80 columns, keep-awake ON: the chip is visible', () => {
    expect(footerText(80, true)).toContain('sleep disabled');
  });

  test('80 columns, keep-awake OFF: no chip', () => {
    expect(footerText(80, false)).not.toContain('sleep disabled');
  });

  test('60 columns, keep-awake ON: the chip is still visible (not clipped away)', () => {
    expect(footerText(60, true)).toContain('sleep disabled');
  });

  test('60 columns, keep-awake OFF: no chip', () => {
    expect(footerText(60, false)).not.toContain('sleep disabled');
  });
});
