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
