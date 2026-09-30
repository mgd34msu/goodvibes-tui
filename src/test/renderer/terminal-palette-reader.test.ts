/**
 * terminal-palette-reader.test.ts, the `system` theme gets the terminal's
 * palette even when the startup round cannot.
 *
 * Live defect (tmux 3.7c in Ghostty): display.theme 'system' fell back to the
 * goodvibes palette. Two causes, both covered here:
 *   - the batch was wrapped in tmux's DCS passthrough envelope, which tmux
 *     discards with allow-passthrough off (its default), while tmux answers
 *     the plain queries itself (see the unwrapped-write tests in
 *     terminal-bg-probe.test.ts and terminal-palette-probe.test.ts);
 *   - a query written while no tmux client is attached is dropped and never
 *     answered, and a reply slower than the window was never read. The reader
 *     retries (timer, focus-in, resize, input) and accepts late replies.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { installBackgroundThemeProbe, OSC11_QUERY } from '../../renderer/terminal-bg-probe.ts';
import { PALETTE_QUERIES, sweepPaletteReplies } from '../../renderer/terminal-palette-probe.ts';
import { TerminalPaletteReader } from '../../renderer/terminal-palette-reader.ts';
import { getTerminalPalette, resetTerminalPaletteForTests, type TerminalPalette } from '../../renderer/terminal-palette.ts';
import { activeThemeMode, activeTokens, getActiveThemeName, setActiveThemeMode, setActiveThemeName } from '../../renderer/theme.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { configGetStub } from '../helpers/config-manager-stub.ts';

const readers: TerminalPaletteReader[] = [];

afterEach(() => {
  for (const reader of readers.splice(0)) reader.dispose();
  setActiveThemeMode('dark');
  setActiveThemeName('goodvibes');
  resetTerminalPaletteForTests();
});

const ST = '\x1b\\';
const BATCH = OSC11_QUERY + PALETTE_QUERIES;
const osc = (code: string, body: string): string => `\x1b]${code};${body}${ST}`;

/** What tmux answered in the live run (Ghostty, tokyo-night-like palette). */
function tmuxReplies(background = 'rgb:1a1a/1b1b/2626'): string {
  let s = osc('11', background) + osc('10', 'rgb:a9a9/b1b1/d6d6');
  for (let i = 0; i < 16; i++) s += osc(`4;${i}`, i === 6 ? 'rgb:4444/9d9d/abab' : 'rgb:4141/4848/6868');
  return s;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function config(values: Record<string, unknown>): Pick<ConfigManager, 'get'> {
  return { get: configGetStub(values) };
}

interface Harness {
  readonly writes: string[];
  readonly forwarded: string[];
  repaints: number;
  resize: () => void;
  readonly filter: (chunk: string) => string;
}

/** installBackgroundThemeProbe with the system theme, fast windows and a manual clock. */
function install(values: Record<string, unknown>, retry: { retryDelayMs?: number; maxRounds?: number } = {}): Harness {
  const h: Harness = { writes: [], forwarded: [], repaints: 0, resize: () => {}, filter: (c) => c };
  const handle = installBackgroundThemeProbe({
    configManager: config({ 'display.theme': 'system', ...values }),
    isTTY: true,
    probePalette: true,
    timeoutMs: 10,
    paletteTimeoutMs: 15,
    paletteRetry: { retryDelayMs: retry.retryDelayMs ?? 60_000, maxRounds: retry.maxRounds ?? 6, minRoundSpacingMs: 0 },
    writeQuery: (b) => h.writes.push(b),
    requestRepaint: () => { h.repaints += 1; },
    forwardInput: (b) => h.forwarded.push(b),
    subscribeResize: (listener) => { h.resize = listener; },
  });
  return Object.assign(h, { filter: (chunk: string) => handle.filterInput(chunk) });
}

describe('system theme under tmux with no client attached at startup', () => {
  test('the startup round is dropped; the focus-in tmux sends on attach asks again and the palette re-themes', async () => {
    const h = install({ 'display.themeMode': 'dark' });
    expect(getActiveThemeName()).toBe('system');
    expect(h.writes).toEqual([BATCH]);
    const fallback = activeTokens().primary;
    await wait(40); // round 1 closes with nothing (tmux dropped the query)
    expect(getTerminalPalette()?.background).toBeUndefined();
    expect(activeTokens().primary).toBe(fallback); // still the goodvibes stand-in

    // Attach: tmux reports focus-in to the pane. The key passes through.
    expect(h.filter('\x1b[I')).toBe('\x1b[I');
    expect(h.writes).toEqual([BATCH, BATCH]);
    expect(h.filter(tmuxReplies())).toBe('');
    expect(getTerminalPalette()?.background).toBe('#1a1b26');
    expect(getTerminalPalette()?.ansi[6]).toBe('#449dab');
    expect(activeTokens().primary).not.toBe(fallback);
    expect(h.repaints).toBeGreaterThan(0);
  });

  test('a resize (attach from a differently sized client) also asks again', async () => {
    const h = install({ 'display.themeMode': 'dark' });
    await wait(40);
    h.resize();
    expect(h.writes).toEqual([BATCH, BATCH]);
  });

  test('a timed retry after the first frame asks again without any input', async () => {
    const h = install({ 'display.themeMode': 'dark' }, { retryDelayMs: 20 });
    await wait(90);
    expect(h.writes.length).toBeGreaterThanOrEqual(2);
    expect(h.writes.every((w) => w === BATCH)).toBe(true);
  });

  test('rounds stop at the cap on a terminal that never answers', async () => {
    const h = install({ 'display.themeMode': 'dark' }, { retryDelayMs: 5, maxRounds: 3 });
    await wait(200);
    expect(h.writes).toHaveLength(3);
  });

  test('once the palette is in, nothing asks again', () => {
    const h = install({ 'display.themeMode': 'dark' });
    h.filter(tmuxReplies());
    h.filter('\x1b[I');
    h.resize();
    expect(h.writes).toEqual([BATCH]);
  });

  test('auto mode: a light background that arrives after the background probe timed out still settles light', async () => {
    const h = install({ 'display.themeMode': 'auto' });
    await wait(40);
    expect(activeThemeMode()).toBe('dark');
    h.filter('\x1b[I');
    h.filter(tmuxReplies('rgb:f0f0/f0f0/f0f0'));
    expect(activeThemeMode()).toBe('light');
  });
});

describe('late replies', () => {
  test('a reply slower than the window (ssh) is removed from input and re-themes when it lands', async () => {
    const h = install({ 'display.themeMode': 'dark' });
    await wait(40);
    const repaintsBefore = h.repaints;
    expect(h.filter(`ab${tmuxReplies()}cd`)).toBe('abcd');
    expect(getTerminalPalette()?.foreground).toBe('#a9b1d6');
    expect(h.repaints).toBeGreaterThan(repaintsBefore);
  });

  test('sweepPaletteReplies never holds a lone Esc back', () => {
    expect(sweepPaletteReplies('\x1b')).toEqual({ out: '\x1b', replies: [] });
    expect(sweepPaletteReplies('x\x1b]4;3;rgb:ff/00/00\x07y')).toEqual({ out: 'xy', replies: [{ slot: 3, hex: '#ff0000' }] });
  });
});

describe('keys held at a round close', () => {
  test('an Esc pressed inside a retry window is handed on, not dropped', async () => {
    const h = install({ 'display.themeMode': 'dark' });
    await wait(40);
    h.filter('a'); // input starts retry round 2
    expect(h.writes).toHaveLength(2);
    expect(h.filter('\x1b')).toBe(''); // held: could be the start of a reply
    await wait(40);
    expect(h.forwarded).toEqual(['\x1b']);
  });
});

describe('TerminalPaletteReader', () => {
  test('publishes the empty startup result once, then the first palette with colours', async () => {
    const published: TerminalPalette[] = [];
    let writes = 0;
    const reader = new TerminalPaletteReader({ writeBatch: () => { writes += 1; }, onPalette: (p) => published.push(p), timeoutMs: 5, retryDelayMs: 60_000, minRoundSpacingMs: 0 });
    readers.push(reader);
    reader.start();
    await wait(25);
    expect(published).toHaveLength(1);
    expect(published[0]!.background).toBeUndefined();
    expect(reader.retry()).toBe(true);
    reader.feed(tmuxReplies());
    expect(published).toHaveLength(2);
    expect(published[1]!.background).toBe('#1a1b26');
    expect(reader.hasPalette).toBe(true);
    expect(writes).toBe(2);
  });
});
