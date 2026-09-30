/**
 * terminal-palette-probe.test.ts, fake-terminal harness for the OSC 10 / OSC 4
 * palette probe and its batching with the OSC 11 background probe.
 *
 * Covers the parser (1-4 digit channels, rgba, # forms, garbage), the stream
 * filter (BEL and ST terminators, interleaved keystrokes, replies split across
 * chunks, partial and missing replies, garbage bodies), the window/timeout, and
 * installBackgroundThemeProbe's single batched write (plain, and unwrapped under tmux) with the
 * result landing in the terminal-palette store.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  installBackgroundThemeProbe,
  OSC11_QUERY,
} from '../../renderer/terminal-bg-probe.ts';
import {
  PALETTE_PROBE_TIMEOUT_MS,
  PALETTE_QUERIES,
  type PaletteProbeResolution,
  parseOscColorToHex,
  TerminalPaletteProbe,
} from '../../renderer/terminal-palette-probe.ts';
import {
  getTerminalPalette,
  onTerminalPalette,
  resetTerminalPaletteForTests,
  type TerminalPalette,
} from '../../renderer/terminal-palette.ts';
import { activeTheme, resolveTheme, setActiveThemeMode } from '../../renderer/theme.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { configGetStub } from '../helpers/config-manager-stub.ts';

afterEach(() => {
  setActiveThemeMode('dark');
  resetTerminalPaletteForTests();
});

const BEL = '\x07';
const ST = '\x1b\\';

const osc = (code: string, body: string, term = ST): string => `\x1b]${code};${body}${term}`;
const ansiReply = (n: number, body: string, term = ST): string => osc(`4;${n}`, body, term);

/** Hex for slot n used by fullReplies(): #0n0n0n style, distinct per slot. */
const slotHex = (n: number): string => `#${n.toString(16).padStart(2, '0').repeat(3)}`;
const slotBody = (n: number): string => {
  const c = n.toString(16).padStart(2, '0');
  return `rgb:${c}${c}/${c}${c}/${c}${c}`;
};

/** Every reply a cooperating terminal sends back for the batch, in order. */
function fullReplies(term = ST): string {
  let s = osc('11', 'rgb:1e1e/1e1e/1e1e', term) + osc('10', 'rgb:dddd/dddd/dddd', term);
  for (let i = 0; i < 16; i++) s += ansiReply(i, slotBody(i), term);
  return s;
}

function expectedFullPalette(): TerminalPalette {
  return {
    background: '#1e1e1e',
    foreground: '#dddddd',
    ansi: Array.from({ length: 16 }, (_, i) => slotHex(i)),
  };
}

function makeProbe(out: PaletteProbeResolution[], timeoutMs = 1_000): TerminalPaletteProbe {
  return new TerminalPaletteProbe({ timeoutMs, onResolve: (r) => out.push(r) });
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// parseOscColorToHex
// ---------------------------------------------------------------------------

describe('parseOscColorToHex', () => {
  test('1-digit channels scale against 0xf', () => {
    expect(parseOscColorToHex('rgb:f/0/8')).toBe('#ff0088');
  });

  test('2-digit channels are taken as bytes', () => {
    expect(parseOscColorToHex('rgb:1e/80/ff')).toBe('#1e80ff');
  });

  test('3-digit channels scale against 0xfff', () => {
    expect(parseOscColorToHex('rgb:fff/000/800')).toBe('#ff0080');
  });

  test('4-digit channels scale against 0xffff', () => {
    expect(parseOscColorToHex('rgb:ffff/0000/8000')).toBe('#ff0080');
    expect(parseOscColorToHex('rgb:1e1e/1e1e/1e1e')).toBe('#1e1e1e');
  });

  test('mixed widths per channel', () => {
    expect(parseOscColorToHex('rgb:f/ff/ffff')).toBe('#ffffff');
  });

  test('uppercase hex and surrounding whitespace', () => {
    // Scaled, not truncated: 0xEF01 / 0xFFFF * 255 = 238.07 -> ee.
    expect(parseOscColorToHex(' rgb:ABCD/EF01/2345 ')).toBe('#abee23');
  });

  test('rgba: ignores alpha, # forms accepted', () => {
    expect(parseOscColorToHex('rgba:ffff/0000/0000/8000')).toBe('#ff0000');
    expect(parseOscColorToHex('#12ab34')).toBe('#12ab34');
    expect(parseOscColorToHex('#1212abab3434')).toBe('#12ab34');
  });

  test('garbage returns null', () => {
    expect(parseOscColorToHex('')).toBeNull();
    expect(parseOscColorToHex('?')).toBeNull();
    expect(parseOscColorToHex('notacolor')).toBeNull();
    expect(parseOscColorToHex('rgb:zz/00/00')).toBeNull();
    expect(parseOscColorToHex('rgb:ff/ff')).toBeNull();
    expect(parseOscColorToHex('rgb:ff/ff/ff/ff')).toBeNull();
    expect(parseOscColorToHex('rgb:fffff/0/0')).toBeNull(); // 5 digits
    expect(parseOscColorToHex('rgb://')).toBeNull();
    expect(parseOscColorToHex('#abc')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Query bytes + budget
// ---------------------------------------------------------------------------

describe('palette queries and budget', () => {
  test('PALETTE_QUERIES is ST-terminated OSC 10 then OSC 4;0..15 in order', () => {
    let expected = '\x1b]10;?\x1b\\';
    for (let i = 0; i < 16; i++) expected += `\x1b]4;${i};?\x1b\\`;
    expect(PALETTE_QUERIES).toBe(expected);
  });

  test('palette window is the background window (150 ms) plus a 25 ms margin', () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(150);
    expect(PALETTE_PROBE_TIMEOUT_MS).toBe(DEFAULT_PROBE_TIMEOUT_MS + 25);
  });
});

// ---------------------------------------------------------------------------
// TerminalPaletteProbe.feed
// ---------------------------------------------------------------------------

describe('TerminalPaletteProbe.feed', () => {
  test('all 18 ST-terminated replies resolve complete and are fully consumed', () => {
    const out: PaletteProbeResolution[] = [];
    const probe = makeProbe(out);
    expect(probe.feed(fullReplies(ST))).toBe('');
    expect(out).toEqual([{ palette: expectedFullPalette(), reason: 'complete', replies: 18 }]);
    expect(probe.active).toBe(false);
  });

  test('BEL-terminated replies parse identically', () => {
    const out: PaletteProbeResolution[] = [];
    const probe = makeProbe(out);
    expect(probe.feed(fullReplies(BEL))).toBe('');
    expect(out[0]?.palette).toEqual(expectedFullPalette());
  });

  test('replies fed one byte at a time still resolve and leak nothing', () => {
    const out: PaletteProbeResolution[] = [];
    const probe = makeProbe(out);
    let leaked = '';
    for (const ch of fullReplies()) leaked += probe.feed(ch);
    expect(leaked).toBe('');
    expect(out[0]?.palette).toEqual(expectedFullPalette());
  });

  test('keystrokes interleaved between replies pass through in order', () => {
    const out: PaletteProbeResolution[] = [];
    const probe = makeProbe(out);
    let s = 'a' + osc('11', 'rgb:00/00/00') + 'b' + osc('10', 'rgb:ff/ff/ff') + '\x1b[A';
    for (let i = 0; i < 16; i++) s += ansiReply(i, slotBody(i)) + (i === 7 ? 'c' : '');
    s += 'z';
    expect(probe.feed(s)).toBe('ab\x1b[Acz');
    expect(out[0]?.reason).toBe('complete');
  });

  test('a reply split mid-introducer and mid-body across chunks', () => {
    const out: PaletteProbeResolution[] = [];
    const probe = makeProbe(out);
    let seen = '';
    seen += probe.feed('x\x1b]');
    seen += probe.feed('4;1');
    seen += probe.feed('2;rgb:ab');
    seen += probe.feed('/cd/ef\x1b');
    seen += probe.feed('\\y');
    expect(seen).toBe('xy');
    expect(out.length).toBe(0); // only one of 18 in
    expect(probe.active).toBe(true);
  });

  test('a held partial introducer that turns out to be a keystroke is released', () => {
    const out: PaletteProbeResolution[] = [];
    const probe = makeProbe(out);
    expect(probe.feed('\x1b]4;1')).toBe('');
    expect(probe.feed('x')).toBe('\x1b]4;1x');
    expect(probe.feed('\x1b')).toBe('');
    expect(probe.feed('[B')).toBe('\x1b[B');
  });

  test('unrelated OSC replies (e.g. OSC 12) are not consumed', () => {
    const out: PaletteProbeResolution[] = [];
    const probe = makeProbe(out);
    const other = `\x1b]12;rgb:ff/ff/ff${ST}`;
    expect(probe.feed(other)).toBe(other);
  });

  test('garbage bodies are consumed and leave their slot undefined', () => {
    const out: PaletteProbeResolution[] = [];
    const probe = makeProbe(out);
    let s = osc('11', 'notacolor') + osc('10', 'rgb:zz/zz/zz');
    for (let i = 0; i < 16; i++) s += ansiReply(i, i === 3 ? '?' : slotBody(i));
    expect(probe.feed(s)).toBe('');
    const res = out[0]!;
    expect(res.reason).toBe('complete');
    expect(res.replies).toBe(18);
    expect(res.palette.background).toBeUndefined();
    expect(res.palette.foreground).toBeUndefined();
    expect(res.palette.ansi[3]).toBeUndefined();
    expect(res.palette.ansi[4]).toBe(slotHex(4));
  });

  test('out-of-range OSC 4 index is consumed but not recorded', () => {
    const out: PaletteProbeResolution[] = [];
    const probe = makeProbe(out);
    expect(probe.feed(ansiReply(200, 'rgb:ff/ff/ff'))).toBe('');
    expect(probe.active).toBe(true);
  });

  test('noteBackgroundSpec counts toward completion', () => {
    const out: PaletteProbeResolution[] = [];
    const probe = makeProbe(out);
    probe.noteBackgroundSpec('rgb:ffff/ffff/ffff');
    let s = osc('10', 'rgb:00/00/00');
    for (let i = 0; i < 16; i++) s += ansiReply(i, slotBody(i));
    probe.feed(s);
    expect(out[0]?.reason).toBe('complete');
    expect(out[0]?.palette.background).toBe('#ffffff');
  });

  test('partial replies then timeout: answered slots kept, rest undefined, fragment discarded', async () => {
    const out: PaletteProbeResolution[] = [];
    const probe = makeProbe(out, 15);
    probe.startTimeout();
    const s = osc('11', 'rgb:10/20/30') + ansiReply(1, 'rgb:ff/00/00') + 'k' + '\x1b]4;2;rgb:00/ff';
    expect(probe.feed(s)).toBe('k');
    await wait(40);
    expect(out.length).toBe(1);
    const res = out[0]!;
    expect(res.reason).toBe('timeout');
    expect(res.replies).toBe(2);
    expect(res.palette.background).toBe('#102030');
    expect(res.palette.foreground).toBeUndefined();
    expect(res.palette.ansi.length).toBe(16);
    expect(res.palette.ansi[1]).toBe('#ff0000');
    expect(res.palette.ansi[2]).toBeUndefined();
    expect(probe.feed('typed')).toBe('typed');
  });

  test('no replies → timeout with an all-undefined palette', async () => {
    const out: PaletteProbeResolution[] = [];
    const probe = makeProbe(out, 10);
    probe.startTimeout();
    await wait(30);
    expect(out).toEqual([{
      palette: { ansi: new Array(16).fill(undefined) },
      reason: 'timeout',
      replies: 0,
    }]);
  });

  test('resolves once: replies after timeout pass through untouched', async () => {
    const out: PaletteProbeResolution[] = [];
    const probe = makeProbe(out, 10);
    probe.startTimeout();
    await wait(30);
    const late = fullReplies();
    expect(probe.feed(late)).toBe(late);
    expect(out.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// installBackgroundThemeProbe with probePalette: batching + store
// ---------------------------------------------------------------------------

function fakeConfig(themeMode: unknown): Pick<ConfigManager, 'get'> {
  return { get: configGetStub({ 'display.themeMode': themeMode }) };
}

describe('installBackgroundThemeProbe: palette batching', () => {
  test('auto + TTY: one write carrying OSC 11, OSC 10 and OSC 4;0..15', () => {
    const writes: string[] = [];
    installBackgroundThemeProbe({
      configManager: fakeConfig('auto'), isTTY: true, probePalette: true,
      writeQuery: (b) => writes.push(b), requestRepaint: () => {},
    });
    expect(writes).toEqual([OSC11_QUERY + PALETTE_QUERIES]);
  });

  test('tmux: the batch goes out unwrapped (tmux answers OSC 10/11/4 itself)', () => {
    const saved = process.env['TMUX'];
    process.env['TMUX'] = '/tmp/tmux-1000/default,1,0';
    try {
      const writes: string[] = [];
      installBackgroundThemeProbe({
        configManager: fakeConfig('auto'), isTTY: true,
        probePalette: true, writeQuery: (b) => writes.push(b), requestRepaint: () => {},
      });
      expect(writes).toEqual([OSC11_QUERY + PALETTE_QUERIES]);
    } finally {
      if (saved === undefined) delete process.env['TMUX'];
      else process.env['TMUX'] = saved;
    }
  });

  test('without probePalette the write is the OSC 11 query alone (unchanged)', () => {
    const writes: string[] = [];
    installBackgroundThemeProbe({
      configManager: fakeConfig('auto'), isTTY: true, 
      writeQuery: (b) => writes.push(b), requestRepaint: () => {},
    });
    expect(writes).toEqual([OSC11_QUERY]);
  });

  test('auto: background probe still flips to light; palette stored with background', () => {
    let repaints = 0;
    const paletteResults: PaletteProbeResolution[] = [];
    const notified: TerminalPalette[] = [];
    onTerminalPalette((p) => notified.push(p));
    const handle = installBackgroundThemeProbe({
      configManager: fakeConfig('auto'), isTTY: true, probePalette: true,
      timeoutMs: 1_000, paletteTimeoutMs: 1_000,
      writeQuery: () => {}, requestRepaint: () => { repaints++; },
      onPaletteResolve: (r) => paletteResults.push(r),
    });
    expect(getTerminalPalette()).toBeNull();
    let s = osc('11', 'rgb:ffff/ffff/ffff', BEL) + osc('10', 'rgb:0000/0000/0000');
    for (let i = 0; i < 16; i++) s += ansiReply(i, slotBody(i));
    expect(handle.filterInput(`q${s}w`)).toBe('qw');
    expect(activeTheme()).toBe(resolveTheme('light'));
    expect(repaints).toBe(1);
    expect(paletteResults.length).toBe(1);
    expect(paletteResults[0]?.reason).toBe('complete');
    const stored = getTerminalPalette();
    expect(stored?.background).toBe('#ffffff');
    expect(stored?.foreground).toBe('#000000');
    expect(stored?.ansi[15]).toBe(slotHex(15));
    expect(notified).toEqual([stored!]);
    expect(handle.filterInput('after')).toBe('after');
  });

  test('auto: replies split across chunks through both filters leak nothing', () => {
    const handle = installBackgroundThemeProbe({
      configManager: fakeConfig('auto'), isTTY: true, probePalette: true,
      timeoutMs: 1_000, paletteTimeoutMs: 1_000,
      writeQuery: () => {}, requestRepaint: () => {},
    });
    const all = 'k' + fullReplies() + 'm';
    let seen = '';
    for (let i = 0; i < all.length; i += 5) seen += handle.filterInput(all.slice(i, i + 5));
    expect(seen).toBe('km');
    expect(getTerminalPalette()).toEqual(expectedFullPalette());
  });

  test('auto: background times out first, late OSC 11 still consumed by the palette filter', async () => {
    const paletteResults: PaletteProbeResolution[] = [];
    const handle = installBackgroundThemeProbe({
      configManager: fakeConfig('auto'), isTTY: true, probePalette: true,
      timeoutMs: 5, paletteTimeoutMs: 1_000,
      writeQuery: () => {}, requestRepaint: () => {},
      onPaletteResolve: (r) => paletteResults.push(r),
    });
    await wait(20);
    expect(handle.filterInput(fullReplies())).toBe('');
    expect(paletteResults[0]?.reason).toBe('complete');
    expect(activeTheme()).toBe(resolveTheme('dark'));
  });

  test('forced light + TTY: palette batch still goes out and is collected', () => {
    const writes: string[] = [];
    const handle = installBackgroundThemeProbe({
      configManager: fakeConfig('light'), isTTY: true, probePalette: true,
      paletteTimeoutMs: 1_000,
      writeQuery: (b) => writes.push(b), requestRepaint: () => {},
    });
    expect(activeTheme()).toBe(resolveTheme('light'));
    expect(writes).toEqual([OSC11_QUERY + PALETTE_QUERIES]);
    expect(handle.filterInput(fullReplies())).toBe('');
    expect(getTerminalPalette()).toEqual(expectedFullPalette());
  });

  test('non-TTY: no write, no palette, filter is a passthrough', () => {
    const writes: string[] = [];
    const handle = installBackgroundThemeProbe({
      configManager: fakeConfig('auto'), isTTY: false, probePalette: true,
      writeQuery: (b) => writes.push(b), requestRepaint: () => {},
    });
    expect(writes).toEqual([]);
    expect(handle.filterInput(fullReplies())).toBe(fullReplies());
    expect(getTerminalPalette()).toBeNull();
  });

  test('no replies: palette window closes and stores an all-undefined palette', async () => {
    const paletteResults: PaletteProbeResolution[] = [];
    installBackgroundThemeProbe({
      configManager: fakeConfig('auto'), isTTY: true, probePalette: true,
      timeoutMs: 5, paletteTimeoutMs: 15,
      writeQuery: () => {}, requestRepaint: () => {},
      onPaletteResolve: (r) => paletteResults.push(r),
    });
    await wait(40);
    expect(paletteResults.map((r) => r.reason)).toEqual(['timeout']);
    expect(getTerminalPalette()).toEqual({ ansi: new Array(16).fill(undefined) });
  });
});
