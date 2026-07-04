/**
 * Regression tests for the post-1.7.0 batch refutation findings (see the
 * cross-WO refutation review): (1) deep-link swallowed by an active session
 * tab, (2) MODAL_TONES dark-pinned across theme flips, (3) config-modal async
 * onOpen loads frozen at "Loading…" until a keypress, (4) queued-steer badge
 * rendered for a node with a stop in flight.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { ConfigModal } from '../../input/config-modal.ts';
import type { ConfigModalSurface, ConfigModalView } from '../../input/config-modal-types.ts';
import { MODAL_TONES } from '../../panels/modals/modal-theme.ts';
import { setActiveThemeMode, resolveUiTones } from '../../renderer/theme.ts';

afterEach(() => {
  setActiveThemeMode('dark');
});

describe('finding 2 — MODAL_TONES follows theme flips in place', () => {
  test('light flip rebuilds tones; dark restore returns originals', () => {
    const darkInfo = MODAL_TONES.info;
    expect(darkInfo).toBe(resolveUiTones('dark').state.info);

    setActiveThemeMode('light');
    expect(MODAL_TONES.info).toBe(resolveUiTones('light').state.info);
    expect(MODAL_TONES.primary).toBe(resolveUiTones('light').fg.primary);

    setActiveThemeMode('dark');
    expect(MODAL_TONES.info).toBe(darkInfo);
  });
});

describe('finding 3 — async onOpen loads paint before the first interaction', () => {
  function makeAsyncSurface(): { surface: ConfigModalSurface; finishLoad: () => void } {
    let loaded = false;
    const view = (): ConfigModalView => ({
      title: 'T',
      tabs: [{
        id: 'main', label: 'Main',
        rows: loaded
          ? [{ id: 'r1', label: 'row one', selectable: true }, { id: 'r2', label: 'row two', selectable: true }]
          : [{ id: 'loading', label: 'Loading…', selectable: false }],
      }],
    });
    return {
      surface: { name: 'async-test-modal', title: 'T', buildView: view },
      finishLoad: () => { loaded = true; },
    };
  }

  test('pre-interaction render syncs structure (no keypress needed)', () => {
    const { surface, finishLoad } = makeAsyncSurface();
    const modal = new ConfigModal();
    modal.open(surface);
    expect(modal.getRenderModel().rows.map((r) => r.id)).toEqual(['loading']);

    finishLoad(); // the async load's requestRender path re-renders:
    const ids = modal.getRenderModel().rows.map((r) => r.id);
    expect(ids).toEqual(['r1', 'r2']);
  });

  test('after the first interaction, structure freezes to boundaries again', () => {
    const { surface, finishLoad } = makeAsyncSurface();
    const modal = new ConfigModal();
    modal.open(surface);
    finishLoad();
    modal.getRenderModel(); // paints loaded content pre-interaction
    modal.noteInteraction();
    modal.syncStructure();

    // A post-interaction structural change must WAIT for the next boundary.
    const grown = surface.buildView as unknown as () => ConfigModalView;
    void grown;
    // mutate: swap the surface's view fn output by re-using finishLoad-style state
    // (rows already loaded; simulate a structural append via a wrapped surface)
    const base = surface.buildView;
    let appended = false;
    (surface as { buildView: () => ConfigModalView }).buildView = () => {
      const v = base();
      if (appended) v.tabs[0]!.rows.push({ id: 'r3', label: 'row three', selectable: true });
      return v;
    };
    appended = true;
    expect(modal.getRenderModel().rows.map((r) => r.id)).toEqual(['r1', 'r2']);
    modal.moveDown(); // interaction boundary
    expect(modal.getRenderModel().rows.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });
});
