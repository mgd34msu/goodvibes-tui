/**
 * term-caps.ts, Terminal capability detection and color downsampling.
 *
 * Probes the terminal's color support level once at renderer init and exposes
 * a `downsampleColor` function that maps hex/RGB color strings to the
 * appropriate SGR parameter string for the detected capability level.
 *
 * Capability levels (in ascending order):
 *   none     , NO_COLOR set or TERM=dumb; emit no SGR color sequences.
 *   basic16  , 16 ANSI colors (\x1b[30-37m / \x1b[90-97m / \x1b[40-47m).
 *   ansi256  , 256-color palette (\x1b[38;5;Nm).
 *   truecolor, 24-bit RGB (\x1b[38;2;R;G;Bm).
 *
 * References:
 *   - NO_COLOR spec: https://no-color.org/ (any non-empty value disables color)
 *   - TERM=dumb: conventional dumb-terminal indicator
 *   - getColorDepth(): Node.js WriteStream API returns 1/4/8/24
 */

export type ColorCapability = 'none' | 'basic16' | 'ansi256' | 'truecolor';

export interface TermColorCaps {
  capability: ColorCapability;
  /**
   * Whether to emit DEC Synchronized Output (mode 2026) markers.
   * True when capability != 'none' and TERM != 'dumb'.
   */
  syncedOutput: boolean;
}

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

/**
 * Probe terminal color capabilities from environment and the write stream.
 * Call once at compositor/renderer construction time.
 *
 * @param stdout - The writable stream for terminal output (process.stdout or mock).
 */
export function probeTermCaps(stdout: NodeJS.WriteStream): TermColorCaps {
  // NO_COLOR: any non-empty value disables color, per https://no-color.org/
  const noColor = process.env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') {
    return { capability: 'none', syncedOutput: false };
  }

  const term = process.env['TERM'] ?? '';
  if (term === 'dumb') {
    return { capability: 'none', syncedOutput: false };
  }

  // getColorDepth() returns bit depth: 1=none, 4=basic16, 8=ansi256, 24=truecolor
  const depth: number = typeof stdout.getColorDepth === 'function'
    ? stdout.getColorDepth()
    : 1;

  let capability: ColorCapability;
  if (depth >= 24) {
    capability = 'truecolor';
  } else if (depth >= 8) {
    capability = 'ansi256';
  } else if (depth >= 4) {
    capability = 'basic16';
  } else {
    capability = 'none';
  }

  const syncedOutput = capability !== 'none';
  return { capability, syncedOutput };
}

// ---------------------------------------------------------------------------
// Color parsing helpers
// ---------------------------------------------------------------------------

/** Parse "#rrggbb" → [r, g, b]. Returns null for invalid input. */
function parseHex(hex: string): [number, number, number] | null {
  if (hex.length === 7 && hex[0] === '#') {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return [r, g, b];
  }
  return null;
}

/**
 * Parse a sanitized color string in one of two forms:
 *   - "#rrggbb"  → RGB tuple
 *   - "r;g;b"    → RGB tuple (already decomposed by sanitizeColor)
 *   - "N"        → null (already a palette index, pass through)
 * Returns [r, g, b] or null (non-RGB / palette index).
 */
function parseRgbString(color: string): [number, number, number] | null {
  if (color.startsWith('#')) return parseHex(color);
  if (color.includes(';')) {
    const parts = color.split(';');
    if (parts.length === 3) {
      const r = parseInt(parts[0]!, 10);
      const g = parseInt(parts[1]!, 10);
      const b = parseInt(parts[2]!, 10);
      if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return [r, g, b];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 256-color cube math
// ---------------------------------------------------------------------------

/**
 * Map [r, g, b] (0-255 each) to the nearest xterm-256 palette index.
 *
 * The 256-color palette is structured as:
 *   0-15:   System colors (16 named colors), we avoid these for predictability
 *           and instead target the 6×6×6 cube + grayscale ramp.
 *   16-231: 6×6×6 color cube, index = 16 + 36*r6 + 6*g6 + b6
 *           where r6/g6/b6 ∈ 0-5 map via [0,95,135,175,215,255]
 *   232-255: Grayscale ramp, index = 232 + round((v - 8) / 10)
 *            values: 8, 18, 28, ..., 238 (24 steps, step=10)
 */
const CUBE_STEPS = [0, 95, 135, 175, 215, 255] as const;

function nearestCubeStep(v: number): number {
  let best = 0;
  let bestDist = Math.abs(v - CUBE_STEPS[0]!);
  for (let i = 1; i < CUBE_STEPS.length; i++) {
    const dist = Math.abs(v - CUBE_STEPS[i]!);
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  return best;
}

function cubeIndex(r: number, g: number, b: number): number {
  const r6 = nearestCubeStep(r);
  const g6 = nearestCubeStep(g);
  const b6 = nearestCubeStep(b);
  return 16 + 36 * r6 + 6 * g6 + b6;
}

function grayscaleIndex(v: number): number {
  // Grayscale ramp: 232..255, values 8,18,28,...,238
  // index 232 = value 8, index 255 = value 238, step 10
  const clamped = Math.max(8, Math.min(238, v));
  return 232 + Math.round((clamped - 8) / 10);
}

function sqDist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
}

/**
 * Find the nearest xterm-256 index for [r, g, b].
 * Compares the nearest cube color vs the nearest grayscale color and picks best.
 */
export function nearestAnsi256(r: number, g: number, b: number): number {
  const ci = cubeIndex(r, g, b);
  const r6 = nearestCubeStep(r);
  const g6 = nearestCubeStep(g);
  const b6 = nearestCubeStep(b);
  const cubeR = CUBE_STEPS[r6]!;
  const cubeG = CUBE_STEPS[g6]!;
  const cubeB = CUBE_STEPS[b6]!;
  const cubeDist = sqDist(r, g, b, cubeR, cubeG, cubeB);

  // Nearest grayscale step
  const gray = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const gi = grayscaleIndex(gray);
  const grayVal = 8 + (gi - 232) * 10;
  const grayDist = sqDist(r, g, b, grayVal, grayVal, grayVal);

  return grayDist < cubeDist ? gi : ci;
}

// ---------------------------------------------------------------------------
// 16-color nearest-color table
// ---------------------------------------------------------------------------

/**
 * Standard 16 ANSI colors. Each entry is [r, g, b, fgCode, bgCode].
 * The fg code is the SGR parameter for foreground (30-37, 90-97);
 * the bg code is 40 higher.
 *
 * These values approximate the most common terminal palettes (xterm defaults).
 */
const ANSI16_PALETTE: ReadonlyArray<readonly [number, number, number, number]> = [
  // [r, g, b, SGR-fg-code]
  [0,   0,   0,   30],  // 0: black
  [170, 0,   0,   31],  // 1: red
  [0,   170, 0,   32],  // 2: green
  [170, 85,  0,   33],  // 3: yellow/brown
  [0,   0,   170, 34],  // 4: blue
  [170, 0,   170, 35],  // 5: magenta
  [0,   170, 170, 36],  // 6: cyan
  [170, 170, 170, 37],  // 7: light gray
  [85,  85,  85,  90],  // 8: dark gray (bright black)
  [255, 85,  85,  91],  // 9: bright red
  [85,  255, 85,  92],  // 10: bright green
  [255, 255, 85,  93],  // 11: bright yellow
  [85,  85,  255, 94],  // 12: bright blue
  [255, 85,  255, 95],  // 13: bright magenta
  [85,  255, 255, 96],  // 14: bright cyan
  [255, 255, 255, 97],  // 15: white
];

/**
 * Find the nearest ANSI 16-color SGR foreground code for [r, g, b].
 * Returns a number like 31 (red fg), 92 (bright green fg), etc.
 */
export function nearestAnsi16Fg(r: number, g: number, b: number): number {
  let bestCode = 37;
  let bestDist = Infinity;
  for (const [pr, pg, pb, code] of ANSI16_PALETTE) {
    const d = sqDist(r, g, b, pr!, pg!, pb!);
    if (d < bestDist) { bestDist = d; bestCode = code!; }
  }
  return bestCode;
}

/**
 * Convert an ANSI16 fg code to the corresponding bg code.
 * fg 30-37 → bg 40-47; fg 90-97 → bg 100-107.
 */
function ansi16FgToBg(fgCode: number): number {
  // Both ranges (30-37 and 90-97) shift by +10 to reach their bg equivalents
  // (30-37 → 40-47, 90-97 → 100-107).
  return fgCode + 10;
}

// ---------------------------------------------------------------------------
// Public downsampler
// ---------------------------------------------------------------------------

/**
 * Downsample a color for the given capability.
 *
 * @param rawColor - A color string as seen in Cell.fg / Cell.bg, before
 *   sanitizeColor() decomposition. Supported forms:
 *   - "#rrggbb"  hex
 *   - "r;g;b"    pre-decomposed RGB (from sanitizeColor)
 *   - "N"        already a palette index, returned as-is for ansi256/truecolor,
 *                or omitted for none
 *
 * @param caps - The probed terminal capabilities.
 * @param role - 'fg' or 'bg', determines which SGR range to use for basic16.
 *
 * @returns The SGR parameter string suitable for embedding in \x1b[38;2;...m
 *   (truecolor), \x1b[38;5;Nm (ansi256), \x1b[Nm (basic16 fg), etc.
 *   Returns null when capability is 'none' (caller should skip the sequence).
 *
 * Caller usage:
 *   const fg = downsampleColor(cell.fg, caps, 'fg');
 *   if (fg !== null) {
 *     const isRgb = fg.includes(';');  // truecolor path
 *     style += isRgb ? `\x1b[38;2;${fg}m` : `\x1b[38;5;${fg}m`;
 *   }
 *
 * For basic16 the caller must use a different SGR prefix, see applyStyles.
 */
export function downsampleColor(
  rawColor: string,
  caps: TermColorCaps,
  role: 'fg' | 'bg',
): string | null {
  if (!rawColor) return null;
  if (caps.capability === 'none') return null;

  const rgb = parseRgbString(rawColor);

  if (caps.capability === 'truecolor') {
    // Pass hex through as r;g;b decomposed, pass r;g;b through as-is
    if (rgb) return `${rgb[0]};${rgb[1]};${rgb[2]}`;
    // Already a palette index, emit as 256-color
    return rawColor; // caller will use 38;5;N or 48;5;N
  }

  if (caps.capability === 'ansi256') {
    if (rgb) return String(nearestAnsi256(rgb[0], rgb[1], rgb[2]));
    // Already a palette index, pass through
    return rawColor;
  }

  // basic16
  if (rgb) {
    const fgCode = nearestAnsi16Fg(rgb[0], rgb[1], rgb[2]);
    if (role === 'fg') return String(fgCode);
    // bg: shift by 10 (30→40, 90→100)
    return String(ansi16FgToBg(fgCode));
  }
  // Palette index in basic16 mode: map 256-color index to the nearest 16-color.
  // We don't have the RGB for arbitrary palette indices here; treat as empty
  // (the caller will skip the sequence rather than emit garbage).
  return null;
}

// ---------------------------------------------------------------------------
// DEC 2026 Synchronized Output helpers
// ---------------------------------------------------------------------------

/** DEC private mode 2026: begin synchronized update (suppress screen updates). */
export const SYNC_BEGIN = '\x1b[?2026h';
/** DEC private mode 2026: end synchronized update (flush to screen). */
export const SYNC_END = '\x1b[?2026l';

/**
 * Wrap a diff string in DEC 2026 synchronized-update markers if the
 * terminal supports it.
 *
 * @param diff - The raw ANSI diff string.
 * @param caps - The probed terminal capabilities.
 * @returns The diff string, optionally wrapped.
 */
export function wrapSynced(diff: string, caps: TermColorCaps): string {
  if (!diff || !caps.syncedOutput) return diff;
  return `${SYNC_BEGIN}${diff}${SYNC_END}`;
}
