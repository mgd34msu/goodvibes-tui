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
    contextWindow: 0,
    runningAgentCount: 0,
    runningProcessCount: 0,
    indicatorFocused: false,
    ...overrides,
  });
}

const text = (result: ReturnType<typeof buildShellFooter>): string => result.lines.map(lineToString).join('\n');

describe('shell surface: the composer', () => {
  test('at rest the footer is the 5-row input area (caps, padding, text) plus the status line', () => {
    const result = footer();
    expect(result.height).toBe(6);
    expect(result.height).toBe(estimateShellFooterHeight(1));
  });

  test('multi-line input grows the text area and nothing else', () => {
    const one = footer();
    const two = footer({ promptText: 'hello\nworld', promptLineCount: 2 });
    expect(two.height).toBe(one.height + 1);
    expect(lineToString(two.lines[2]!).slice(5, 10)).toBe('hello');
    expect(lineToString(two.lines[3]!).slice(5, 10)).toBe('world');
  });

  test('the bar runs every composer row at column 2 against a full-width element fill', () => {
    const result = footer({ width: 80 });
    const composer = result.lines.slice(1, 4);
    for (const row of composer) {
      expect(row[2]!.char).toBe('┃');
      expect(row[3]!.bg).toBe(activeTokens().backgroundElement);
      expect(row[77]!.bg).toBe(activeTokens().backgroundElement);
      expect(row[78]!.bg).toBe('');
    }
  });

  test('half-row caps above and below the fill, with the bar\'s matching halves', () => {
    const t = activeTokens();
    const [top, , , , bottom] = footer({ width: 80 }).lines;
    expect(top![2]!.char).toBe('╻');
    expect(bottom![2]!.char).toBe('╹');
    for (let x = 3; x <= 77; x++) {
      expect(top![x]).toMatchObject({ char: '▄', fg: t.backgroundElement, bg: '' });
      expect(bottom![x]).toMatchObject({ char: '▀', fg: t.backgroundElement, bg: '' });
    }
    expect(top![78]!.char).toBe(' ');
  });

  test('the composer passes the layout audit (padding rows, 2-column text inset, full-height bar)', () => {
    const result = footer({ width: 90, promptText: 'a much longer prompt that still fits on one row', promptCursorPos: 10, dangerMode: true, powerKeepAwake: true });
    expect(auditFrame(result.lines, 90, activeTokens())).toEqual([]);
  });

  test('an empty focused composer shows the placeholder', () => {
    const result = footer({ promptText: '', promptCursorPos: 0 });
    expect(lineToString(result.lines[2]!)).toContain('sk anything, or type / for commands and @ for files');
  });

  test('an unfocused empty composer says how to get back', () => {
    const result = footer({ promptText: '', indicatorFocused: true });
    expect(lineToString(result.lines[2]!)).toContain('Esc returns to the composer');
    expect(lineToString(result.lines[2]!)).not.toContain('█');
  });

  test('the composer holds only input: no mode, model, provider or warning inside it', () => {
    const result = footer({ permissionMode: 'plan', dangerMode: true, powerKeepAwake: true, width: 120 });
    const composer = result.lines.slice(0, 5).map(lineToString).join('\n');
    expect(composer).toContain('hello');
    for (const word of ['plan', 'gpt-test', 'openai', 'auto-approve', 'sleep disabled']) expect(composer).not.toContain(word);
    expect(lineToString(result.lines[1]!).trim()).toBe('┃');
    expect(lineToString(result.lines[3]!).trim()).toBe('┃');
  });

  test('the mode colors the bar: normal brand, plan info, auto-approving modes warning, shell accent', () => {
    const t = activeTokens();
    expect(footer({ permissionMode: 'prompt' }).lines[0]![2]!.fg).toBe(t.brand);
    expect(footer({ permissionMode: 'plan' }).lines[0]![2]!.fg).toBe(t.info);
    expect(footer({ permissionMode: 'accept-edits' }).lines[0]![2]!.fg).toBe(t.warning);
    expect(footer({ permissionMode: 'allow-all' }).lines[0]![2]!.fg).toBe(t.warning);
    const shell = footer({ permissionMode: 'prompt', composerPendingRisk: 'shell', promptText: '!ls' });
    expect(shell.lines[0]![2]!.fg).toBe(t.accent);
  });

  test('a command argument hint trails the cursor, clamped with an ellipsis', () => {
    const hint = 'install <name> | uninstall <name> | enable <name> | disable <name> | refresh | search <query>';
    const row = lineToString(footer({ width: 60, promptText: '/marketplace', promptCursorPos: 12, commandArgsHint: hint }).lines[2]!);
    expect(row).toContain('install <name>');
    expect(row).toContain('…');
    expect(row.length).toBeLessThanOrEqual(60);
  });
});

describe('shell surface: always-visible safety', () => {
  const statusRow = (result: ReturnType<typeof buildShellFooter>) => result.lines[result.lines.length - 1]!;

  test('the mode chip opens the status line: muted, plan in the info color', () => {
    const t = activeTokens();
    const normal = statusRow(footer({ permissionMode: 'prompt', width: 120 }));
    expect(lineToString(normal).slice(3)).toMatch(/^normal {3}\/tmp\/demo · main/);
    expect(normal[3]!.fg).toBe(t.textMuted);
    const plan = statusRow(footer({ permissionMode: 'plan', width: 120 }));
    expect(lineToString(plan).slice(3, 7)).toBe('plan');
    expect(plan[3]!.fg).toBe(t.info);
  });

  test('auto-approve takes the mode chip in the error color', () => {
    const row = statusRow(footer({ permissionMode: 'allow-all', dangerMode: true }));
    expect(lineToString(row).slice(3)).toMatch(/^! auto-approve/);
    expect(row[3]!.fg).toBe(activeTokens().error);
    expect(lineToString(row)).not.toMatch(/\bauto {2}!/);
  });

  test('plan keeps its name beside the auto-approve warning; normal does not contradict it', () => {
    expect(lineToString(statusRow(footer({ permissionMode: 'plan', dangerMode: true })))).toContain('plan  ! auto-approve');
    const normal = lineToString(statusRow(footer({ permissionMode: 'prompt', dangerMode: true })));
    expect(normal.slice(3)).toMatch(/^! auto-approve/);
    expect(normal).not.toContain('normal');
  });

  test('no auto-approve warning when it is off', () => {
    expect(text(footer())).not.toContain('auto-approve');
  });

  test('a running turn\'s esc hint follows the mode chip', () => {
    const row = lineToString(statusRow(footer({ width: 120, dangerMode: true, permissionMode: 'allow-all', promptText: '', turnRunning: true })));
    expect(row).toMatch(/! auto-approve {3} ?esc +interrupt/);
  });

  test.each([60, 80, 120])('the mode chip, auto-approve and sleep-disabled survive %i columns', (width) => {
    const row = lineToString(statusRow(footer({ width, permissionMode: 'plan', powerKeepAwake: true, dangerMode: true, contextWindow: 200_000, lastInputTokens: 150_000, usage: { up: 1, down: 1, fleetCostUsd: 1 } })));
    expect(row).toContain('plan');
    expect(row).toContain('! auto-approve');
    expect(row).toContain('sleep disabled');
    expect(text(footer({ width, powerKeepAwake: false }))).not.toContain('sleep disabled');
  });

  test('composer flags ride after the safety chips and are the first to go on a short row', () => {
    expect(lineToString(statusRow(footer({ width: 120, composerFlags: ['attachments'] })))).toContain('normal  attachments');
    const narrow = lineToString(statusRow(footer({ width: 50, dangerMode: true, powerKeepAwake: true, composerFlags: ['attachments'] })));
    expect(narrow).toContain('sleep disabled');
    expect(narrow).not.toContain('attachments');
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

  test('a listening wake detector shows on the status line without changing the footer height', () => {
    const result = withVoice({ kind: 'wake-listening', deviceLabel: 'parecord', indicator: 'statusline' });
    expect(lineToString(result.lines[5]!)).toContain('mic listening');
    expect(result.height).toBe(6);
  });

  test('voice.wake.indicator off suppresses the wake chip', () => {
    expect(text(withVoice({ kind: 'wake-listening', deviceLabel: 'parecord', indicator: 'off' }))).not.toContain('mic');
  });

  test('a push-to-talk recording shows even when the wake indicator is off; the user just pressed the key', () => {
    expect(text(withVoice({ kind: 'recording', deviceLabel: 'pw-record', indicator: 'off', detail: '3s' }))).toContain('mic recording');
  });

  test('banner prominence fills the chip, statusline prominence does not', () => {
    const banner = withVoice({ kind: 'wake-listening', deviceLabel: 'parecord', indicator: 'banner' }).lines[5]!;
    const plain = withVoice({ kind: 'wake-listening', deviceLabel: 'parecord', indicator: 'statusline' }).lines[5]!;
    const filled = (row: typeof banner) => row.filter((c) => c.bg !== '').length;
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

  test('a running turn leads with esc interrupt and keeps the session state; its activity is the throbber\'s', () => {
    const row = status({ width: 120, promptText: '', turnRunning: true, throbber: { spinner: '◐', frame: 0, activity: { kind: 'model', phrase: 'Thinking...', elapsedMs: 12_000 } } });
    expect(row).not.toContain('Thinking');
    expect(row).not.toContain('◐');
    expect(row).toMatch(/esc +interrupt/);
    expect(row).toContain('/tmp/demo · main');
  });

  test('while the composer has text, the status line says the next Esc clears it (it does not interrupt yet)', () => {
    const row = status({ width: 120, promptText: 'draft', turnRunning: true });
    expect(row).toMatch(/esc +clear input/);
    expect(row).not.toMatch(/esc +interrupt/);
  });

  test('on the throbber only the spinner glyph carries color from the gradient; the phrase is muted', () => {
    const result = footer({ width: 120, turnRunning: true, throbber: { spinner: '◐', frame: 0, activity: { kind: 'model', phrase: 'Thinking...' } } });
    const row = result.lines[1]!;
    expect(row[3]!.char).toBe('◐');
    const phraseStart = lineToString(row).indexOf('Thinking');
    expect(phraseStart).toBe(5);
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
  test('the retry affordance, the context pressure hint and the scriptable line stack above the composer, under an empty row', () => {
    const result = footer({ retryHint: 'r retry', contextStatusHint: 'context 82%: compaction soon', scriptableStatusLine: 'custom line' });
    expect(result.height).toBe(10);
    expect(lineToString(result.lines[0]!).trim()).toBe('');
    expect(lineToString(result.lines[1]!)).toContain('r retry');
    expect(lineToString(result.lines[2]!)).toContain('compaction soon');
    expect(lineToString(result.lines[3]!)).toContain('custom line');
    expect(result.lines[4]![2]!.char).toBe('╻');
    expect(result.lines[5]![2]!.char).toBe('┃');
  });

  test('the throbber sits under the hint rows, directly over the input area\'s cap', () => {
    const result = footer({ contextStatusHint: 'context 82%: compaction soon', turnRunning: true, throbber: { spinner: '◐', frame: 0, activity: { kind: 'compacting', elapsedMs: 4_000 } } });
    expect(lineToString(result.lines[0]!).trim()).toBe('');
    expect(lineToString(result.lines[1]!)).toContain('compaction soon');
    expect(lineToString(result.lines[2]!)).toContain('◐ Compacting the conversation · 4s');
    expect(result.lines[3]![2]!.char).toBe('╻');
  });
});
