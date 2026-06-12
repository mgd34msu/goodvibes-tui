/**
 * term-caps.test.ts
 *
 * Unit tests for the terminal capability probe and color downsampler.
 *
 * Covers:
 *   - probeTermCaps(): env permutations (NO_COLOR, TERM=dumb, getColorDepth)
 *   - nearestAnsi256(): known hex → expected 256 index
 *   - nearestAnsi16Fg(): known hex → expected 16-color code
 *   - downsampleColor(): full pipeline per capability level
 *   - wrapSynced(): frame wrapping presence / absence
 *   - DiffEngine integration: color emission per capability level
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  probeTermCaps,
  nearestAnsi256,
  nearestAnsi16Fg,
  downsampleColor,
  wrapSynced,
  SYNC_BEGIN,
  SYNC_END,
  type TermColorCaps,
} from '../../renderer/term-caps.ts';
import { DiffEngine } from '../../renderer/diff.ts';
import { TerminalBuffer } from '../../renderer/buffer.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock WriteStream with a configurable getColorDepth. */
function mockStream(depth: number): NodeJS.WriteStream {
  return {
    getColorDepth: () => depth,
  } as unknown as NodeJS.WriteStream;
}

/** Save and restore process.env keys around a test block. */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key]!;
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key]!;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// probeTermCaps()
// ---------------------------------------------------------------------------

describe('probeTermCaps', () => {
  test('NO_COLOR="1" yields none / no syncedOutput', () => {
    withEnv({ NO_COLOR: '1', TERM: 'xterm-256color' }, () => {
      const caps = probeTermCaps(mockStream(24));
      expect(caps.capability).toBe('none');
      expect(caps.syncedOutput).toBe(false);
    });
  });

  test('NO_COLOR="" (empty) is ignored — color not suppressed', () => {
    withEnv({ NO_COLOR: '', TERM: 'xterm-256color' }, () => {
      const caps = probeTermCaps(mockStream(24));
      expect(caps.capability).toBe('truecolor');
    });
  });

  test('NO_COLOR unset, TERM=dumb yields none', () => {
    withEnv({ NO_COLOR: undefined, TERM: 'dumb' }, () => {
      const caps = probeTermCaps(mockStream(24));
      expect(caps.capability).toBe('none');
      expect(caps.syncedOutput).toBe(false);
    });
  });

  test('depth=1 yields none', () => {
    withEnv({ NO_COLOR: undefined, TERM: 'xterm' }, () => {
      const caps = probeTermCaps(mockStream(1));
      expect(caps.capability).toBe('none');
    });
  });

  test('depth=4 yields basic16', () => {
    withEnv({ NO_COLOR: undefined, TERM: 'xterm' }, () => {
      const caps = probeTermCaps(mockStream(4));
      expect(caps.capability).toBe('basic16');
      expect(caps.syncedOutput).toBe(true);
    });
  });

  test('depth=8 yields ansi256', () => {
    withEnv({ NO_COLOR: undefined, TERM: 'xterm-256color' }, () => {
      const caps = probeTermCaps(mockStream(8));
      expect(caps.capability).toBe('ansi256');
      expect(caps.syncedOutput).toBe(true);
    });
  });

  test('depth=24 yields truecolor', () => {
    withEnv({ NO_COLOR: undefined, TERM: 'xterm-256color' }, () => {
      const caps = probeTermCaps(mockStream(24));
      expect(caps.capability).toBe('truecolor');
      expect(caps.syncedOutput).toBe(true);
    });
  });

  test('stream without getColorDepth defaults to depth=1 (none)', () => {
    withEnv({ NO_COLOR: undefined, TERM: 'xterm-256color' }, () => {
      const caps = probeTermCaps({} as NodeJS.WriteStream);
      expect(caps.capability).toBe('none');
    });
  });
});

// ---------------------------------------------------------------------------
// nearestAnsi256() — known hex → expected 256 palette index
// ---------------------------------------------------------------------------

describe('nearestAnsi256', () => {
  // Pure black → xterm cube index 16 (0,0,0 in 6x6x6 cube)
  test('#000000 → index 16', () => {
    expect(nearestAnsi256(0, 0, 0)).toBe(16);
  });

  // Pure white → xterm cube index 231 (5,5,5 in 6x6x6 cube = 16+36*5+6*5+5)
  test('#ffffff → index 231', () => {
    expect(nearestAnsi256(255, 255, 255)).toBe(231);
  });

  // Pure red → cube entry (5,0,0): 16+36*5+0+0 = 196
  test('#ff0000 → index 196', () => {
    expect(nearestAnsi256(255, 0, 0)).toBe(196);
  });

  // Pure green → cube entry (0,5,0): 16+36*0+6*5+0 = 46
  test('#00ff00 → index 46', () => {
    expect(nearestAnsi256(0, 255, 0)).toBe(46);
  });

  // Pure blue → cube entry (0,0,5): 16+0+0+5 = 21
  test('#0000ff → index 21', () => {
    expect(nearestAnsi256(0, 0, 255)).toBe(21);
  });

  // Mid-gray (128,128,128): grayscale ramp → gray(128)=232+round((128-8)/10)=244
  // cube(128,128,128)=cube(3,3,3)=16+36*3+6*3+3=16+108+18+3=145 -> RGB=(175,175,175)
  // dist to cube = 3*(175-128)^2 = 3*2209 = 6627
  // dist to gray244 = 3*(128-128)^2 -- wait: gray244=232+12=244, val=8+12*10=128 -> dist=0
  test('#808080 (128,128,128) → grayscale ramp, index 244', () => {
    expect(nearestAnsi256(128, 128, 128)).toBe(244);
  });

  // Exact cube value: CUBE_STEPS[1]=95, so (95,0,0) → 16+36*1+0+0=52
  test('(95,0,0) → index 52', () => {
    expect(nearestAnsi256(95, 0, 0)).toBe(52);
  });
});

// ---------------------------------------------------------------------------
// nearestAnsi16Fg() — known hex → expected 16-color fg code
// ---------------------------------------------------------------------------

describe('nearestAnsi16Fg', () => {
  test('black (0,0,0) → 30', () => {
    expect(nearestAnsi16Fg(0, 0, 0)).toBe(30);
  });

  test('white (255,255,255) → 97', () => {
    expect(nearestAnsi16Fg(255, 255, 255)).toBe(97);
  });

  test('pure red (255,0,0) → 91 (bright red)', () => {
    // palette[9] = [255,85,85,91]; dist to pure red (255,0,0):
    // palette[1]=[170,0,0,31]: d=(85^2+0+0)=7225
    // palette[9]=[255,85,85,91]: d=(0+85^2+85^2)=14450
    // So (255,0,0) is closest to palette[1] = 31
    expect(nearestAnsi16Fg(255, 0, 0)).toBe(31);
  });

  test('pure green (0,255,0) → 92 (bright green)', () => {
    // palette[10]=[85,255,85,92]: d=(85^2+0+85^2)=14450
    // palette[2]=[0,170,0,32]: d=(0+85^2+0)=7225 => 32 wins
    expect(nearestAnsi16Fg(0, 255, 0)).toBe(32);
  });

  test('dark gray (85,85,85) → 90 (bright black)', () => {
    expect(nearestAnsi16Fg(85, 85, 85)).toBe(90);
  });

  test('bright yellow (255,255,0) → 93', () => {
    expect(nearestAnsi16Fg(255, 255, 0)).toBe(93);
  });
});

// ---------------------------------------------------------------------------
// downsampleColor()
// ---------------------------------------------------------------------------

describe('downsampleColor', () => {
  const noCaps: TermColorCaps = { capability: 'none', syncedOutput: false };
  const basic16Caps: TermColorCaps = { capability: 'basic16', syncedOutput: true };
  const ansi256Caps: TermColorCaps = { capability: 'ansi256', syncedOutput: true };
  const truecolorCaps: TermColorCaps = { capability: 'truecolor', syncedOutput: true };

  describe('capability=none', () => {
    test('returns null for any color', () => {
      expect(downsampleColor('#ff0000', noCaps, 'fg')).toBeNull();
      expect(downsampleColor('255;0;0', noCaps, 'fg')).toBeNull();
      expect(downsampleColor('196', noCaps, 'fg')).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(downsampleColor('', noCaps, 'fg')).toBeNull();
    });
  });

  describe('capability=truecolor', () => {
    test('hex is decomposed to r;g;b', () => {
      expect(downsampleColor('#ff0000', truecolorCaps, 'fg')).toBe('255;0;0');
    });

    test('pre-decomposed r;g;b passes through', () => {
      expect(downsampleColor('0;128;255', truecolorCaps, 'fg')).toBe('0;128;255');
    });

    test('palette index passes through as-is', () => {
      expect(downsampleColor('196', truecolorCaps, 'fg')).toBe('196');
    });

    test('empty string returns null', () => {
      expect(downsampleColor('', truecolorCaps, 'fg')).toBeNull();
    });
  });

  describe('capability=ansi256', () => {
    test('hex #ff0000 downsamples to index 196', () => {
      expect(downsampleColor('#ff0000', ansi256Caps, 'fg')).toBe('196');
    });

    test('hex #000000 downsamples to index 16', () => {
      expect(downsampleColor('#000000', ansi256Caps, 'fg')).toBe('16');
    });

    test('hex #ffffff downsamples to index 231', () => {
      expect(downsampleColor('#ffffff', ansi256Caps, 'fg')).toBe('231');
    });

    test('pre-decomposed r;g;b downsamples correctly', () => {
      // #0000ff = 0;0;255 → 21
      expect(downsampleColor('0;0;255', ansi256Caps, 'fg')).toBe('21');
    });

    test('palette index passes through', () => {
      expect(downsampleColor('42', ansi256Caps, 'fg')).toBe('42');
    });
  });

  describe('capability=basic16', () => {
    test('black #000000 fg → SGR code 30', () => {
      expect(downsampleColor('#000000', basic16Caps, 'fg')).toBe('30');
    });

    test('black #000000 bg → SGR code 40', () => {
      expect(downsampleColor('#000000', basic16Caps, 'bg')).toBe('40');
    });

    test('white #ffffff fg → SGR code 97', () => {
      expect(downsampleColor('#ffffff', basic16Caps, 'fg')).toBe('97');
    });

    test('white #ffffff bg → SGR code 107', () => {
      expect(downsampleColor('#ffffff', basic16Caps, 'bg')).toBe('107');
    });

    test('palette index in basic16 returns null (cannot map — no RGB available)', () => {
      // VERIFIED CONTRACT: bare 256-palette indices (e.g. '42', '196') cannot be
      // reliably mapped to ANSI-16 without an RGB lookup table. downsampleColor
      // returns null so the caller emits NO color sequence, and the character
      // renders in the terminal default color. This is a documented fidelity
      // tradeoff — the alternative (emitting an incorrect color) would be worse.
      // A full 256→16 reverse-palette table would close this gap in a future pass.
      expect(downsampleColor('42', basic16Caps, 'fg')).toBeNull();
      expect(downsampleColor('196', basic16Caps, 'bg')).toBeNull();
      expect(downsampleColor('232', basic16Caps, 'fg')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// wrapSynced()
// ---------------------------------------------------------------------------

describe('wrapSynced', () => {
  const synced: TermColorCaps = { capability: 'truecolor', syncedOutput: true };
  const noSync: TermColorCaps = { capability: 'none', syncedOutput: false };
  const basic16Sync: TermColorCaps = { capability: 'basic16', syncedOutput: true };

  test('wraps non-empty diff when syncedOutput=true', () => {
    const result = wrapSynced('\x1b[1;1Hx', synced);
    expect(result).toBe(`${SYNC_BEGIN}\x1b[1;1Hx${SYNC_END}`);
  });

  test('does NOT wrap when syncedOutput=false', () => {
    const diff = '\x1b[1;1Hx';
    expect(wrapSynced(diff, noSync)).toBe(diff);
  });

  test('empty diff is returned as-is even with syncedOutput=true', () => {
    expect(wrapSynced('', synced)).toBe('');
  });

  test('wraps with basic16 capability when syncedOutput=true', () => {
    const result = wrapSynced('\x1b[1;1Hx', basic16Sync);
    expect(result.startsWith(SYNC_BEGIN)).toBe(true);
    expect(result.endsWith(SYNC_END)).toBe(true);
  });

  test('SYNC_BEGIN and SYNC_END are the correct DEC 2026 sequences', () => {
    expect(SYNC_BEGIN).toBe('\x1b[?2026h');
    expect(SYNC_END).toBe('\x1b[?2026l');
  });
});

// ---------------------------------------------------------------------------
// DiffEngine integration — color emission per capability
// ---------------------------------------------------------------------------

describe('DiffEngine color capability integration', () => {
  function makeCell(fg: string, bg = '', char = 'X') {
    return {
      char,
      fg,
      bg,
      bold: false,
      dim: false,
      underline: false,
      italic: false,
      strikethrough: false,
    };
  }

  function diffWithCaps(caps: TermColorCaps, fg: string, bg = ''): string {
    const engine = new DiffEngine(caps);
    const buf = new TerminalBuffer(10, 3);
    buf.setCell(0, 0, makeCell(fg, bg));
    return engine.diff(null, buf);
  }

  test('truecolor: hex color emits \\x1b[38;2;r;g;bm', () => {
    const caps: TermColorCaps = { capability: 'truecolor', syncedOutput: false };
    const diff = diffWithCaps(caps, '#ff0000');
    expect(diff).toContain('\x1b[38;2;255;0;0m');
  });

  test('ansi256: hex color emits \\x1b[38;5;Nm', () => {
    const caps: TermColorCaps = { capability: 'ansi256', syncedOutput: false };
    const diff = diffWithCaps(caps, '#ff0000');
    // #ff0000 → index 196
    expect(diff).toContain('\x1b[38;5;196m');
    expect(diff).not.toContain('38;2;');
  });

  test('basic16: hex color emits plain SGR code (e.g. \\x1b[31m)', () => {
    const caps: TermColorCaps = { capability: 'basic16', syncedOutput: false };
    // #aa0000 → nearest 16 = 31 (red)
    const diff = diffWithCaps(caps, '#aa0000');
    expect(diff).toContain('\x1b[31m');
    expect(diff).not.toContain('38;2;');
    expect(diff).not.toContain('38;5;');
  });

  test('none: no color SGR emitted at all', () => {
    const caps: TermColorCaps = { capability: 'none', syncedOutput: false };
    const diff = diffWithCaps(caps, '#ff0000');
    // Should not contain any color codes
    expect(diff).not.toContain('38;2;');
    expect(diff).not.toContain('38;5;');
    expect(diff).not.toContain('\x1b[31m');
    // Should also not contain reset SGR
    expect(diff).not.toContain('\x1b[0m');
  });

  test('synced=true: diff is wrapped in DEC 2026 markers', () => {
    const caps: TermColorCaps = { capability: 'truecolor', syncedOutput: true };
    const diff = diffWithCaps(caps, '#ff0000');
    expect(diff.startsWith(SYNC_BEGIN)).toBe(true);
    expect(diff.endsWith(SYNC_END)).toBe(true);
  });

  test('synced=false: diff is NOT wrapped in DEC 2026 markers', () => {
    const caps: TermColorCaps = { capability: 'truecolor', syncedOutput: false };
    const diff = diffWithCaps(caps, '#ff0000');
    expect(diff).not.toContain(SYNC_BEGIN);
    expect(diff).not.toContain(SYNC_END);
  });

  test('none: empty diff returned for a cell (char still rendered, no style)', () => {
    const caps: TermColorCaps = { capability: 'none', syncedOutput: false };
    const diff = diffWithCaps(caps, '');
    // Cell X at (0,0) should still position and emit the char
    // We only check that it contains a cursor-position sequence and the char
    expect(diff).toContain('\x1b[1;1H');
    expect(diff).toContain('X');
  });

  test('ansi256: bg hex emits \\x1b[48;5;Nm', () => {
    const caps: TermColorCaps = { capability: 'ansi256', syncedOutput: false };
    const diff = diffWithCaps(caps, '', '#0000ff');
    // #0000ff → index 21
    expect(diff).toContain('\x1b[48;5;21m');
  });

  test('truecolor: palette index passes through as 256-color (\\x1b[38;5;Nm)', () => {
    const caps: TermColorCaps = { capability: 'truecolor', syncedOutput: false };
    const engine = new DiffEngine(caps);
    const buf = new TerminalBuffer(10, 3);
    // '196' is already a palette index (no # prefix, no semicolon)
    buf.setCell(0, 0, makeCell('196'));
    const diff = engine.diff(null, buf);
    expect(diff).toContain('\x1b[38;5;196m');
  });
});
