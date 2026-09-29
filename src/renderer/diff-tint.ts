/**
 * diff-tint.ts, row tints for a diff that stay visible on the fill they sit on.
 *
 * The theme's diff tokens (diffAddedBg, diffRemovedBg and their line-number
 * variants) are tuned against the terminal background. A diff drawn inside a
 * lighter element panel can land within a few color units of them: gruvbox
 * light's added row is 7 units from its element fill, rosepine light's removed
 * line-number tint 5. Those rows read as untinted.
 *
 * visibleTint keeps the theme's token whenever it is far enough from the fill.
 * When it is not, it pushes the token further from the fill along the same
 * direction (the same hue shift, just stronger), and when the token carries
 * no usable direction it mixes the fill toward the diff's sign color instead.
 */

import { mixHex } from '@pellux/goodvibes-sdk/platform/presentation';
import { activeDiffTones, activeTokens } from './theme.ts';

/**
 * Smallest Euclidean sRGB distance (0..441) between a diff row's tint and the
 * fill under it. A flat fill change becomes noticeable side by side at about 8
 * units; a full-width row has to read as tinted at a glance, from across the
 * modal, so the floor is three times that. For reference, GitHub dark's own
 * added-row tint sits about 20 units from its canvas and reads as faint.
 */
const MIN_DIFF_TINT_DISTANCE = 24;

type Rgb = readonly [number, number, number];

function parse(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(c: Rgb): string {
  return `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

/** Euclidean distance between two #rrggbb colors (0 when either does not parse). */
function colorDistance(a: string, b: string): number {
  const ca = parse(a);
  const cb = parse(b);
  if (!ca || !cb) return 0;
  return Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]);
}

/**
 * `token` when it is at least `floor` from `fill`; otherwise the closest color
 * that is, found first along the token's own direction from the fill, then by
 * mixing the fill toward `tone` (the diff sign color). Colors that do not parse
 * come back unchanged.
 */
function visibleTint(token: string, fill: string, tone: string, floor = MIN_DIFF_TINT_DISTANCE): string {
  const t = parse(token);
  const f = parse(fill);
  if (!t || !f) return token;
  const len = Math.hypot(t[0] - f[0], t[1] - f[1], t[2] - f[2]);
  if (len >= floor) return token;
  // Aim one unit past the floor so rounding to whole channels never lands short.
  const target = floor + 1;
  if (len >= 4) {
    const k = target / len;
    const pushed = toHex([f[0] + (t[0] - f[0]) * k, f[1] + (t[1] - f[1]) * k, f[2] + (t[2] - f[2]) * k]);
    if (colorDistance(pushed, fill) >= floor) return pushed;
  }
  const full = colorDistance(tone, fill);
  if (full <= 0) return token;
  return mixHex(fill, tone, Math.min(1, target / full));
}

export interface DiffRowTints {
  readonly addedRow: string;
  readonly removedRow: string;
  readonly addedGutter: string;
  readonly removedGutter: string;
}

const tintCache = new Map<string, DiffRowTints>();

/** The active theme's diff tints, each kept visible on `fill` (the panel the diff sits on). */
export function diffRowTints(fill: string): DiffRowTints {
  const t = activeTokens();
  const tones = activeDiffTones();
  const key = [fill, t.diffAddedBg, t.diffRemovedBg, t.diffAddedLineNumberBg, t.diffRemovedLineNumberBg, tones.add, tones.del].join('|');
  const cached = tintCache.get(key);
  if (cached) return cached;
  const tints: DiffRowTints = {
    addedRow: visibleTint(t.diffAddedBg, fill, tones.add),
    removedRow: visibleTint(t.diffRemovedBg, fill, tones.del),
    addedGutter: visibleTint(t.diffAddedLineNumberBg, fill, tones.add),
    removedGutter: visibleTint(t.diffRemovedLineNumberBg, fill, tones.del),
  };
  if (tintCache.size > 64) tintCache.clear();
  tintCache.set(key, tints);
  return tints;
}
