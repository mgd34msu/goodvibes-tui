import { describe, expect, test } from 'bun:test';
import { ConfigModal } from '../../input/config-modal.ts';
import type {
  ConfigModalAction,
  ConfigModalActionContext,
  ConfigModalSurface,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import { renderConfigModal } from '../../renderer/config-modal.ts';
import { PanelManager } from '../../panels/panel-manager.ts';
import { handleConfigModalToken } from '../../input/handler-modal-routes.ts';
import { memoryModalGoldenSurface } from '../../panels/modals/memory-modal.ts';
import { marketplaceModalGoldenSurface } from '../../panels/modals/marketplace-modal.ts';

// A mutable fake surface so tests can drive live-value and structural changes.
function makeSurface(opts: {
  view: () => ConfigModalView;
  actions?: ConfigModalAction[];
  onAction?: (id: string, ctx: ConfigModalActionContext) => void;
  onOpen?: (r: () => void) => void;
  onClose?: () => void;
} & { name?: string }): ConfigModalSurface {
  return {
    name: opts.name ?? 'fake-modal',
    title: 'Fake',
    buildView: opts.view,
    actions: opts.actions,
    onAction: opts.onAction,
    onOpen: opts.onOpen,
    onClose: opts.onClose,
  };
}

/** Structural skeleton of a rendered frame: line count + border/indicator glyph
 *  columns per line. Two frames with identical skeletons have identical layout
 *  (rows did not reflow) even if value cells differ. */
function skeleton(lines: { char: string }[][]): string {
  return lines
    .map((line) =>
      line
        .map((cell, x) => ('│┤├┌┐└┘┼─▸'.includes(cell.char) ? `${x}:${cell.char}` : ''))
        .filter(Boolean)
        .join(','),
    )
    .join('\n');
}

function text(lines: { char: string }[][]): string {
  return lines.map((l) => l.map((c) => c.char).join('')).join('\n');
}

describe('ConfigModal host', () => {
  test('open selects the first tab and first selectable row; close resets', () => {
    const modal = new ConfigModal();
    const surface = makeSurface({
      view: () => ({
        title: 'T',
        tabs: [
          { id: 'a', label: 'Alpha', rows: [
            { id: 'hdr', label: '-- header --', selectable: false },
            { id: 'r1', label: 'Row 1' },
            { id: 'r2', label: 'Row 2' },
          ] },
          { id: 'b', label: 'Beta', rows: [{ id: 'x', label: 'X' }] },
        ],
      }),
    });
    expect(modal.active).toBe(false);
    modal.open(surface);
    expect(modal.active).toBe(true);
    expect(modal.getActiveTabId()).toBe('a');
    // skips the non-selectable header row
    expect(modal.getSelectedRowId()).toBe('r1');
    modal.close();
    expect(modal.active).toBe(false);
    expect(modal.getSurfaceName()).toBeNull();
  });

  test('tab switch moves to the next tab and resets selection', () => {
    const modal = new ConfigModal();
    modal.open(makeSurface({
      view: () => ({ title: 'T', tabs: [
        { id: 'a', label: 'A', rows: [{ id: 'r1', label: '1' }] },
        { id: 'b', label: 'B', rows: [{ id: 'r2', label: '2' }] },
      ] }),
    }));
    modal.nextTab();
    expect(modal.getActiveTabId()).toBe('b');
    expect(modal.getSelectedRowId()).toBe('r2');
    modal.prevTab();
    expect(modal.getActiveTabId()).toBe('a');
    expect(modal.getSelectedRowId()).toBe('r1');
  });

  test('up/down navigation skips non-selectable rows and wraps', () => {
    const modal = new ConfigModal();
    modal.open(makeSurface({
      view: () => ({ title: 'T', tabs: [
        { id: 'a', label: 'A', rows: [
          { id: 'r1', label: '1' },
          { id: 'note', label: 'note', selectable: false },
          { id: 'r2', label: '2' },
        ] },
      ] }),
    }));
    expect(modal.getSelectedRowId()).toBe('r1');
    modal.moveDown();
    expect(modal.getSelectedRowId()).toBe('r2'); // skipped 'note'
    modal.moveDown();
    expect(modal.getSelectedRowId()).toBe('r1'); // wrapped
    modal.moveUp();
    expect(modal.getSelectedRowId()).toBe('r2'); // wrapped back
  });

  test('liveness: live value changes update in place with a byte-stable layout', () => {
    let tick = 0;
    const modal = new ConfigModal();
    modal.setViewportRows(8);
    modal.open(makeSurface({
      view: () => ({ title: 'Providers', tabs: [
        { id: 'health', label: 'Health', header: [`online 1  latency ${tick}ms`], rows: [
          { id: 'openai', label: `openai   online   ${tick}ms` },
          { id: 'anthropic', label: `anthropic online ${tick + 5}ms` },
        ] },
      ] }),
    }));
    const frameA = renderConfigModal(modal, 90, 24);
    // Mutate ONLY live values — same structure, no key press.
    tick = 999;
    const frameB = renderConfigModal(modal, 90, 24);

    expect(frameB.length).toBe(frameA.length); // identical line count
    expect(skeleton(frameB)).toBe(skeleton(frameA)); // no structural reflow
    expect(text(frameB)).not.toBe(text(frameA)); // but values did change
    expect(text(frameB)).toContain('999ms');
    // selection row unchanged
    expect(modal.getSelectedRowId()).toBe('openai');
  });

  test('liveness: a structural change is deferred until the next interaction boundary', () => {
    let rowCount = 2;
    const modal = new ConfigModal();
    modal.open(makeSurface({
      view: () => ({ title: 'T', tabs: [
        { id: 'a', label: 'A', rows: Array.from({ length: rowCount }, (_, i) => ({ id: `r${i}`, label: `Row ${i}` })) },
      ] }),
    }));
    expect(modal.getRenderModel().scroll.total).toBe(2);
    // A new row appears in the read-model...
    rowCount = 3;
    // ...but a pure render tick still shows the frozen structure (2 rows).
    expect(modal.getRenderModel().scroll.total).toBe(2);
    // An interaction boundary (nav key) re-syncs the structure.
    modal.moveDown();
    expect(modal.getRenderModel().scroll.total).toBe(3);
  });

  test('liveness: a vanished row is kept in place (stale) until the next boundary', () => {
    let rows = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
    const modal = new ConfigModal();
    modal.open(makeSurface({ view: () => ({ title: 'T', tabs: [{ id: 't', label: 'T', rows }] }) }));
    rows = [{ id: 'a', label: 'A' }]; // 'b' disappears
    const model = modal.getRenderModel();
    expect(model.scroll.total).toBe(2); // still shows both
    const bRow = model.rows.find((r) => r.id === 'b');
    expect(bRow?.stale).toBe(true);
    modal.moveDown(); // boundary
    expect(modal.getRenderModel().scroll.total).toBe(1);
  });

  test('degraded read-model surfaces a banner but still renders', () => {
    const modal = new ConfigModal();
    modal.open(makeSurface({
      view: () => ({ title: 'T', degraded: 'runtime not wired', tabs: [
        { id: 'a', label: 'A', rows: [], emptyText: 'nothing here' },
      ] }),
    }));
    const model = modal.getRenderModel();
    expect(model.degraded).toBe('runtime not wired');
    expect(model.emptyText).toBe('nothing here');
    expect(text(renderConfigModal(modal, 90, 24))).toContain('runtime not wired');
  });

  test('non-destructive action fires immediately; destructive action needs a confirm', () => {
    const fired: string[] = [];
    const modal = new ConfigModal();
    modal.open(makeSurface({
      view: () => ({ title: 'T', tabs: [{ id: 'a', label: 'A', rows: [{ id: 'u1', label: 'user' }] }] }),
      actions: [
        { key: 'r', id: 'refresh', label: 'refresh' },
        { key: 'd', id: 'delete', label: 'delete user', confirm: true },
      ],
      onAction: (id) => fired.push(id),
    }));
    const ctx = { print: () => {}, executeCommand: undefined };

    expect(modal.fireAction('r', ctx)).toBe(true);
    expect(fired).toEqual(['refresh']);

    // First 'd' arms the confirm (no fire), second 'd' commits.
    expect(modal.fireAction('d', ctx)).toBe(true);
    expect(fired).toEqual(['refresh']);
    expect(modal.getStatusMessage()).toContain('again to delete user');
    expect(modal.fireAction('d', ctx)).toBe(true);
    expect(fired).toEqual(['refresh', 'delete']);

    // A key with no bound action is not consumed by fireAction.
    expect(modal.fireAction('z', ctx)).toBe(false);
  });

  test('enabledFor gates an action to matching rows', () => {
    const fired: string[] = [];
    const modal = new ConfigModal();
    modal.open(makeSurface({
      view: () => ({ title: 'T', tabs: [{ id: 'a', label: 'A', rows: [
        { id: 'profile:x', label: 'profile' },
        { id: 'session:y', label: 'session' },
      ] }] }),
      actions: [
        { key: 'x', id: 'stop', label: 'stop', enabledFor: (row) => !!row?.id.startsWith('session:') },
      ],
      onAction: (id) => fired.push(id),
    }));
    // On the profile row, stop is not enabled.
    expect(modal.getSelectedRowId()).toBe('profile:x');
    expect(modal.fireAction('x', ctxNoop())).toBe(false);
    modal.moveDown();
    expect(modal.getSelectedRowId()).toBe('session:y');
    expect(modal.fireAction('x', ctxNoop())).toBe(true);
    expect(fired).toEqual(['stop']);
  });

  test('onOpen/onClose fire exactly once and drive live refresh', () => {
    let opens = 0;
    let closes = 0;
    const modal = new ConfigModal();
    const surface = makeSurface({
      view: () => ({ title: 'T', tabs: [{ id: 'a', label: 'A', rows: [] }] }),
      onOpen: () => { opens++; },
      onClose: () => { closes++; },
    });
    modal.open(surface);
    expect(opens).toBe(1);
    modal.close();
    expect(closes).toBe(1);
  });

  test('PanelManager: modal-redirect fires the openModal callback without constructing a panel', () => {
    const pm = new PanelManager();
    const opened: string[] = [];
    pm.setOpenModalCallback((name) => opened.push(name));
    pm.registerModalRedirect('services', 'services-modal');
    const returned = pm.open('services');
    expect(opened).toEqual(['services-modal']);
    // sentinel: transient, never retained, carries the modal name honestly
    expect(returned.isTransient).toBe(true);
    expect(returned.name).toBe('services-modal');
    expect(pm.getAllOpen().length).toBe(0);
  });

  test('PanelManager: surface registry roundtrips by modal name', () => {
    const pm = new PanelManager();
    const surface = makeSurface({ name: 'services-modal', view: () => ({ title: 'S', tabs: [] }) });
    pm.registerModalSurface(surface);
    expect(pm.getModalSurface('services-modal')).toBe(surface);
    expect(pm.getModalSurface('nope')).toBeUndefined();
  });
});

function ctxNoop() {
  return { print: () => {}, executeCommand: undefined };
}

// ── DEBT-5 item 1: config-modal host '/' type-to-filter ─────────────────────

describe('ConfigModal host — type-to-filter (DEBT-5 item 1)', () => {
  test('/ arms the filter; typed text narrows rows on a real surface (memory-modal)', () => {
    const modal = new ConfigModal();
    modal.open(memoryModalGoldenSurface());
    modal.moveDown(); // interaction boundary: freeze structure against the now-loaded records (onOpen's refresh() runs after the initial buildView())
    expect(modal.getRenderModel().scroll.total).toBe(2);
    expect(modal.isFilterActive()).toBe(false);

    modal.activateFilter();
    expect(modal.isFilterActive()).toBe(true);
    modal.appendFilterText('b');
    modal.appendFilterText('a');
    modal.appendFilterText('tches');
    expect(modal.getFilterQuery()).toBe('batches');
    const model = modal.getRenderModel();
    expect(model.rows.length).toBe(1);
    expect(model.rows[0]!.label).toContain('batches');
  });

  test('a multi-char paste token lands in the filter atomically (handleConfigModalToken) — not split into per-char nav/close', () => {
    const modal = new ConfigModal();
    modal.open(memoryModalGoldenSurface());
    const state = { configModal: modal, requestRender: () => {}, handleEscape: () => modal.close() };
    handleConfigModalToken(state, { type: 'text', value: '/' } as never);
    expect(modal.isFilterActive()).toBe(true);
    // A real bracketed paste is ONE token holding the whole string, including
    // characters ('j', 'k') that would otherwise be nav aliases.
    handleConfigModalToken(state, { type: 'text', value: 'j and k are text now' } as never);
    expect(modal.getFilterQuery()).toBe('j and k are text now');
    expect(modal.active).toBe(true); // never closed — 'k' didn't leak through as a hotkey
  });

  test('backspace edits the query one character at a time', () => {
    const modal = new ConfigModal();
    modal.open(memoryModalGoldenSurface());
    modal.activateFilter();
    modal.appendFilterText('charter');
    modal.backspaceFilter();
    expect(modal.getFilterQuery()).toBe('charte');
  });

  test('Esc two-stage: a non-empty query is cleared first; a second Esc (now empty) closes — single-Esc-close preserved for the no-filter case', () => {
    const modal = new ConfigModal();
    let closed = false;
    modal.open(memoryModalGoldenSurface());
    const state = { configModal: modal, requestRender: () => {}, handleEscape: () => { closed = true; modal.close(); } };
    const escToken = { type: 'key', name: '\x1b', logicalName: 'escape', ctrl: false, shift: false, meta: false } as never;

    handleConfigModalToken(state, { type: 'text', value: '/' } as never);
    handleConfigModalToken(state, { type: 'text', value: 'charter' } as never);
    expect(modal.getFilterQuery()).toBe('charter');

    handleConfigModalToken(state, escToken);
    expect(modal.getFilterQuery()).toBe('');
    expect(modal.active).toBe(true); // NOT closed yet — the one documented exception
    expect(closed).toBe(false);

    handleConfigModalToken(state, escToken);
    expect(closed).toBe(true); // second Esc, now with an empty filter, closes normally
  });

  test('Esc with the filter armed but never typed into closes in a single press (no query to clear)', () => {
    const modal = new ConfigModal();
    let closed = false;
    modal.open(memoryModalGoldenSurface());
    const state = { configModal: modal, requestRender: () => {}, handleEscape: () => { closed = true; modal.close(); } };
    handleConfigModalToken(state, { type: 'text', value: '/' } as never);
    expect(modal.isFilterActive()).toBe(true);
    handleConfigModalToken(state, { type: 'key', name: '\x1b', logicalName: 'escape', ctrl: false, shift: false, meta: false } as never);
    expect(closed).toBe(true);
  });

  test('liveness holds between filter keystrokes: a values-only tick on a still-matching row repaints in place without reflowing the filtered list', () => {
    let val = 0;
    const modal = new ConfigModal();
    modal.open(makeSurface({
      view: () => ({ title: 'T', tabs: [{ id: 'a', label: 'A', rows: [
        { id: 'r1', label: `alpha row ${val}` },
        { id: 'r2', label: `alpha other ${val}` },
        { id: 'r3', label: 'beta unrelated' },
      ] }] }),
    }));
    modal.activateFilter();
    modal.appendFilterText('alpha'); // interaction boundary: freezes r1+r2 only
    expect(modal.getRenderModel().scroll.total).toBe(2);
    const frameA = renderConfigModal(modal, 90, 24);

    val = 999; // values-only tick — no keystroke
    const frameB = renderConfigModal(modal, 90, 24);

    expect(frameB.length).toBe(frameA.length);
    expect(skeleton(frameB)).toBe(skeleton(frameA));
    expect(text(frameB)).toContain('999');
    expect(modal.getRenderModel().scroll.total).toBe(2); // still filtered to 2, not reflowed to 3
  });

  test('a structural change to the underlying data while filtering is still deferred until the next interaction (any nav key, not just a filter keystroke)', () => {
    let rows = [{ id: 'r1', label: 'alpha one' }, { id: 'r2', label: 'beta two' }];
    const modal = new ConfigModal();
    modal.open(makeSurface({ view: () => ({ title: 'T', tabs: [{ id: 'a', label: 'A', rows }] }) }));
    modal.activateFilter();
    modal.appendFilterText('alpha');
    expect(modal.getRenderModel().scroll.total).toBe(1);
    rows = [...rows, { id: 'r3', label: 'alpha three' }]; // a new matching row appears live
    expect(modal.getRenderModel().scroll.total).toBe(1); // still frozen — no interaction yet
    modal.moveDown(); // any interaction boundary re-syncs, including under an active filter
    expect(modal.getRenderModel().scroll.total).toBe(2);
  });

  test('empty-result honest line: a query matching nothing shows "No rows match" instead of the surface\'s generic empty text', () => {
    const modal = new ConfigModal();
    modal.open(memoryModalGoldenSurface());
    modal.activateFilter();
    modal.appendFilterText('zzz-no-such-record-zzz');
    const model = modal.getRenderModel();
    expect(model.rows.some((r) => r.label === 'No rows match "zzz-no-such-record-zzz".')).toBe(true);
    expect(model.hints[0]).toContain('0 of 2 match');
  });

  test('footer shows the query and a truthful match count; suppresses the surface\'s own (now-inert) action hints while filtering', () => {
    const modal = new ConfigModal();
    modal.open(memoryModalGoldenSurface());
    modal.activateFilter();
    modal.appendFilterText('charter');
    const model = modal.getRenderModel();
    expect(model.hints).toContain('/charter — 1 of 2 match');
    expect(model.hints).toContain('Esc clear · Esc close');
    expect(model.hints.some((h) => h.includes('refresh'))).toBe(false);
  });

  test('filtering resets on tab switch — a query is scoped to the tab it was typed against', () => {
    const modal = new ConfigModal();
    modal.open(memoryModalGoldenSurface()); // two tabs: All Records / Review Queue
    modal.activateFilter();
    modal.appendFilterText('charter');
    expect(modal.isFilterActive()).toBe(true);
    modal.nextTab();
    expect(modal.isFilterActive()).toBe(false);
    expect(modal.getFilterQuery()).toBe('');
  });

  test('marketplace-modal: filtering an already-empty catalog does not inject a spurious "no match" line (nothing to filter in the first place)', () => {
    const modal = new ConfigModal();
    modal.open(marketplaceModalGoldenSurface());
    modal.activateFilter();
    modal.appendFilterText('anything');
    const model = modal.getRenderModel();
    expect(model.rows.some((r) => r.label.startsWith('No rows match'))).toBe(false);
  });
});

// ── DEBT-5 item 2: wrap-clamp the live-label overlay ────────────────────────

describe('ConfigModal host — wrap-clamp overlay (DEBT-5 item 2)', () => {
  test('a live label growing past the wrap width is clamped to the frozen line count with an ellipsis; the full label appears after a keypress', () => {
    let label = 'short label';
    const modal = new ConfigModal();
    modal.open(makeSurface({
      view: () => ({ title: 'T', tabs: [{ id: 'a', label: 'A', rows: [{ id: 'r1', label }] }] }),
    }));
    const width = 20;
    const before = modal.getRenderModel(width);
    const beforeLineCount = before.rows[0]!.label.split('\n').length;
    expect(beforeLineCount).toBe(1);

    label = 'this label has grown much longer than the wrap width now'; // no interaction yet
    const after = modal.getRenderModel(width);
    const afterLines = after.rows[0]!.label.split('\n');
    expect(afterLines.length).toBe(beforeLineCount); // same line footprint — no structural growth
    expect(afterLines[afterLines.length - 1]!.endsWith('…')).toBe(true);

    modal.moveDown(); // an interaction boundary re-freezes structure
    const afterKeypress = modal.getRenderModel(width);
    expect(afterKeypress.rows[0]!.label).toBe(label); // full label, unclamped
  });

  test('a live label that wraps to the SAME or FEWER lines than frozen passes through untouched', () => {
    let label = 'a moderately long label that wraps into two lines total here';
    const modal = new ConfigModal();
    modal.open(makeSurface({
      view: () => ({ title: 'T', tabs: [{ id: 'a', label: 'A', rows: [{ id: 'r1', label }] }] }),
    }));
    const width = 30;
    modal.getRenderModel(width); // establish the frozen baseline
    label = 'short now';
    const after = modal.getRenderModel(width);
    expect(after.rows[0]!.label).toBe('short now');
    expect(after.rows[0]!.label).not.toContain('…');
  });

  test('the rendered frame line count stays stable when a live label grows past the wrap width mid-tick', () => {
    let label = 'short';
    const modal = new ConfigModal();
    modal.open(makeSurface({
      view: () => ({ title: 'T', tabs: [{ id: 'a', label: 'A', rows: [{ id: 'r1', label }] }] }),
    }));
    const frameA = renderConfigModal(modal, 90, 24);
    label = 'x'.repeat(300); // guaranteed to wrap into many lines at any real terminal width
    const frameB = renderConfigModal(modal, 90, 24);
    expect(frameB.length).toBe(frameA.length);
    expect(text(frameB)).toContain('…');
  });
});
