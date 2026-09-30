// Esc while the output is scrolled back (owner ruling 2026-09-29): it returns
// to the live bottom and never interrupts the running turn; at the bottom Esc
// keeps its order (a modal closes, the composer clears, then the turn is
// interrupted). Driven through the real InputHandler key path with the real
// transcript scroll state main.ts uses (shell/transcript-scroll.ts), and in
// agent and process views through the real SessionViews.

import { describe, expect, test } from 'bun:test';
import { InfiniteBuffer, SelectionManager } from '@pellux/goodvibes-terminal-shell';
import { InputHandler } from '../../input/handler.ts';
import { TranscriptScroll } from '../../shell/transcript-scroll.ts';
import { handleEscape, type EscapeState } from '../../input/handler-modal-stack.ts';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';
import { makeViewScene, renderViewScreen } from '../helpers/session-view-scenes.ts';

disposeTestRuntimeServicesAfterAll();

const VIEWPORT = 20;
const LINES = 100;
const WHEEL_UP = '\x1b[<64;10;8M';
const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const ESC = '\x1b';

/** A main session: the input handler, the transcript scroll, and a turn that is running. */
function mainSession() {
  const history = new InfiniteBuffer();
  for (let i = 0; i < LINES; i++) history.addLine(UIFactory.stringToLine(`line ${i}`, 80));
  const transcript = new TranscriptScroll();
  const maxScroll = LINES - VIEWPORT;
  // One frame, the way main.ts renders: the layout's clamp is fed back.
  const frame = (): void => { transcript.settle(transcript.locked ? maxScroll : Math.min(transcript.top, maxScroll), maxScroll); };
  const turn = { running: true, cancels: 0 };
  const input = new InputHandler(
    () => {},
    new SelectionManager(),
    () => transcript.top,
    () => VIEWPORT,
    () => history,
    (delta) => transcript.scrollBy(delta, () => maxScroll),
    () => {},
    createDefaultUiRuntimeServices(),
  );
  input.setContentWidth(80);
  input.transcriptScroll = { scrolledBack: () => transcript.scrolledBack, toBottom: () => transcript.toBottom() };
  (input as unknown as { commandContext: { cancelGeneration: () => void } }).commandContext = {
    cancelGeneration: () => { turn.cancels++; turn.running = false; },
  };
  frame();
  return { input, transcript, frame, turn, maxScroll };
}

describe('Esc while the transcript is scrolled back', () => {
  test('during a running turn: Esc returns to the live bottom and never calls cancelGeneration; the next Esc at the bottom interrupts', () => {
    const s = mainSession();
    expect(s.transcript.top).toBe(s.maxScroll);
    s.input.feed(WHEEL_UP);
    s.frame();
    expect(s.transcript.scrolledBack).toBe(true);
    expect(s.transcript.top).toBe(s.maxScroll - 3);

    s.input.feed(ESC);
    s.frame();
    expect(s.turn.cancels).toBe(0);
    expect(s.turn.running).toBe(true);
    expect(s.transcript.scrolledBack).toBe(false);
    expect(s.transcript.top).toBe(s.maxScroll);

    // At the bottom Esc keeps today's order: an empty composer's Esc interrupts.
    s.input.feed(ESC);
    expect(s.turn.cancels).toBe(1);
    expect(s.turn.running).toBe(false);
  });

  test('PageUp scrolls the transcript too, and reaching the bottom with PageDown re-locks it', () => {
    const s = mainSession();
    s.input.feed(PAGE_UP);
    s.frame();
    expect(s.transcript.scrolledBack).toBe(true);
    expect(s.transcript.top).toBe(s.maxScroll - (VIEWPORT - 2));
    s.input.feed(PAGE_DOWN);
    s.frame();
    expect(s.transcript.scrolledBack).toBe(false);
    expect(s.transcript.top).toBe(s.maxScroll);
    expect(s.turn.cancels).toBe(0);
  });

  test('the earlier steps keep their order while scrolled: the composer clears first, then back to the bottom, then the interrupt', () => {
    const s = mainSession();
    s.input.feed(WHEEL_UP);
    s.frame();
    s.input.prompt = 'draft';
    s.input.cursorPos = 5;
    s.input.feed(ESC);
    expect(s.input.prompt).toBe('');
    expect(s.transcript.scrolledBack).toBe(true);
    expect(s.turn.cancels).toBe(0);
    s.input.feed(ESC);
    s.frame();
    expect(s.transcript.scrolledBack).toBe(false);
    expect(s.turn.cancels).toBe(0);
    s.input.feed(ESC);
    expect(s.turn.cancels).toBe(1);
  });

  test('a modal open while scrolled closes first and leaves the scroll and the turn alone', () => {
    const s = mainSession();
    s.input.feed(WHEEL_UP);
    s.frame();
    s.input.helpOverlayActive = true;
    s.input.modalStack.push('help');
    s.input.feed(ESC);
    expect(s.input.helpOverlayActive).toBe(false);
    expect(s.transcript.scrolledBack).toBe(true);
    expect(s.turn.cancels).toBe(0);
  });
});

/** An EscapeState with no modal open and an empty composer, for the views. */
function viewEscape(views: EscapeState['sessionView'], cancel: () => void): EscapeState {
  const closed = { active: false, close: () => {} };
  return {
    prompt: '', cursorPos: 0, helpScrollOffset: 0, shortcutsScrollOffset: 0,
    helpOverlayActive: false, shortcutsOverlayActive: false, commandMode: false,
    modalStack: [], indicatorFocused: false,
    requestRender: () => {}, saveUndoState: () => {}, cancelGeneration: cancel, selectionCallback: null,
    bookmarkModal: { ...closed, open: () => {} },
    contextInspectorModal: { ...closed, open: () => {} },
    settingsModal: { ...closed, editingMode: false, cancelEdit: () => {} },
    configModal: { ...closed, reopen: () => {} },
    selectionModal: closed, sessionPickerModal: closed, profilePickerModal: closed, modelPicker: closed, filePicker: closed, blockActionsMenu: closed,
    autocompleteReset: () => {},
    surfaceModals: { active: false, escape: () => false },
    sessionView: views,
  } as unknown as EscapeState;
}

describe('Esc while an agent or process view is scrolled back', () => {
  for (const target of [{ kind: 'agent', id: 'eng' }, { kind: 'process', id: 'bg-1' }] as const) {
    test(`${target.kind} view: the first Esc returns to its live bottom, the next goes back; nothing is cancelled or stopped`, () => {
      const scene = makeViewScene();
      scene.views.open(target);
      renderViewScreen(scene, 80, 12); // a short screen: the view has more rows than fit
      scene.views.scroll(3);
      renderViewScreen(scene, 80, 12);
      expect(scene.views.scrolledBack()).toBe(true);
      expect(scene.views.escGoesToBottom()).toBe(true);
      let cancels = 0;
      handleEscape(viewEscape(scene.views, () => { cancels++; }));
      expect(scene.views.scrolledBack()).toBe(false);
      expect(scene.views.focus.current).toEqual(target);
      handleEscape(viewEscape(scene.views, () => { cancels++; }));
      expect(scene.views.focus.current).toEqual({ kind: 'main' });
      expect(cancels).toBe(0);
      expect(scene.log.killed).toEqual([]);
      expect(scene.log.stopped).toEqual([]);
    });

    test(`${target.kind} view: scrolled back, the pill shows and the status line says esc back to bottom; at the bottom neither`, () => {
      const scene = makeViewScene();
      scene.views.open(target);
      renderViewScreen(scene, 80, 12);
      scene.views.scroll(3);
      const text = (rows: ReturnType<typeof renderViewScreen>) => rows.map((l) => l.map((c) => c.char || ' ').join(''));
      const scrolled = text(renderViewScreen(scene, 80, 12, null, { escKey: scene.views.escGoesToBottom() }));
      expect(scrolled.some((r) => r.includes('↓ Back to bottom   esc'))).toBe(true);
      expect(scrolled[scrolled.length - 1]).toContain('esc  back to bottom');
      scene.views.follow();
      const bottom = text(renderViewScreen(scene, 80, 12));
      expect(bottom.some((r) => r.includes('Back to bottom'))).toBe(false);
      expect(bottom[bottom.length - 1]).not.toContain('back to bottom');
    });
  }

  test('a scroll past the top never leaves a short view scrolled back with nothing above', () => {
    const scene = makeViewScene();
    scene.views.open({ kind: 'process', id: 'bg-1' });
    renderViewScreen(scene, 80, 60); // everything fits
    scene.views.scroll(10);
    expect(scene.views.scrolledBack()).toBe(false);
  });
});
