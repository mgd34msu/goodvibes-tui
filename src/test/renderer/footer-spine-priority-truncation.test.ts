/**
 * footer-spine-priority-truncation.test.ts
 *
 * Wave-3 replay defect: the footer's context-info line put the `spine:online`/
 * `spine:offline` segment LAST, so ordinary width pressure clipped it mid-word
 * (e.g. "spi…") — invisible exactly when the daemon-liveness honesty signal
 * matters most. Fix: segments now carry a survival priority. cwd/model are
 * essential (priority 0), spine is a high-value honesty signal (priority 1)
 * ordered ahead of the two decorative segments — tool count (priority 2) and
 * notify mode (priority 3) — which are the first to be dropped WHOLE under
 * width pressure, never character-truncated mid-word.
 */
import { describe, test, expect } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { linesToText } from '../setup.ts';

function footerText(width: number, spine: 'online' | 'offline' | undefined): string {
  const lines = UIFactory.createFooter(
    width,
    '> prompt',
    { up: 0, down: 0 },
    false,               // showExitNotice
    0,                   // lastCopyTime
    'claude-opus-4',     // model
    5,                   // toolCount
    undefined,           // cursorPos
    '/workspace/proj',   // workingDir
    'anthropic',         // provider
    0,                   // contextWindow
    undefined,           // compactThreshold
    false,               // dangerMode
    undefined,           // lastInputTokens
    undefined,           // commandArgsHint
    'balanced',          // hitlMode
    true,                // promptFocused
    undefined,           // composerMode
    undefined,           // composerStatus
    undefined,           // composerFlags
    undefined,           // composerPendingRisk
    false,               // compact
    spine,               // sessionSpineStatus
  );
  return linesToText(lines).join('\n');
}

describe('footer: spine segment survives width pressure', () => {
  test('wide line (200 cols): spine is ordered ahead of the decorative segments', () => {
    const text = footerText(200, 'online');
    expect(text).toContain('spine:online');
    expect(text).toContain('5 tools');
    expect(text).toContain('notify:balanced');
    const spineIdx = text.indexOf('spine:online');
    const toolsIdx = text.indexOf('5 tools');
    const notifyIdx = text.indexOf('notify:balanced');
    expect(spineIdx).toBeLessThan(toolsIdx);
    expect(spineIdx).toBeLessThan(notifyIdx);
  });

  test('narrow line (75 cols): spine renders whole; decorative segments drop whole, not mid-word', () => {
    const text = footerText(75, 'online');
    // The full spine marker must be intact — never clipped to e.g. "spi…".
    expect(text).toContain('spine:online');
    expect(text).not.toContain('spi…');
    // The decorative segments are dropped ENTIRELY at this width, not left as
    // a truncated fragment (e.g. "5 t…" or "notif…").
    expect(text).not.toContain('tools');
    expect(text).not.toContain('notify');
    // The essential cwd/model segments still survive alongside spine.
    expect(text).toContain('/workspace/proj');
    expect(text).toContain('claude-opus-4');
  });

  test('narrow line (75 cols), offline: spine renders whole and uncorrupted', () => {
    const text = footerText(75, 'offline');
    expect(text).toContain('spine:offline');
    expect(text).not.toContain('spi…');
  });
});
