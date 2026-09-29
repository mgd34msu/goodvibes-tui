import { describe, expect, test } from 'bun:test';
import { buildShellFooter, estimateShellFooterHeight, type ShellFooterBuildOptions } from '../../renderer/shell-surface.ts';
import type { VoiceCaptureIndicatorState } from '../../core/voice-capture-status.ts';
import { lineToString } from '../setup.ts';
import { activeTokens } from '../../renderer/theme.ts';
import { auditFrame } from '../helpers/frame-audit.ts';

function footer(overrides: Partial<ShellFooterBuildOptions> = {}): ReturnType<typeof buildShellFooter> {
  return buildShellFooter({
    width: 100,
    promptText: 'hello',
    promptLineCount: 1,
    promptCursorPos: 5,
    usage: { up: 0, down: 0 },
    showExitNotice: false,
    lastCopyTime: 0,
    model: 'gpt-test',
    workingDir: '/tmp/demo',
    branch: 'main',
    provider: 'openai',
    contextWindow: 0,
    runningAgentCount: 0,
    runningProcessCount: 0,
    indicatorFocused: false,
    ...overrides,
  });
}

const text = (result: ReturnType<typeof buildShellFooter>): string => result.lines.map(lineToString).join('\n');

describe('shell surface: the composer', () => {
  test('at rest the footer is the 5-row composer plus the status line', () => {
    const result = footer();
    expect(result.height).toBe(6);
    expect(result.height).toBe(estimateShellFooterHeight(1));
  });

  test('multi-line input grows the text area and nothing else', () => {
    const one = footer();
    const two = footer({ promptText: 'hello\nworld', promptLineCount: 2 });
    expect(two.height).toBe(one.height + 1);
    expect(lineToString(two.lines[1]!).slice(5, 10)).toBe('hello');
    expect(lineToString(two.lines[2]!).slice(5, 10)).toBe('world');
  });

  test('the bar runs every composer row at column 2 against a full-width element fill', () => {
    const result = footer({ width: 80 });
    const composer = result.lines.slice(0, 5);
    for (const row of composer) {
      expect(row[2]!.char).toBe('┃');
      expect(row[3]!.bg).toBe(activeTokens().backgroundElement);
      expect(row[77]!.bg).toBe(activeTokens().backgroundElement);
      expect(row[78]!.bg).toBe('');
    }
  });

  test('the composer passes the layout audit (padding rows, 2-column text inset, full-height bar)', () => {
    const result = footer({ width: 90, promptText: 'a much longer prompt that still fits on one row', promptCursorPos: 10, dangerMode: true, powerKeepAwake: true });
    expect(auditFrame(result.lines, 90, activeTokens())).toEqual([]);
  });

  test('an empty focused composer shows the placeholder', () => {
    const result = footer({ promptText: '', promptCursorPos: 0 });
    expect(lineToString(result.lines[1]!)).toContain('sk anything, or type / for commands and @ for files');
  });

  test('an unfocused empty composer says how to get back', () => {
    const result = footer({ promptText: '', indicatorFocused: true });
    expect(lineToString(result.lines[1]!)).toContain('Esc returns to the composer');
    expect(lineToString(result.lines[1]!)).not.toContain('█');
  });

  test('the inner row names the mode, model and provider', () => {
    const row = lineToString(footer({ permissionMode: 'plan' }).lines[3]!);
    expect(row).toContain('plan · gpt-test openai');
  });

  test('the mode colors the bar: normal brand, plan info, auto-approving modes warning, shell accent', () => {
    const t = activeTokens();
    expect(footer({ permissionMode: 'prompt' }).lines[0]![2]!.fg).toBe(t.brand);
    expect(footer({ permissionMode: 'plan' }).lines[0]![2]!.fg).toBe(t.info);
    expect(footer({ permissionMode: 'accept-edits' }).lines[0]![2]!.fg).toBe(t.warning);
    expect(footer({ permissionMode: 'allow-all' }).lines[0]![2]!.fg).toBe(t.warning);
    const shell = footer({ permissionMode: 'prompt', composerPendingRisk: 'shell', promptText: '!ls' });
    expect(shell.lines[0]![2]!.fg).toBe(t.accent);
    expect(lineToString(shell.lines[3]!)).toContain('shell ·');
  });

  test('the failover marker follows the model on the inner row', () => {
    const row = lineToString(footer({ modelNote: 'failover from abacusai:route-llm', width: 120 }).lines[3]!);
    expect(row).toContain('gpt-test openai · failover from abacusai:route-llm');
  });

  test('a command argument hint trails the cursor, clamped with an ellipsis', () => {
    const hint = 'install <name> | uninstall <name> | enable <name> | disable <name> | refresh | search <query>';
    const row = lineToString(footer({ width: 60, promptText: '/marketplace', promptCursorPos: 12, commandArgsHint: hint }).lines[1]!);
    expect(row).toContain('install <name>');
    expect(row).toContain('…');
    expect(row.length).toBeLessThanOrEqual(60);
  });
});

describe('shell surface: always-visible safety', () => {
  test('auto-approve shows in the error color on the composer inner row', () => {
    const result = footer({ dangerMode: true });
    const row = result.lines[3]!;
    expect(lineToString(row)).toContain('! auto-approve');
    const bang = lineToString(row).indexOf('! auto-approve');
    expect(row[bang]!.fg).toBe(activeTokens().error);
    // Right-aligned inside the fill, 2 columns in from its edge (width-3).
    expect(lineToString(row).trimEnd().length).toBe(100 - 4);
  });

  test('no auto-approve chip when it is off', () => {
    expect(text(footer())).not.toContain('auto-approve');
  });

  test.each([60, 80, 120])('the sleep-disabled chip survives %i columns', (width) => {
    expect(text(footer({ width, powerKeepAwake: true, dangerMode: true }))).toContain('sleep disabled');
    expect(text(footer({ width, powerKeepAwake: false }))).not.toContain('sleep disabled');
  });
});

/**
 * The live microphone. It is the only thing on screen that tells a user a
 * capture device is open, so its presence and its absence when the feature is
 * off are asserted rather than assumed.
 */
describe('shell surface: the live microphone chip', () => {
  const withVoice = (voiceCapture: VoiceCaptureIndicatorState | null) => footer({ voiceCapture });

  test('no chip when nothing is captured', () => {
    expect(text(withVoice(null))).not.toContain('mic');
  });

  test('a listening wake detector shows on the inner row without changing the footer height', () => {
    const result = withVoice({ kind: 'wake-listening', deviceLabel: 'parecord', indicator: 'statusline' });
    expect(lineToString(result.lines[3]!)).toContain('mic listening');
    expect(result.height).toBe(6);
  });

  test('voice.wake.indicator off suppresses the wake chip', () => {
    expect(text(withVoice({ kind: 'wake-listening', deviceLabel: 'parecord', indicator: 'off' }))).not.toContain('mic');
  });

  test('a push-to-talk recording shows even when the wake indicator is off; the user just pressed the key', () => {
    expect(text(withVoice({ kind: 'recording', deviceLabel: 'pw-record', indicator: 'off', detail: '3s' }))).toContain('mic recording');
  });

  test('banner prominence fills the chip, statusline prominence does not', () => {
    const banner = withVoice({ kind: 'wake-listening', deviceLabel: 'parecord', indicator: 'banner' }).lines[3]!;
    const plain = withVoice({ kind: 'wake-listening', deviceLabel: 'parecord', indicator: 'statusline' }).lines[3]!;
    const fill = activeTokens().backgroundElement;
    const filled = (row: typeof banner) => row.filter((c) => c.bg !== '' && c.bg !== fill).length;
    expect(filled(banner)).toBeGreaterThan(filled(plain));
  });

  test('a latched detector says it stopped', () => {
    expect(text(withVoice({ kind: 'wake-latched', deviceLabel: 'parecord', indicator: 'statusline', detail: 'crashed 2 times within 60s' }))).toContain('wake stopped');
  });
});

describe('shell surface: the status line', () => {
  const status = (overrides: Partial<ShellFooterBuildOptions> = {}): string => {
    const result = footer(overrides);
    return lineToString(result.lines[result.lines.length - 1]!);
  };

  test('at rest it shows the directory and branch, and the ctrl+p menu keycap on the right', () => {
    const row = status({ width: 120 });
    expect(row).toContain('/tmp/demo · main');
    expect(row).toMatch(/ctrl\+p +menu/);
  });

  test('below 100 columns the directory goes first', () => {
    const row = status({ width: 90 });
    expect(row).not.toContain('/tmp/demo');
    expect(row).toContain('main');
  });

  test('a running turn shows its phrase, elapsed time and esc interrupt instead of the directory', () => {
    const row = status({ width: 120, busy: { spinner: '◐', frame: 0, phrase: 'Thinking...', elapsedMs: 12_000 } });
    expect(row).toContain('Thinking... · 12s');
    expect(row).toMatch(/esc +interrupt/);
    expect(row).not.toContain('/tmp/demo');
  });

  test('only the spinner glyph carries color from the gradient; the phrase is muted', () => {
    const result = footer({ width: 120, busy: { spinner: '◐', frame: 0, phrase: 'Thinking...' } });
    const row = result.lines[result.lines.length - 1]!;
    const phraseStart = lineToString(row).indexOf('Thinking');
    for (let x = phraseStart; x < phraseStart + 8; x++) expect(row[x]!.fg).toBe(activeTokens().textMuted);
  });

  test('the context bar shows percent and used / total, with "—" before the first count', () => {
    expect(status({ width: 120, contextWindow: 200_000, lastInputTokens: 50_000, compactThreshold: 0.8 })).toContain('25% 50.0k / 200.0k');
    expect(status({ width: 120, contextWindow: 200_000, lastInputTokens: 0 })).toContain('0% — / 200.0k');
  });

  test('the fleet cost stays split from the session cost', () => {
    const row = status({ width: 140, model: 'claude-opus-4-6', usage: { up: 10_000, down: 1_000, fleetCostUsd: 0.47 } });
    expect(row).toMatch(/you ~\$[\d.]+ · fleet ~\$0\.470/);
    const solo = status({ width: 140, model: 'claude-opus-4-6', usage: { up: 10_000, down: 1_000, fleetCostUsd: 0 } });
    expect(solo).not.toContain('fleet');
    expect(solo).toMatch(/~\$[\d.]+/);
  });

  test('the exit guard takes the left side while armed', () => {
    expect(status({ showExitNotice: true })).toContain('Press Ctrl+C again to exit');
  });

  test('running background work is summarized, and highlighted with its keys when focused', () => {
    expect(status({ width: 120, runningAgentCount: 2 })).toContain('2 agents running');
    const focused = status({ width: 120, runningAgentCount: 1, indicatorFocused: true });
    expect(focused).toContain('▸ 1 agent running');
    expect(focused).toMatch(/esc +back/);
    expect(status({ width: 120, indicatorFocused: true })).toContain('no background work');
  });

  test('nothing on the status line runs past width-4', () => {
    for (const width of [60, 80, 100, 140]) {
      const row = status({ width, contextWindow: 1_000_000, lastInputTokens: 340_000, model: 'claude-opus-4-6', usage: { up: 1, down: 1, fleetCostUsd: 1.5 } });
      expect(row.trimEnd().length).toBeLessThanOrEqual(width - 3);
    }
  });
});

describe('shell surface: hint rows above the composer', () => {
  test('the retry affordance, the context pressure hint and the scriptable line stack above the composer', () => {
    const result = footer({ retryHint: 'r retry', contextStatusHint: 'context 82%: compaction soon', scriptableStatusLine: 'custom line' });
    expect(result.height).toBe(9);
    expect(lineToString(result.lines[0]!)).toContain('r retry');
    expect(lineToString(result.lines[1]!)).toContain('compaction soon');
    expect(lineToString(result.lines[2]!)).toContain('custom line');
    expect(result.lines[3]![2]!.char).toBe('┃');
  });
});
