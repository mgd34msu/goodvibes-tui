/**
 * footer-spine-segment.test.ts
 *
 * S3d: the footer's context-info line carries a `spine:online` / `spine:offline`
 * segment ONLY in adopted-daemon mode (when sessionSpineStatus is defined).
 * Embedded/local mode (undefined) renders no segment — plain words, no blame,
 * matching the repo's `notify:`/`N tools` context-segment style.
 */
import { describe, test, expect } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { linesToText } from '../setup.ts';

const W = 120;

function footerText(spine: 'online' | 'offline' | undefined): string {
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
    spine,             // sessionSpineStatus
  );
  return linesToText(lines).join('\n');
}

describe('footer: cross-surface spine segment per daemon mode', () => {
  test('adopted-online: renders "spine:online"', () => {
    const text = footerText('online');
    expect(text).toContain('spine:online');
    expect(text).not.toContain('spine:offline');
  });

  test('adopted-offline: renders "spine:offline"', () => {
    const text = footerText('offline');
    expect(text).toContain('spine:offline');
    expect(text).not.toContain('spine:online');
  });

  test('embedded/local mode (undefined): no spine segment at all', () => {
    const text = footerText(undefined);
    expect(text).not.toContain('spine:');
  });
});
