/**
 * terminal-notifier — emits in-terminal desktop notifications via the OSC 9
 * escape sequence (`ESC ] 9 ; <text> BEL`) and, optionally, an audible bell.
 *
 * This is distinct from the OS-level desktop notifications the alert classes in
 * this directory fire through the SDK's notifyCompletion: OSC 9 is delivered by
 * the terminal emulator itself, so it works over SSH and inside tmux where a
 * host-side notify daemon is not reachable. The two are complementary — a user
 * can enable either, both, or neither.
 *
 * Three signals, each with its own config toggle (documented in
 * settings-modal-data.ts): a tool call waiting on approval (default on), a turn
 * finishing (default off), and a delegated agent blocking on human input
 * (default off). A separate `behavior.terminalBell` toggle (default off) adds an
 * audible BEL to whichever of those fire.
 *
 * Focus rule (per the feature brief): emit only when the terminal is NOT focused
 * if focus is knowable, and unconditionally when the terminal never reported
 * focus — exactly FocusTracker.shouldAlertWhenUnfocused(). This is deliberately
 * NOT tied to the alert classes' master `notifyOnlyWhenUnfocused` gate: an
 * in-terminal notification only makes sense for an unattended window.
 *
 * Write discipline: the escape sequence goes out through allowTerminalWrite (so
 * the terminal-output guard passes it rather than intercepting it as stray
 * output) and NEVER after the terminal has been handed back to the shell
 * (isReleased() — the same restore gate the render scheduler honors). No cursor
 * positioning is involved, so an OSC 9 emitted between frames is safe.
 */
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { allowTerminalWrite } from '@pellux/goodvibes-terminal-shell/terminal-output-guard';
import { readBooleanConfig, type ConfigGet } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import type { FocusTracker } from '@pellux/goodvibes-sdk/platform/runtime/operations';

export type TerminalNotifySignal = 'approval-wait' | 'turn-end' | 'agent-blocked';

interface SignalSpec {
  readonly configKey: string;
  readonly defaultOn: boolean;
}

/** Per-signal config keys + defaults. Kept in sync with settings-modal-data.ts. */
export const TERMINAL_NOTIFY_SIGNALS: Record<TerminalNotifySignal, SignalSpec> = {
  'approval-wait': { configKey: 'behavior.terminalNotifyApprovalWait', defaultOn: true },
  'turn-end': { configKey: 'behavior.terminalNotifyTurnEnd', defaultOn: false },
  'agent-blocked': { configKey: 'behavior.terminalNotifyAgentBlocked', defaultOn: false },
};

/** The audible-bell toggle key. Default off. */
export const TERMINAL_BELL_KEY = 'behavior.terminalBell';

const BEL = '\x07';

/**
 * Build an OSC 9 desktop-notification sequence. Control characters in the
 * message are collapsed to spaces so they cannot terminate the sequence early
 * or corrupt the terminal, and the text is length-capped defensively.
 */
export function buildOsc9(message: string): string {
  const safe = message.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200);
  return `\x1b]9;${safe}${BEL}`;
}

export interface TerminalNotifierDeps {
  readonly stdout: { write(s: string): boolean };
  readonly configGet: ConfigGet;
  readonly focusTracker: Pick<FocusTracker, 'shouldAlertWhenUnfocused'>;
  /** True once the terminal has been restored to the shell — no writes after that. */
  readonly isReleased: () => boolean;
}

export interface TerminalNotifier {
  /** Emit an OSC 9 notification (and optional bell) for `signal`, subject to its toggle + the focus rule. */
  notify(signal: TerminalNotifySignal, message: string): void;
}

/** True when `signal` should emit right now (toggle on AND the focus rule allows it). Exposed for tests. */
export function shouldEmitTerminalNotification(
  signal: TerminalNotifySignal,
  configGet: ConfigGet,
  focusTracker: Pick<FocusTracker, 'shouldAlertWhenUnfocused'>,
): boolean {
  const spec = TERMINAL_NOTIFY_SIGNALS[signal];
  if (!readBooleanConfig(configGet, spec.configKey, spec.defaultOn)) return false;
  return focusTracker.shouldAlertWhenUnfocused();
}

export function createTerminalNotifier(deps: TerminalNotifierDeps): TerminalNotifier {
  return {
    notify(signal, message) {
      if (!shouldEmitTerminalNotification(signal, deps.configGet, deps.focusTracker)) return;
      // Never write escape sequences once the terminal is back on the shell.
      if (deps.isReleased()) return;
      const bell = readBooleanConfig(deps.configGet, TERMINAL_BELL_KEY, false);
      const seq = buildOsc9(message) + (bell ? BEL : '');
      try {
        allowTerminalWrite(() => deps.stdout.write(seq));
      } catch (err) {
        logger.debug('terminal-notifier: OSC9 write error', { error: String(err) });
      }
    },
  };
}
