/**
 * Kit modals and the one-level Esc:
 *  - the SurfaceModalHost pops exactly one level per Esc (a modal's own
 *    sub-level first), routes keys to the top modal only, and draws every
 *    open modal bottom to top;
 *  - handleEscape pops the host before anything else and never reaches the
 *    composer clear or the turn cancel while a kit modal is open; with none
 *    open, today's order (close modal, clear composer, cancel turn) holds;
 *  - the command palette (groups, learning, search words, run vs fill,
 *    ctrl+p toggles it) and ctrl+p's binding;
 *  - the confirm dialog (safe default, y/n, Esc is "no");
 *  - toasts (five seconds, newest first, at most three, the notification
 *    feed's warnings and criticals only).
 */
import { describe, expect, test } from 'bun:test';
import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import { SurfaceModalHost, type SurfaceModal } from '../../input/surface-modal-host.ts';
import { handleEscape } from '../../input/handler-modal-stack.ts';
import { CommandPalette, buildPaletteEntries, paletteScore, recordPaletteUse, resetPaletteUsageForTests } from '../../input/command-palette.ts';
import { ConfirmDialog, confirmThrough } from '../../input/confirm-dialog.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';
import { ToastCenter, bridgeNotificationFeedToToasts } from '../../renderer/toast-center.ts';
import { PanelNotificationFeed } from '../../panels/notifications-feed.ts';
import type { SlashCommand } from '../../input/command-registry.ts';
import { frameFromLayer } from '../helpers/surface-frame.ts';

const key = (name: string, extra: Partial<{ ctrl: boolean; shift: boolean }> = {}): InputToken =>
  ({ type: 'key', name, logicalName: name, ctrl: false, shift: false, meta: false, ...extra }) as InputToken;
const text = (value: string): InputToken => ({ type: 'text', value }) as InputToken;

function fakeModal(name: string, subLevels = 0): SurfaceModal & { seen: InputToken[]; closed: string[] } {
  let levels = subLevels;
  const modal = {
    name,
    seen: [] as InputToken[],
    closed: [] as string[],
    handleToken(token: InputToken) { modal.seen.push(token); },
    escape() {
      if (levels > 0) { levels--; return true; }
      return false;
    },
    render: () => ({ x: 0, y: 0, lines: [], dim: true }),
    onClose(reason: string) { modal.closed.push(reason); },
  };
  return modal;
}

describe('SurfaceModalHost', () => {
  test('Esc pops exactly one level: a sub-level, then the modal, then the modal under it', () => {
    const host = new SurfaceModalHost();
    const bottom = fakeModal('bottom');
    const top = fakeModal('top', 1);
    host.push(bottom);
    host.push(top);
    expect(host.escape()).toBe(true); // the top's sub-level
    expect(host.depth).toBe(2);
    expect(host.escape()).toBe(true); // the top modal
    expect(host.top()).toBe(bottom);
    expect(top.closed).toEqual(['escape']);
    expect(host.escape()).toBe(true); // the bottom modal
    expect(host.active).toBe(false);
    expect(host.escape()).toBe(false); // nothing left
  });

  test('keys go to the top modal only', () => {
    const host = new SurfaceModalHost();
    const bottom = fakeModal('bottom');
    const top = fakeModal('top');
    host.push(bottom);
    host.push(top);
    host.handleToken(text('a'));
    expect(top.seen).toHaveLength(1);
    expect(bottom.seen).toHaveLength(0);
  });

  test('every open modal renders, bottom first', () => {
    const host = new SurfaceModalHost();
    host.push(fakeModal('a'));
    host.push(fakeModal('b'));
    expect(host.render(100, 30)).toHaveLength(2);
  });
});

function escapeState(host: SurfaceModalHost, prompt = '') {
  let cancelled = 0;
  const state = {
    helpOverlayActive: false,
    shortcutsOverlayActive: false,
    commandMode: false,
    modalStack: [] as string[],
    modalReturnFocus: 'prompt' as 'prompt' | 'indicator',
    indicatorFocused: false,
    prompt,
    cursorPos: prompt.length,
    helpScrollOffset: 0,
    shortcutsScrollOffset: 0,
    requestRender: () => {},
    saveUndoState: () => {},
    cancelGeneration: () => { cancelled++; },
    selectionCallback: null,
    bookmarkModal: { active: false, open: () => {}, close: () => {} },
    settingsModal: { active: false, editingMode: false, cancelEdit: () => {}, open: () => {}, close: () => {} },
    sessionPickerModal: { active: false, open: () => {}, close: () => {} },
    profilePickerModal: { active: false, open: () => {}, close: () => {} },
    configModal: { active: false, close: () => {}, reopen: () => {} },
    contextInspectorModal: { active: false, open: () => {}, close: () => {} },
    modelPicker: { active: false, open: () => {}, close: () => {} },
    filePicker: { active: false, open: () => {}, close: () => {} },
    blockActionsMenu: { active: false, open: () => {}, close: () => {} },
    selectionModal: { active: false, open: () => {}, close: () => {} },
    autocompleteReset: () => {},
    surfaceModals: host,
  };
  return { state, cancelled: () => cancelled };
}

describe('handleEscape with kit modals', () => {
  test('a kit modal is popped first; the composer and the turn are untouched', () => {
    const host = new SurfaceModalHost();
    host.push(fakeModal('palette'));
    const { state, cancelled } = escapeState(host, 'draft');
    const result = handleEscape(state);
    expect(host.active).toBe(false);
    expect(result.prompt).toBe('draft');
    expect(cancelled()).toBe(0);
  });

  test('with nothing open, today\'s order holds: clear the composer, then cancel the turn', () => {
    const host = new SurfaceModalHost();
    const { state, cancelled } = escapeState(host, 'draft');
    const first = handleEscape(state);
    expect(first.prompt).toBe('');
    expect(cancelled()).toBe(0);
    state.prompt = '';
    handleEscape(state);
    expect(cancelled()).toBe(1);
  });
});

const COMMANDS: SlashCommand[] = [
  { name: 'changes', description: 'Changed files and review.', handler: () => {} },
  { name: 'diff', description: 'Show the working-tree diff.', handler: () => {} },
  { name: 'model', description: 'Select the model.', aliases: ['m'], handler: () => {} },
  { name: 'compact', description: 'Compact context.', handler: () => {} },
  { name: 'resume', description: 'Resume a session.', usage: '<id|name>', handler: () => {} },
  { name: 'agents', description: 'Everything running.', handler: () => {} },
  { name: 'usage', description: 'Context and cost.', handler: () => {} },
  { name: 'settings', description: 'Open the settings.', handler: () => {} },
  { name: 'zzz-extra', description: 'Something else entirely.', handler: () => {} },
];

function palette(onRun: (id: string, mode: string) => void = () => {}): CommandPalette {
  return new CommandPalette({ entries: buildPaletteEntries(COMMANDS, new Map()), onRun: (entry, mode) => onRun(entry.id, mode) });
}

describe('command palette', () => {
  test('with no query: Suggested, Session, Views, Settings, then every other command', () => {
    resetPaletteUsageForTests();
    const groups = palette().sections().map((s) => s.group);
    expect(groups).toEqual(['Suggested', 'Session', 'Views', 'Settings', 'Commands']);
    expect(palette().sections()[0]!.entries.map((e) => e.id)).toEqual(['changes', 'model', 'compact']);
  });

  test('Suggested learns from what is run', () => {
    resetPaletteUsageForTests();
    recordPaletteUse('zzz-extra');
    recordPaletteUse('zzz-extra');
    expect(palette().sections()[0]!.entries[0]!.id).toBe('zzz-extra');
    resetPaletteUsageForTests();
  });

  test('typing searches names, aliases, titles and search words (old pane names find their home)', () => {
    const entries = buildPaletteEntries(COMMANDS, new Map());
    const byId = (id: string) => entries.find((e) => e.id === id)!;
    expect(paletteScore(byId('agents'), 'fleet')).toBeGreaterThan(0);
    expect(paletteScore(byId('agents'), 'cockpit')).toBeGreaterThan(0);
    expect(paletteScore(byId('usage'), 'tokens')).toBeGreaterThan(0);
    expect(paletteScore(byId('changes'), 'git')).toBeGreaterThan(0);
    expect(paletteScore(byId('model'), 'm')).toBeGreaterThan(paletteScore(byId('compact'), 'm'));
    expect(paletteScore(byId('diff'), 'nothing-like-this')).toBe(0);
    const p = palette();
    for (const ch of 'mod') p.handleToken(text(ch), new SurfaceModalHost());
    expect(p.flat()[0]!.id).toBe('model');
  });

  test('Enter runs a command; one with required arguments (and tab, always) fills the composer instead', () => {
    const runs: string[] = [];
    const host = new SurfaceModalHost();
    const p = palette((id, mode) => runs.push(`${id}:${mode}`));
    host.push(p);
    host.handleToken(key('enter'));
    expect(runs).toEqual(['changes:run']);
    expect(host.active).toBe(false);

    const q = palette((id, mode) => runs.push(`${id}:${mode}`));
    host.push(q);
    for (const ch of 'resume') host.handleToken(text(ch));
    host.handleToken(key('enter'));
    expect(runs[1]).toBe('resume:fill');

    const r = palette((id, mode) => runs.push(`${id}:${mode}`));
    host.push(r);
    host.handleToken(key('tab'));
    expect(runs[2]).toBe('changes:fill');
  });

  test('ctrl+p closes the palette again', () => {
    const host = new SurfaceModalHost();
    host.push(palette());
    host.handleToken(key('p', { ctrl: true }));
    expect(host.active).toBe(false);
  });

  test('ctrl+p (and ctrl+k) are bound to the command palette; ctrl+shift+p (the old pane picker) is bound to nothing', () => {
    const km = new KeybindingsManager({ configPath: '/nonexistent/keybindings.json' });
    expect(km.matches('command-palette', key('p', { ctrl: true }) as never)).toBe(true);
    expect(km.matches('command-palette', key('k', { ctrl: true }) as never)).toBe(true);
    expect(km.matches('command-palette', key('p', { ctrl: true, shift: true }) as never)).toBe(false);
    expect(km.lookup(key('p', { ctrl: true, shift: true }) as never)).toBeNull();
  });

  test('renders as a kit modal with the slash command right-aligned and a preview', () => {
    const frame = frameFromLayer(palette().render(120, 34), 120, 34).map((l) => l.map((c) => c.char).join('')).join('\n');
    expect(frame).toContain('✦ Commands');
    expect(frame).toMatch(/Changes +\/changes/);
    expect(frame).toMatch(/Show the working-tree diff +\/diff/);
    expect(frame).toContain('Enter runs it now');
    // The preview names the search words an entry answers to (old pane names included).
    expect(frame).toMatch(/Finds: changes, git, diff, review/);
  });
});

describe('confirm dialog', () => {
  test('a destructive dialog chooses the safe button by default; Enter then answers no', async () => {
    const host = new SurfaceModalHost();
    const answer = confirmThrough(host, { title: 'Delete session?', body: 'It cannot be undone.', confirmLabel: 'Delete', tone: 'danger' });
    host.handleToken(key('enter'));
    expect(await answer).toBe(false);
  });

  test('y answers yes; arrows move to the confirming button', async () => {
    const host = new SurfaceModalHost();
    const yes = confirmThrough(host, { title: 'x', body: 'y', confirmLabel: 'Go', tone: 'danger' });
    host.handleToken(text('y'));
    expect(await yes).toBe(true);
    const arrow = confirmThrough(host, { title: 'x', body: 'y', confirmLabel: 'Go', tone: 'danger' });
    host.handleToken(key('right'));
    host.handleToken(key('enter'));
    expect(await arrow).toBe(true);
  });

  test('Esc is a no', async () => {
    const host = new SurfaceModalHost();
    const answer = confirmThrough(host, { title: 'x', body: 'y', confirmLabel: 'Go' });
    host.escape();
    expect(await answer).toBe(false);
  });

  test('renders small and centered with the body wrapped and the red chip on the right', () => {
    const dialog = new ConfirmDialog({ title: 'Delete session?', body: 'This removes "test" and its 3 messages.\nIt cannot be undone.', confirmLabel: 'Delete', tone: 'danger' }, () => {});
    const layer = dialog.render(100, 30);
    expect(layer.lines[0]!.length).toBe(64);
    const rows = layer.lines.map((l) => l.map((c) => c.char).join(''));
    expect(rows.some((r) => r.includes('It cannot be undone.'))).toBe(true);
    const buttonRow = rows.find((r) => r.includes(' Delete '))!;
    expect(buttonRow.indexOf(' Cancel ')).toBeLessThan(buttonRow.indexOf(' Delete '));
  });
});

describe('toasts', () => {
  function center() {
    let now = 1_000;
    const scheduled: Array<{ at: number; run: () => void }> = [];
    const toasts = new ToastCenter(() => now, (run, delay) => { scheduled.push({ at: now + delay, run }); });
    const advance = (ms: number): void => {
      now += ms;
      for (const s of scheduled.filter((s) => s.at <= now)) s.run();
    };
    return { toasts, advance };
  }

  test('a toast shows for five seconds', () => {
    const { toasts, advance } = center();
    toasts.show({ title: 'Daemon restarted', tone: 'warning' });
    expect(toasts.visible()).toHaveLength(1);
    advance(4_999);
    expect(toasts.visible()).toHaveLength(1);
    advance(1);
    expect(toasts.visible()).toHaveLength(0);
  });

  test('newest first, at most three', () => {
    const { toasts } = center();
    for (const title of ['a', 'b', 'c', 'd']) toasts.show({ title, tone: 'info' });
    expect(toasts.visible().map((t) => t.title)).toEqual(['d', 'c', 'b']);
  });

  test('the notification feed toasts warnings and criticals, not information', () => {
    const { toasts } = center();
    const feed = new PanelNotificationFeed();
    bridgeNotificationFeedToToasts(feed, toasts);
    const note = (id: string, level: 'info' | 'warning' | 'critical') => ({ id, domain: 'agents', level, title: `n-${id}`, timestamp: 1 }) as never;
    feed.record(note('1', 'info'), { target: 'panel_only', reasonCode: 'default' } as never);
    feed.record(note('2', 'warning'), { target: 'panel_only', reasonCode: 'default' } as never);
    feed.record(note('3', 'critical'), { target: 'panel_only', reasonCode: 'default' } as never);
    expect(toasts.visible().map((t) => [t.title, t.tone])).toEqual([['n-3', 'error'], ['n-2', 'warning']]);
  });
});
