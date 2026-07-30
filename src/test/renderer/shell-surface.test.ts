import { describe, expect, test } from 'bun:test';
import { buildShellFooter, estimateShellFooterHeight } from '../../renderer/shell-surface.ts';
import type { VoiceCaptureIndicatorState } from '../../core/voice-capture-status.ts';
import { lineToString } from '../setup.ts';

describe('shell surface', () => {
  test('estimated footer height matches rendered footer height without context bar', () => {
    const result = buildShellFooter({
      width: 100,
      promptText: 'hello',
      promptLineCount: 1,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 0,
      runningProcessCount: 0,
      indicatorFocused: false,
    });
    expect(result.height).toBe(estimateShellFooterHeight(1, 0));
  });

  test('estimated footer height matches rendered footer height with context bar', () => {
    const result = buildShellFooter({
      width: 100,
      promptText: 'hello\nworld',
      promptLineCount: 2,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'claude-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'anthropic',
      contextWindow: 200000,
      lastInputTokens: 1024,
      runningAgentCount: 1,
      runningProcessCount: 0,
      indicatorFocused: false,
      runningAgentProgress: 'Turn 2',
    });
    expect(result.height).toBe(estimateShellFooterHeight(2, 200000));
  });

  test('process indicator sits directly below the prompt box', () => {
    const result = buildShellFooter({
      width: 100,
      promptText: 'hello\nworld',
      promptLineCount: 2,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 1,
      runningProcessCount: 0,
      indicatorFocused: false,
      runningAgentProgress: 'Turn 2',
    });
    expect(lineToString(result.lines[4])).toContain('1 agent');
  });

  test('prompt box keeps half-height top and bottom borders', () => {
    const result = buildShellFooter({
      width: 80,
      promptText: 'hello',
      promptLineCount: 1,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 0,
      runningProcessCount: 0,
      indicatorFocused: false,
    });
    expect(lineToString(result.lines[0])).toContain('▄');
    expect(lineToString(result.lines[2])).toContain('▀');
  });

  test('composer posture line surfaces mode and pending risk without bloating the footer', () => {
    const result = buildShellFooter({
      width: 100,
      promptText: 'hello',
      promptLineCount: 1,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 0,
      runningProcessCount: 0,
      indicatorFocused: false,
      composerMode: 'shell',
      composerStatus: 'preflight',
      composerFlags: ['approval'],
      composerPendingRisk: 'shell',
    });
    const text = result.lines.map(lineToString).join('\n');
    expect(text).toContain('risk:shell');
    expect(text).toContain('state:preflight');
    expect(text).toContain('flags:approval');
  });

  test('prompt box visibly loses focus when the indicator is focused', () => {
    const focused = buildShellFooter({
      width: 80,
      promptText: 'hello',
      promptLineCount: 1,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 1,
      runningProcessCount: 0,
      indicatorFocused: false,
    });
    const unfocused = buildShellFooter({
      width: 80,
      promptText: 'hello',
      promptLineCount: 1,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 1,
      runningProcessCount: 0,
      indicatorFocused: true,
    });
    expect(lineToString(focused.lines[1])).toContain('›');
    expect(lineToString(unfocused.lines[1])).toContain('›');
    expect(focused.lines[1]![4]!.bg).toBe('#2a2a2a');
    expect(unfocused.lines[1]![4]!.bg).toBe('#1f2430');
    expect(lineToString(unfocused.lines[1])).not.toContain('█');
  });

  test('estimate keys its cache on compact mode so a compact render does not answer a non-compact query', () => {
    // Render a compact footer first — this populates the "last rendered
    // footer height" fast path in estimateShellFooterHeight with the
    // compact height (no process indicator, no context-info line).
    const compactResult = buildShellFooter({
      width: 100,
      promptText: 'hello',
      promptLineCount: 1,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 0,
      runningProcessCount: 0,
      indicatorFocused: false,
      compact: true,
    });
    // A caller asking for the NON-compact estimate right after (e.g. the
    // viewport-height calc reacting to a resize back to a tall terminal)
    // must get the non-compact formula, not the stale compact-render cache.
    expect(estimateShellFooterHeight(1, 0, false)).not.toBe(compactResult.height);
    expect(estimateShellFooterHeight(1, 0, false)).toBe(estimateShellFooterHeight(2, 0, false) - 1);

    // And the reverse: a non-compact render must not leak into a compact query.
    const nonCompactResult = buildShellFooter({
      width: 100,
      promptText: 'hello',
      promptLineCount: 1,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 0,
      runningProcessCount: 0,
      indicatorFocused: false,
      compact: false,
    });
    expect(estimateShellFooterHeight(1, 0, true)).not.toBe(nonCompactResult.height);
    expect(estimateShellFooterHeight(1, 0, true)).toBe(compactResult.height);
  });

  test('prompt box visibly loses focus when the panel workspace is focused, independent of indicatorFocused', () => {
    // sub-fix C: panelFocused is a fallback-only input to buildShellFooter
    // (main.ts computes promptFocused itself and passes it explicitly), but the
    // fallback must still agree so any caller that omits promptFocused gets a
    // composer that doesn't contradict the panel's own (correctly wired) focus
    // border.
    const panelFocused = buildShellFooter({
      width: 80,
      promptText: 'hello',
      promptLineCount: 1,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 1,
      runningProcessCount: 0,
      indicatorFocused: false,
      panelFocused: true,
    });
    const neitherFocused = buildShellFooter({
      width: 80,
      promptText: 'hello',
      promptLineCount: 1,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 1,
      runningProcessCount: 0,
      indicatorFocused: false,
      panelFocused: false,
    });
    expect(panelFocused.lines[1]![4]!.bg).toBe('#1f2430');
    expect(neitherFocused.lines[1]![4]!.bg).toBe('#2a2a2a');
    expect(lineToString(panelFocused.lines[1])).not.toContain('█');
  });

  test('an explicit promptFocused wins over the panelFocused/indicatorFocused fallback', () => {
    const result = buildShellFooter({
      width: 80,
      promptText: 'hello',
      promptLineCount: 1,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 1,
      runningProcessCount: 0,
      indicatorFocused: false,
      panelFocused: true,
      promptFocused: true,
    });
    expect(result.lines[1]![4]!.bg).toBe('#2a2a2a');
  });

  // item 1c: an unfocused, EMPTY composer names the state and the way
  // back — the dimmed fill alone told you nothing was wrong, but not why
  // keystrokes weren't landing there.
  test('an unfocused, empty composer shows the "panel focused — Esc returns" hint', () => {
    const unfocusedEmpty = buildShellFooter({
      width: 80,
      promptText: '',
      promptLineCount: 1,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 1,
      runningProcessCount: 0,
      indicatorFocused: false,
      panelFocused: true,
    });
    expect(lineToString(unfocusedEmpty.lines[1])).toContain('panel focused — Esc returns');
  });

  test('the hint never appears when the composer is focused, or when it holds real (non-empty) text', () => {
    const focusedEmpty = buildShellFooter({
      width: 80,
      promptText: '',
      promptLineCount: 1,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 0,
      runningProcessCount: 0,
      indicatorFocused: false,
      panelFocused: false,
    });
    expect(lineToString(focusedEmpty.lines[1])).not.toContain('panel focused');

    const unfocusedWithLeftoverText = buildShellFooter({
      width: 80,
      promptText: 'hello',
      promptLineCount: 1,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 0,
      runningProcessCount: 0,
      indicatorFocused: false,
      panelFocused: true,
    });
    expect(lineToString(unfocusedWithLeftoverText.lines[1])).not.toContain('panel focused');
  });

  test('prompt box borders match the inactive prompt fill when the indicator is focused', () => {
    const result = buildShellFooter({
      width: 80,
      promptText: 'hello',
      promptLineCount: 1,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 1,
      runningProcessCount: 0,
      indicatorFocused: true,
    });
    const topBorderCells = result.lines[0]!.filter((cell) => cell.char === '▄');
    const bottomBorderCells = result.lines[2]!.filter((cell) => cell.char === '▀');

    expect(topBorderCells.length).toBeGreaterThan(0);
    expect(bottomBorderCells.length).toBeGreaterThan(0);
    expect(topBorderCells.every((cell) => cell.fg === '#1f2430')).toBe(true);
    expect(bottomBorderCells.every((cell) => cell.fg === '#1f2430')).toBe(true);
  });
});

/**
 * The live-microphone row. It is the only thing on screen that tells a user a
 * capture device is open, so its presence, its wording and its absence when the
 * feature is off are all asserted rather than assumed.
 */
describe('shell surface — the live microphone row', () => {
  function footerWith(voiceCapture: VoiceCaptureIndicatorState | null): ReturnType<typeof buildShellFooter> {
    return buildShellFooter({
      width: 100,
      promptText: 'hello',
      promptLineCount: 1,
      usage: { up: 0, down: 0 },
      showExitNotice: false,
      lastCopyTime: 0,
      model: 'gpt-test',
      toolCount: 3,
      workingDir: '/tmp/demo',
      provider: 'openai',
      contextWindow: 0,
      runningAgentCount: 0,
      runningProcessCount: 0,
      indicatorFocused: false,
      voiceCapture,
    });
  }

  test('no row at all when nothing is captured', () => {
    const withRow = footerWith({ kind: 'wake-listening', deviceLabel: 'parecord', indicator: 'statusline' });
    const without = footerWith(null);
    expect(without.height).toBe(withRow.height - 1);
    expect(without.lines.map(lineToString).join('\n')).not.toContain('Voice:');
  });

  test('the wake row sits directly below the prompt box, above the process indicator', () => {
    const result = footerWith({ kind: 'wake-listening', deviceLabel: 'parecord', indicator: 'statusline' });
    // Rows 0..2 are the prompt box (top border, prompt, bottom border).
    expect(lineToString(result.lines[3]!)).toContain('Voice: listening for the wake phrase');
    expect(lineToString(result.lines[3]!)).toContain('parecord');
    expect(lineToString(result.lines[4]!)).toContain('No background processes');
  });

  test('voice.wake.indicator off suppresses the wake row entirely', () => {
    const result = footerWith({ kind: 'wake-listening', deviceLabel: 'parecord', indicator: 'off' });
    expect(result.lines.map(lineToString).join('\n')).not.toContain('Voice:');
    expect(result.height).toBe(estimateShellFooterHeight(1, 0, false, null));
  });

  test('a push-to-talk recording renders even when the wake indicator is off — the user just pressed the key', () => {
    const result = footerWith({ kind: 'recording', deviceLabel: 'pw-record', indicator: 'off', detail: '3s' });
    const text = result.lines.map(lineToString).join('\n');
    expect(text).toContain('Voice: recording — press the voice-input key again to stop');
    expect(text).toContain('3s');
  });

  test('the banner variant fills the row width so it reads as a standing condition', () => {
    const statusline = footerWith({ kind: 'wake-listening', deviceLabel: 'parecord', indicator: 'statusline' });
    const banner = footerWith({ kind: 'wake-listening', deviceLabel: 'parecord', indicator: 'banner' });
    // Same one row either way; the difference is the painted background.
    expect(banner.height).toBe(statusline.height);
    const bannerBg = banner.lines[3]!.filter((cell) => cell.bg !== '' && cell.bg !== undefined);
    const statuslineBg = statusline.lines[3]!.filter((cell) => cell.bg !== '' && cell.bg !== undefined);
    expect(bannerBg.length).toBeGreaterThan(statuslineBg.length);
    expect(lineToString(banner.lines[3]!)).toContain('listening for the wake phrase');
  });

  test('a latched detector says it stopped, and carries the reason', () => {
    const result = footerWith({
      kind: 'wake-latched',
      deviceLabel: null,
      indicator: 'statusline',
      detail: 'crashed 2 times within 60s',
    });
    const text = lineToString(result.lines[3]!);
    expect(text).toContain('Voice: wake detection stopped');
    expect(text).toContain('crashed 2 times within 60s');
  });

  test('the estimate accounts for the row on the cold-start path', () => {
    const state: VoiceCaptureIndicatorState = { kind: 'wake-listening', deviceLabel: 'parecord', indicator: 'statusline' };
    expect(footerWith(state).height).toBe(estimateShellFooterHeight(1, 0, false, state));
  });
});
