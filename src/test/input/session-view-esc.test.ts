// Esc inside an agent or process view goes back up and never stops anything:
// not main's turn (cancelGeneration), not the agent, not the process. Stopping
// there is ctrl+x twice.

import { describe, expect, test } from 'bun:test';
import { handleEscape, type EscapeState } from '../../input/handler-modal-stack.ts';
import { handleSessionViewToken, type SessionViewRouteState } from '../../input/handler-session-view-route.ts';
import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import { makeViewScene, type ViewScene } from '../helpers/session-view-scenes.ts';

/** An EscapeState with no modal open, the given composer text and the scene's views. */
function escapeState(scene: ViewScene | null, prompt: string, cancel: () => void, modalOpen = false): EscapeState {
  const closed = { active: false, close: () => {} };
  return {
    prompt, cursorPos: prompt.length, helpScrollOffset: 0, shortcutsScrollOffset: 0,
    helpOverlayActive: false, shortcutsOverlayActive: false, commandMode: false,
    modalStack: [], indicatorFocused: false,
    requestRender: () => {}, saveUndoState: () => {}, cancelGeneration: cancel, selectionCallback: null,
    bookmarkModal: { ...closed, open: () => {} },
    contextInspectorModal: { ...closed, open: () => {} },
    settingsModal: { ...closed, editingMode: false, cancelEdit: () => {} },
    configModal: { ...closed, reopen: () => {} },
    selectionModal: closed, sessionPickerModal: closed, profilePickerModal: closed, modelPicker: closed, filePicker: closed, blockActionsMenu: closed,
    autocompleteReset: () => {},
    surfaceModals: modalOpen ? { active: true, escape: () => true } : { active: false, escape: () => false },
    sessionView: scene?.views,
  } as unknown as EscapeState;
}

const key = (name: string, mods: { ctrl?: boolean; shift?: boolean } = {}): InputToken => ({ type: 'key', logicalName: name, ctrl: mods.ctrl ?? false, meta: false, shift: mods.shift ?? false } as InputToken);
const text = (value: string): InputToken => ({ type: 'text', value } as InputToken);

function route(scene: ViewScene, prompt = ''): SessionViewRouteState {
  return { controls: scene.views, prompt, cursorPos: prompt.length, commandMode: false, saveUndoState: () => {}, requestRender: () => {} };
}

describe('Esc inside an agent or process view', () => {
  test('in an agent view Esc goes back to main and never calls cancelGeneration or stops the agent', () => {
    const scene = makeViewScene();
    scene.views.open({ kind: 'agent', id: 'eng' });
    let cancels = 0;
    handleEscape(escapeState(scene, '', () => { cancels++; }));
    expect(scene.views.focus.current).toEqual({ kind: 'main' });
    expect(cancels).toBe(0);
    expect(scene.log.killed).toEqual([]);
    expect(scene.log.stopped).toEqual([]);
  });

  test('from a child agent Esc goes to its parent agent first, then main, never cancelling', () => {
    const scene = makeViewScene();
    scene.views.open({ kind: 'agent', id: 'tester' });
    let cancels = 0;
    handleEscape(escapeState(scene, '', () => { cancels++; }));
    expect(scene.views.focus.current).toEqual({ kind: 'agent', id: 'eng' });
    handleEscape(escapeState(scene, '', () => { cancels++; }));
    expect(scene.views.focus.current).toEqual({ kind: 'main' });
    expect(cancels).toBe(0);
    expect(scene.log.killed).toEqual([]);
  });

  test('in a process view Esc closes the search first, then goes back; the process keeps running', () => {
    const scene = makeViewScene();
    scene.views.open({ kind: 'process', id: 'bg-1' });
    scene.views.startSearch();
    let cancels = 0;
    handleEscape(escapeState(scene, '', () => { cancels++; }));
    expect(scene.views.searchEditing).toBe(false);
    expect(scene.views.focus.current).toEqual({ kind: 'process', id: 'bg-1' });
    handleEscape(escapeState(scene, '', () => { cancels++; }));
    expect(scene.views.focus.current).toEqual({ kind: 'main' });
    expect(cancels).toBe(0);
    expect(scene.log.stopped).toEqual([]);
  });

  test('the earlier steps keep their order: a modal closes first, then the composer clears', () => {
    const scene = makeViewScene();
    scene.views.open({ kind: 'agent', id: 'eng' });
    let cancels = 0;
    handleEscape(escapeState(scene, '', () => { cancels++; }, true));
    expect(scene.views.focus.current).toEqual({ kind: 'agent', id: 'eng' });
    const cleared = handleEscape(escapeState(scene, 'draft', () => { cancels++; }));
    expect(cleared.prompt).toBe('');
    expect(scene.views.focus.current).toEqual({ kind: 'agent', id: 'eng' });
    expect(cancels).toBe(0);
  });

  test('in main (no view open) Esc still interrupts the turn', () => {
    const scene = makeViewScene();
    let cancels = 0;
    handleEscape(escapeState(scene, '', () => { cancels++; }));
    expect(cancels).toBe(1);
  });

  test('many Esc presses in views never reach cancelGeneration and never stop anything', () => {
    const scene = makeViewScene();
    let cancels = 0;
    for (const target of [{ kind: 'agent', id: 'tester' }, { kind: 'agent', id: 'eng' }, { kind: 'process', id: 'bg-1' }] as const) {
      scene.views.open(target);
      while (scene.views.active) handleEscape(escapeState(scene, '', () => { cancels++; }));
    }
    expect(cancels).toBe(0);
    expect(scene.log.killed).toEqual([]);
    expect(scene.log.stopped).toEqual([]);
  });
});

describe('ctrl+x in a view asks first', () => {
  test('one press stops nothing and the status line asks for the second; the second stops the agent', () => {
    const scene = makeViewScene();
    scene.views.open({ kind: 'agent', id: 'eng' });
    expect(handleSessionViewToken(route(scene), key('x', { ctrl: true }))).toBe(true);
    expect(scene.log.killed).toEqual([]);
    expect(scene.views.frame(120)?.footer.notice?.text).toBe('Press ctrl+x again to stop engineer');
    handleSessionViewToken(route(scene), key('x', { ctrl: true }));
    expect(scene.log.killed).toEqual(['eng']);
  });

  test('the confirming press must come within 3 seconds', () => {
    const scene = makeViewScene();
    scene.views.open({ kind: 'process', id: 'bg-1' });
    handleSessionViewToken(route(scene), key('x', { ctrl: true }));
    scene.setNow(Date.now() + 1_000_000_000_000);
    handleSessionViewToken(route(scene), key('x', { ctrl: true }));
    expect(scene.log.stopped).toEqual([]);
    handleSessionViewToken(route(scene), key('x', { ctrl: true }));
    expect(scene.log.stopped).toEqual(['bg-1']);
  });
});

describe('the session view keys', () => {
  test('Tab cycles the chips only with an empty composer; with text it keeps its completion meaning', () => {
    const scene = makeViewScene();
    expect(handleSessionViewToken(route(scene, 'src/'), key('tab'))).toBe(false);
    expect(scene.views.focus.current).toEqual({ kind: 'main' });
    expect(handleSessionViewToken(route(scene), key('tab'))).toBe(true);
    expect(scene.views.focus.current).toEqual({ kind: 'agent', id: 'eng' });
    expect(handleSessionViewToken(route(scene), key('tab', { shift: true }))).toBe(true);
    expect(scene.views.focus.current).toEqual({ kind: 'main' });
  });

  test('with only main, Tab and Shift+Tab are left alone (completion and mode cycling keep them)', () => {
    const scene = makeViewScene({ withProcess: false, withTester: false });
    scene.finishAgent('eng');
    expect(scene.views.chipsVisible()).toBe(false);
    expect(handleSessionViewToken(route(scene), key('tab'))).toBe(false);
    expect(handleSessionViewToken(route(scene), key('tab', { shift: true }))).toBe(false);
  });

  test('Enter in an agent view steers the agent with the composer text and clears it; main is not submitted', () => {
    const scene = makeViewScene();
    scene.views.open({ kind: 'agent', id: 'eng' });
    const state = route(scene, 'also cap the jitter');
    expect(handleSessionViewToken(state, key('enter'))).toBe(true);
    expect(scene.log.steers).toEqual([{ id: 'eng', text: 'also cap the jitter' }]);
    expect(state.prompt).toBe('');
  });

  test('in a process view letters are the view keys: / searches, y copies, other letters are refused', () => {
    const scene = makeViewScene();
    scene.views.open({ kind: 'process', id: 'bg-1' });
    handleSessionViewToken(route(scene), text('y'));
    expect(scene.log.copied[0]).toContain('VITE v6.2.0');
    handleSessionViewToken(route(scene), text('/'));
    expect(scene.views.searchEditing).toBe(true);
    handleSessionViewToken(route(scene), text('hmr'));
    const lines = scene.views.frame(120)!.body(20);
    expect(lines.some((l) => l.map((c) => c.char).join('').includes('/ hmr'))).toBe(true);
    const state = route(scene);
    handleSessionViewToken(state, key('escape'));
    expect(state.prompt).toBe('');
  });

  test('the process view states it takes no input, and says why', () => {
    const scene = makeViewScene();
    scene.views.open({ kind: 'process', id: 'bg-1' });
    expect(scene.views.frame(120)?.footer.disabledReason).toContain('stdin');
  });
});
