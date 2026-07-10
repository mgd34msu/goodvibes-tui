/**
 * Process-lifecycle wiring for the TUI shell.
 *
 * Extracted from main() to keep the entrypoint under the architecture line-count
 * gate. `installProcessLifecycle` builds the terminal-restoring crash/termination
 * handlers and the graceful `exitApp` teardown, then returns them so main() can
 * register them on the exact same process/stdin/stdout listeners it used before.
 *
 * Behavior is identical to the previous inline version: the synchronous terminal
 * restore runs BEFORE the (possibly slow) async shutdown, the shutdown races a 3s
 * hard timeout, the recovery file is deleted only when the durable save completed,
 * signal exit codes are preserved (SIGHUP -> 129, otherwise 143; uncaught -> 1;
 * exitApp -> 0), and the `exiting`/`terminalRestored` reentrancy guards are kept.
 *
 * Some captured values are late-bound or mutable in main(): the InputHandler, the
 * render closure, and the terminal output guard are constructed AFTER this factory
 * runs (injected as thunks), while `recoveryInterval` and `stopSpokenOutputForExit`
 * are assigned later and read at exit time (injected as getters/setter). The
 * `unsubs` registry is shared by reference and drained on exit.
 */
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { createTerminalLifecycle, TERMINAL_ESCAPES } from '@pellux/goodvibes-terminal-shell';
import { formatUserFacingErrorLine } from '../core/format-user-error.ts';
import { allowTerminalWrite } from './terminal-output-guard.ts';
import { buildPersistedSessionContext, deleteRecoveryFile } from '@/runtime/index.ts';
import type { BootstrapContext } from './bootstrap.ts';
import type { InputHandler } from '../input/handler.ts';
import type { ConversationMessageSnapshot } from '../core/conversation.ts';

/** ANSI escape sequences used by the synchronous terminal restore. */
export interface ProcessLifecycleAnsi {
  readonly CLEAR_SCREEN: string;
  readonly ALT_SCREEN_EXIT: string;
  readonly PASTE_DISABLE: string;
  readonly KEYBOARD_EXT_DISABLE: string;
  readonly MOUSE_DISABLE: string;
  readonly CURSOR_SHOW: string;
  /** Disables terminal focus-event reporting (DECSET ?1004l) — see main.ts FOCUS_ENABLE. */
  readonly FOCUS_DISABLE: string;
}

export interface ProcessLifecycleDeps {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly ctx: BootstrapContext;
  /** Mirrors cli.flags.noAltScreen: whether the alt screen is exited on restore. */
  readonly noAltScreen: boolean;
  readonly ansi: ProcessLifecycleAnsi;
  /** Late-bound: the InputHandler is constructed after this factory runs. */
  readonly getInput: () => InputHandler;
  /** Late-bound: the render closure is defined after this factory runs. */
  readonly render: () => void;
  /** Late-bound: the terminal output guard is installed after this factory runs. */
  readonly getTerminalOutputGuard: () => { readonly dispose: () => void };
  readonly getPromptContentWidth: () => number;
  readonly buildSessionContinuityHints: () => Parameters<typeof buildPersistedSessionContext>[2];
  /** Teardown registry shared with main(); drained on exit. */
  readonly unsubs: ReadonlyArray<() => void>;
  readonly getRecoveryInterval: () => ReturnType<typeof setInterval> | null;
  readonly setRecoveryInterval: (value: ReturnType<typeof setInterval> | null) => void;
  readonly getStopSpokenOutputForExit: () => (() => void | Promise<void>) | null;
}

export interface ProcessLifecycleHandlers {
  readonly exitApp: () => Promise<void>;
  readonly restoreTerminal: () => void;
  /**
   * True once restoreTerminal has run. The compositor must never write another
   * frame after this: the terminal is back on the user's primary screen, and a
   * late cursor-positioned frame (async shutdown races, stray timers) would
   * paint over shell content and strand the prompt mid-screen.
   */
  readonly isTerminalRestored: () => boolean;
  readonly resizeHandler: () => void;
  readonly sigintHandler: () => void;
  readonly unhandledRejectionHandler: (reason: unknown) => void;
  readonly uncaughtExceptionHandler: (err: Error) => void;
  readonly terminationSignalHandler: (signal: NodeJS.Signals) => void;
  readonly exitListener: () => void;
}

export function installProcessLifecycle(deps: ProcessLifecycleDeps): ProcessLifecycleHandlers {
  const {
    stdin,
    stdout,
    ctx,
    noAltScreen,
    ansi,
    getInput,
    render,
    getTerminalOutputGuard,
    getPromptContentWidth,
    buildSessionContinuityHints,
    unsubs,
    getRecoveryInterval,
    setRecoveryInterval,
    getStopSpokenOutputForExit,
  } = deps;

  const sigintHandler = (): void => getInput().feed('\x03');
  let _unhandledRejectionCount = 0;
  let _unhandledRejectionWindowStart = Date.now();
  const unhandledRejectionHandler = (reason: unknown): void => {
    const now = Date.now();
    if (now - _unhandledRejectionWindowStart > 10000) {
      _unhandledRejectionCount = 0;
      _unhandledRejectionWindowStart = now;
    }
    _unhandledRejectionCount++;
    const msg = summarizeError(reason);
    if (_unhandledRejectionCount > 3) {
      logger.error('CRITICAL: cascading unhandled rejections — consider restarting', {
        count: _unhandledRejectionCount,
        windowMs: now - _unhandledRejectionWindowStart,
        error: String(reason),
      });
      ctx.systemMessageRouter.high(
        `[Critical] Multiple errors detected (${_unhandledRejectionCount} in 10s). If the issue persists, please restart. Latest: ${msg}`
      );
    } else {
      const formatted = formatUserFacingErrorLine(reason);
      ctx.systemMessageRouter.high(`[Error] ${formatted}`);
      logger.error('unhandledRejection', { error: String(reason) });
    }
    render();
  };
  const resizeHandler = (): void => {
    getInput().setContentWidth(getPromptContentWidth());
    ctx.compositor.resetDiff();
    render();
  };

  // Terminal enter/restore sequencing is the byte-identical seam both daemon
  // front-ends share, so it lives in @pellux/goodvibes-terminal-shell and this
  // wiring delegates to it. Only the restore path is used here (the TUI's
  // startup enter sequence stays in main.ts); the graceful shutdown below
  // (draining services, persisting sessions, exit codes) is TUI-specific and
  // stays local, calling restoreTerminal() for the synchronous hand-back.
  //
  // The injected `ansi` restore sequences are mapped onto the package's escape
  // set so the exact bytes the TUI has always emitted are preserved. The no-alt
  // exit deliberately uses the package's CLEAR_VIEWPORT_HOME ('\x1b[2J\x1b[H',
  // no ESC[3J) — never ansi.CLEAR_SCREEN, which carries the scrollback-wiping 3J.
  const terminalLifecycle = createTerminalLifecycle({
    write: (data) => { stdout.write(data); },
    noAltScreen,
    guardedWrite: allowTerminalWrite,
    disposeOutputGuard: () => getTerminalOutputGuard().dispose(),
    setRawMode: (enabled) => stdin.setRawMode(enabled),
    escapes: {
      ...TERMINAL_ESCAPES,
      ALT_SCREEN_EXIT: ansi.ALT_SCREEN_EXIT,
      PASTE_DISABLE: ansi.PASTE_DISABLE,
      KEYBOARD_EXT_DISABLE: ansi.KEYBOARD_EXT_DISABLE,
      MOUSE_DISABLE: ansi.MOUSE_DISABLE,
      CURSOR_SHOW: ansi.CURSOR_SHOW,
      FOCUS_DISABLE: ansi.FOCUS_DISABLE,
    },
  });
  // Idempotent, synchronous-only terminal restore. Safe to call from process.on('exit'),
  // signal handlers, uncaughtException, and exitApp. Disposes the output guard AFTER the
  // restore write so a crash stack reaches the real stderr instead of being suppressed.
  const restoreTerminal = terminalLifecycle.restoreTerminal;

  const uncaughtExceptionHandler = (err: Error): void => {
    restoreTerminal();
    logger.error('uncaughtException — terminal restored, exiting', { error: summarizeError(err) });
    process.exit(1);
  };
  const terminationSignalHandler = (signal: NodeJS.Signals): void => {
    restoreTerminal();
    logger.error(`Received ${signal} — terminal restored, exiting`, {});
    process.exit(signal === 'SIGHUP' ? 129 : 143);
  };
  const exitListener = (): void => { restoreTerminal(); };

  let exiting = false;
  const exitApp = async (): Promise<void> => {
    // Reentrancy guard: a second /exit or keypress during the awaited shutdown below
    // must not re-run teardown or double-fire ctx.shutdown.
    if (exiting) return;
    exiting = true;
    // Exit lets the spoken audio the user is already hearing finish inside a
    // short bounded window (capped inside stopForExit, under the 3s shutdown
    // budget below) while the rest of teardown proceeds; queued-but-unplayed
    // speech is dropped. Deliberate interrupts (Ctrl+C, /tts stop) still cut
    // instantly through controller.stop() before this path is ever reached.
    let spokenOutputDrain: Promise<void> = Promise.resolve();
    try {
      spokenOutputDrain = Promise.resolve(getStopSpokenOutputForExit()?.()).then(() => undefined);
    } catch { /* non-fatal to exit */ }
    spokenOutputDrain = spokenOutputDrain.catch(() => undefined);
    unsubs.forEach(fn => fn());
    const interval = getRecoveryInterval();
    if (interval !== null) { clearInterval(interval); setRecoveryInterval(null); }
    stdin.removeAllListeners('data');
    stdout.removeListener('resize', resizeHandler);
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('unhandledRejection', unhandledRejectionHandler);
    // Restore the terminal synchronously BEFORE the (possibly slow) async shutdown so the
    // user is not left staring at a frozen alt screen while we drain and persist.
    restoreTerminal();
    const snapshot = ctx.conversation.toJSON() as { messages: Array<ConversationMessageSnapshot>; timestamp?: number };
    let shutdownOk = false;
    try {
      // Race the graceful shutdown against a hard timeout — externalServices.stop() can hang
      // and we must still exit; deferredStartup.drain only budgets 100ms internally.
      // The spoken-audio drain runs concurrently and is internally capped below
      // this budget, so it never extends the exit beyond the hard timeout.
      await Promise.all([
        spokenOutputDrain,
        Promise.race([
          ctx.shutdown({ ...snapshot, ...buildPersistedSessionContext(snapshot.messages, ctx.conversation.getTitleSource(), buildSessionContinuityHints()) }).then(() => { shutdownOk = true; }),
          new Promise<void>((resolve) => setTimeout(resolve, 3000)),
        ]),
      ]);
    } catch (err) {
      logger.debug('ctx.shutdown error during exitApp (non-fatal)', { error: summarizeError(err) });
    }
    // Only remove the recovery fallback once the durable shutdown save actually completed,
    // so an interrupted or timed-out shutdown leaves the snapshot for the next launch.
    if (shutdownOk) {
      deleteRecoveryFile({ homeDirectory: ctx.services.homeDirectory });
    }
    process.exit(0);
  };

  return {
    exitApp,
    restoreTerminal,
    isTerminalRestored: terminalLifecycle.isTerminalRestored,
    resizeHandler,
    sigintHandler,
    unhandledRejectionHandler,
    uncaughtExceptionHandler,
    terminationSignalHandler,
    exitListener,
  };
}
