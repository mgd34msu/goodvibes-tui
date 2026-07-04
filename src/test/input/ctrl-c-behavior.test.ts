import { describe, expect, mock, spyOn, test } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '../../input/selection.ts';
import { InfiniteBuffer } from '../../core/history.ts';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { handleCtrlC } from '../../input/handler-content-actions.ts';

type InputHandlerTestAccess = {
  commandContext?: {
    cancelGeneration?: () => void;
  };
};

function makeInput() {
  const selection = new SelectionManager();
  const history = new InfiniteBuffer();
  const renders: string[] = [];
  const input = new InputHandler(
    () => {
      renders.push(input.prompt);
    },
    selection,
    () => 0,
    () => 20,
    () => history,
    () => {},
    () => {},
    createDefaultUiRuntimeServices(),
  );
  input.setContentWidth(80);
  return { input, renders };
}

describe('Ctrl+C behavior', () => {
  test('clears prompt content even when panel workspace has focus', () => {
    const { input, renders } = makeInput();
    input.prompt = 'pending text';
    input.cursorPos = input.prompt.length;
    input.panelFocused = true;

    input.feed('\x03');

    expect(input.prompt).toBe('');
    expect(input.cursorPos).toBe(0);
    expect(renders.at(-1)).toBe('');
  });

  test('clears prompt content even while a modal is active', () => {
    const { input, renders } = makeInput();
    input.prompt = 'clear me';
    input.cursorPos = input.prompt.length;
    input.helpOverlayActive = true;
    input.modalStack.push('help');

    input.feed('\x03');

    expect(input.prompt).toBe('');
    expect(input.cursorPos).toBe(0);
    expect(input.helpOverlayActive).toBe(true);
    expect(renders.at(-1)).toBe('');
  });

  test('cancels generation globally when prompt is empty', () => {
    const { input } = makeInput();
    const cancelGeneration = mock(() => {});
    (input as unknown as InputHandlerTestAccess).commandContext = { cancelGeneration };
    input.panelFocused = true;

    input.feed('\x03');

    expect(cancelGeneration).toHaveBeenCalled();
  });
});

// UX-B item 6b: stopping in-flight speech / aborting the turn must never
// prevent the quit double-press window from advancing. A throw from the async
// TTS-stop path would otherwise swallow the press and strand the user.
describe('Ctrl+C exit chord survives a throwing TTS-stop (UX-B 6b)', () => {
  function callHandleCtrlC(
    state: { lastCtrlCTime: number; lastCtrlCTimeoutId: ReturnType<typeof setTimeout> | null; showExitNotice: boolean },
    cancelGeneration: (() => void) | undefined,
    exitApp: () => void,
  ): void {
    handleCtrlC(
      '', () => {}, () => {}, () => {},
      cancelGeneration,
      exitApp,
      () => {},
      state.lastCtrlCTime,
      (v) => { state.lastCtrlCTime = v; },
      (v) => { state.showExitNotice = v; },
      state.lastCtrlCTimeoutId,
      (v) => { state.lastCtrlCTimeoutId = v; },
    );
  }

  test('a throwing cancelGeneration still records the press and lets a second press quit', () => {
    const state = { lastCtrlCTime: 0, lastCtrlCTimeoutId: null as ReturnType<typeof setTimeout> | null, showExitNotice: false };
    let exited = false;
    const throwingCancel = mock(() => { throw new Error('audio subprocess kill failed'); });
    const nowSpy = spyOn(Date, 'now');
    try {
      // First press while "TTS is speaking": cancelGeneration throws, but the
      // quit window must still open (press recorded).
      nowSpy.mockReturnValue(1_000);
      callHandleCtrlC(state, throwingCancel, () => { exited = true; });
      expect(throwingCancel).toHaveBeenCalledTimes(1);
      expect(state.showExitNotice).toBe(true);
      expect(state.lastCtrlCTime).toBe(1_000);
      expect(exited).toBe(false);

      // Second press within the window: exits, even though cancel throws again.
      nowSpy.mockReturnValue(1_500);
      callHandleCtrlC(state, throwingCancel, () => { exited = true; });
      expect(exited).toBe(true);
    } finally {
      if (state.lastCtrlCTimeoutId !== null) clearTimeout(state.lastCtrlCTimeoutId);
      nowSpy.mockRestore();
    }
  });
});

// W0.4(f): a second empty-prompt Ctrl+C press arriving just inside the 1s
// "press again to exit" window used to leave the FIRST press's hide-timer
// live — nothing cleared it. If exitApp() isn't perfectly synchronous, that
// stale timer fires mid-shutdown and flips showExitNotice/requestRender
// after the user already believes the app is exiting.
describe('Ctrl+C confirm-window race (W0.4 f): stale hide-timer bookkeeping', () => {
  function callHandleCtrlC(
    state: { lastCtrlCTime: number; lastCtrlCTimeoutId: ReturnType<typeof setTimeout> | null; showExitNotice: boolean },
    exitApp: () => void,
  ): void {
    handleCtrlC(
      '', () => {}, () => {}, () => {},
      undefined,
      exitApp,
      () => {},
      state.lastCtrlCTime,
      (v) => { state.lastCtrlCTime = v; },
      (v) => { state.showExitNotice = v; },
      state.lastCtrlCTimeoutId,
      (v) => { state.lastCtrlCTimeoutId = v; },
    );
  }

  test('a second press inside the window clears the first press\'s pending hide-timer before exiting', () => {
    const state = { lastCtrlCTime: 0, lastCtrlCTimeoutId: null as ReturnType<typeof setTimeout> | null, showExitNotice: false };
    let exited = false;
    const nowSpy = spyOn(Date, 'now');
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');

    try {
      // First press at t=10_000 (lastCtrlCTime starts at 0, so this is well
      // outside the window — a real "first ever press", not a same-window
      // repeat): opens the notice window and schedules a hide-timer.
      nowSpy.mockReturnValue(10_000);
      callHandleCtrlC(state, () => { exited = true; });
      expect(state.showExitNotice).toBe(true);
      expect(state.lastCtrlCTimeoutId).not.toBeNull();
      const firstTimeoutId = state.lastCtrlCTimeoutId;

      // Second press at t=10_999 (inside the 1s window): should exit AND
      // clear the still-pending hide-timer from the first press, instead of
      // leaving it to fire on its own 1s later.
      nowSpy.mockReturnValue(10_999);
      clearTimeoutSpy.mockClear();
      callHandleCtrlC(state, () => { exited = true; });

      expect(exited).toBe(true);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(firstTimeoutId);
      expect(state.lastCtrlCTimeoutId).toBeNull();
    } finally {
      if (state.lastCtrlCTimeoutId !== null) clearTimeout(state.lastCtrlCTimeoutId);
      nowSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  test('a fresh notice window replacing an unexpired one clears the previous hide-timer too', () => {
    const state = { lastCtrlCTime: 0, lastCtrlCTimeoutId: null as ReturnType<typeof setTimeout> | null, showExitNotice: false };
    const nowSpy = spyOn(Date, 'now');
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');

    try {
      nowSpy.mockReturnValue(10_000);
      callHandleCtrlC(state, () => {});
      const firstTimeoutId = state.lastCtrlCTimeoutId;
      expect(firstTimeoutId).not.toBeNull();

      // Third-and-later press well outside the window (>= 1000ms since the
      // last press) opens a brand-new window rather than exiting — its own
      // stale predecessor timer must still be cleared.
      nowSpy.mockReturnValue(15_000);
      clearTimeoutSpy.mockClear();
      callHandleCtrlC(state, () => {});

      expect(clearTimeoutSpy).toHaveBeenCalledWith(firstTimeoutId);
      expect(state.lastCtrlCTimeoutId).not.toBe(firstTimeoutId);
    } finally {
      if (state.lastCtrlCTimeoutId !== null) clearTimeout(state.lastCtrlCTimeoutId);
      nowSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  // W6.2 f: pins the exact user-observed contract. Live replay saw two
  // empty-composer Ctrl+C presses "seconds apart" do nothing while the footer
  // advertised "Ctrl+C quit". That is the intended accidental-exit guard: only
  // a SECOND press WITHIN ~1s of the first exits; presses more than 1s apart
  // each merely re-arm the confirm window. The behavior is correct; the fix
  // (footer-tips.ts) is to advertise it honestly as "Ctrl+C x2 quit".
  test('empty-composer presses SECONDS apart never exit; only a rapid second press within ~1s exits', () => {
    const state = { lastCtrlCTime: 0, lastCtrlCTimeoutId: null as ReturnType<typeof setTimeout> | null, showExitNotice: false };
    let exited = false;
    const nowSpy = spyOn(Date, 'now');
    try {
      // Press 1 at t=1_000 (first ever): arms the confirm notice, does not exit.
      nowSpy.mockReturnValue(1_000);
      callHandleCtrlC(state, () => { exited = true; });
      expect(state.showExitNotice).toBe(true);
      expect(exited).toBe(false);

      // Press 2 at t=4_000 (3s later — "seconds apart", outside the 1s window):
      // re-arms the notice, STILL does not exit.
      nowSpy.mockReturnValue(4_000);
      callHandleCtrlC(state, () => { exited = true; });
      expect(state.showExitNotice).toBe(true);
      expect(exited).toBe(false);

      // Press 3 at t=4_500 (within 1s of press 2): NOW it exits.
      nowSpy.mockReturnValue(4_500);
      callHandleCtrlC(state, () => { exited = true; });
      expect(exited).toBe(true);
    } finally {
      if (state.lastCtrlCTimeoutId !== null) clearTimeout(state.lastCtrlCTimeoutId);
      nowSpy.mockRestore();
    }
  });
});
