// ---------------------------------------------------------------------------
// terminal-notifier.test.ts
// OSC 9 in-terminal notifications + optional bell: sequence format, per-signal
// config gating (with per-signal defaults), the unfocused-or-unknown focus
// rule, and the terminal-restore write gate.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import {
  buildOsc9,
  createTerminalNotifier,
  shouldEmitTerminalNotification,
  TERMINAL_BELL_KEY,
  type TerminalNotifySignal,
} from '../../core/terminal-notifier.ts';

const BEL = '\x07';

/** A config-get backed by a plain map; unset keys read as undefined (→ signal default). */
function configFrom(map: Record<string, unknown>) {
  return (k: string) => map[k];
}

/** Focus tracker double: `focused` null = unknown (should alert), true = focused (suppress). */
function focus(focused: boolean | null) {
  return { shouldAlertWhenUnfocused: () => focused !== true };
}

function makeStdout() {
  const writes: string[] = [];
  return { writes, write: (s: string) => { writes.push(s); return true; } };
}

describe('buildOsc9', () => {
  test('wraps the message in the OSC 9 desktop-notification sequence', () => {
    expect(buildOsc9('hello')).toBe(`\x1b]9;hello${BEL}`);
  });
  test('collapses embedded control characters so they cannot terminate the sequence early', () => {
    expect(buildOsc9(`a\x07b\x1bc`)).toBe(`\x1b]9;a b c${BEL}`);
  });
});

describe('shouldEmitTerminalNotification: defaults + focus rule', () => {
  test('approval-wait defaults ON; emits for an unfocused/unknown terminal', () => {
    expect(shouldEmitTerminalNotification('approval-wait', configFrom({}), focus(null))).toBe(true);
    expect(shouldEmitTerminalNotification('approval-wait', configFrom({}), focus(false))).toBe(true);
  });
  test('approval-wait is suppressed while the terminal is focused', () => {
    expect(shouldEmitTerminalNotification('approval-wait', configFrom({}), focus(true))).toBe(false);
  });
  test('turn-end and agent-blocked default OFF', () => {
    for (const s of ['turn-end', 'agent-blocked'] as TerminalNotifySignal[]) {
      expect(shouldEmitTerminalNotification(s, configFrom({}), focus(null))).toBe(false);
    }
  });
  test('an explicit toggle overrides the default either way', () => {
    expect(shouldEmitTerminalNotification('turn-end', configFrom({ 'behavior.terminalNotifyTurnEnd': true }), focus(null))).toBe(true);
    expect(shouldEmitTerminalNotification('approval-wait', configFrom({ 'behavior.terminalNotifyApprovalWait': false }), focus(null))).toBe(false);
  });
});

describe('createTerminalNotifier.notify', () => {
  test('writes the OSC 9 sequence when the signal is enabled and the terminal is unfocused', () => {
    const stdout = makeStdout();
    const notifier = createTerminalNotifier({ stdout, configGet: configFrom({}), focusTracker: focus(null), isReleased: () => false });
    notifier.notify('approval-wait', 'Bash needs approval');
    expect(stdout.writes).toEqual([`\x1b]9;Bash needs approval${BEL}`]);
  });

  test('does not write when the signal toggle is off', () => {
    const stdout = makeStdout();
    const notifier = createTerminalNotifier({ stdout, configGet: configFrom({}), focusTracker: focus(null), isReleased: () => false });
    notifier.notify('turn-end', 'Turn finished'); // default off
    expect(stdout.writes).toEqual([]);
  });

  test('does not write while the terminal is focused', () => {
    const stdout = makeStdout();
    const notifier = createTerminalNotifier({ stdout, configGet: configFrom({}), focusTracker: focus(true), isReleased: () => false });
    notifier.notify('approval-wait', 'x');
    expect(stdout.writes).toEqual([]);
  });

  test('never writes after the terminal has been restored to the shell', () => {
    const stdout = makeStdout();
    const notifier = createTerminalNotifier({ stdout, configGet: configFrom({}), focusTracker: focus(null), isReleased: () => true });
    notifier.notify('approval-wait', 'x');
    expect(stdout.writes).toEqual([]);
  });

  test('the bell toggle appends an audible BEL after the sequence', () => {
    const stdout = makeStdout();
    const notifier = createTerminalNotifier({ stdout, configGet: configFrom({ [TERMINAL_BELL_KEY]: true }), focusTracker: focus(null), isReleased: () => false });
    notifier.notify('approval-wait', 'x');
    expect(stdout.writes).toEqual([`\x1b]9;x${BEL}${BEL}`]);
  });
});
