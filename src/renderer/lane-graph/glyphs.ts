/**
 * lane-graph/glyphs.ts, the characters the conversation work tree draws with.
 *
 * The layout (layout.ts) speaks in ROLES ("a vertical lane line", "the corner
 * where a lane merges back"); this module turns a role into a character for
 * the chosen set, so the same layout draws rounded, square or ascii without a
 * second code path.
 *
 * `display.treeGlyphs` picks the set. A terminal the capability probe reports
 * as limited (TERM=dumb, NO_COLOR, or a locale without UTF-8) draws ascii no
 * matter what the setting says, because box drawing on such a terminal prints
 * as garbage.
 */

export type TreeGlyphSetName = 'rounded' | 'square' | 'ascii';

const TREE_GLYPH_SET_NAMES: readonly TreeGlyphSetName[] = ['rounded', 'square', 'ascii'];

/** Every drawing role the lane layout emits. */
export type LaneGlyphRole =
  | 'vert' // │ a lane running down
  | 'horiz' // ─ a horizontal run between lanes
  | 'branch' // ├ where a lane leaves its parent, or merges back into it
  | 'cross' // ┼ a horizontal run crossing a live lane
  | 'open' // ╮ where a new lane starts
  | 'merge' // ╯ where a lane ends into its parent
  | 'head' // ╭ the top of a turn's spine
  | 'close' // ╰ the end of a turn's spine (the answer row)
  | 'folded' // ◉ a finished lane folded to one bead
  | 'turn'; // ◆ a folded turn's header

export interface LaneGlyphs {
  readonly name: TreeGlyphSetName;
  readonly role: Readonly<Record<LaneGlyphRole, string>>;
  /** Bead marks, one per status. `run` is the spinner's frames. */
  readonly ok: string;
  readonly warn: string;
  readonly err: string;
  readonly run: readonly string[];
  readonly wait: string;
  readonly cancel: string;
  readonly background: string;
  /** Body triangles: closed (has a body) and open. */
  readonly closed: string;
  readonly opened: string;
  /** The focused row's edge mark. */
  readonly focus: string;
  /** "↳" linking a WRFC fix to its finding. */
  readonly answers: string;
  /** "…" in "… N more". */
  readonly ellipsis: string;
  /** "·" between summary pieces. */
  readonly dot: string;
}

const ROUNDED: LaneGlyphs = {
  name: 'rounded',
  role: { vert: '│', horiz: '─', branch: '├', cross: '┼', open: '╮', merge: '╯', head: '╭', close: '╰', folded: '◉', turn: '◆' },
  ok: '✓',
  warn: '!',
  err: '✕',
  run: ['◐', '◓', '◑', '◒'],
  wait: '●',
  cancel: '○',
  background: '▶',
  closed: '▸',
  opened: '▾',
  focus: '┃',
  answers: '↳',
  ellipsis: '…',
  dot: '·',
};

const SQUARE: LaneGlyphs = {
  ...ROUNDED,
  name: 'square',
  role: { ...ROUNDED.role, open: '┐', merge: '┘', head: '┌', close: '└', folded: '●' },
};

/**
 * Plain ASCII: | for lanes, + for every junction and corner except the
 * spine's end (`), - for horizontal runs. Beads: * done, ! look at this,
 * x failed, o running, ? waiting on you, . cancelled, > background,
 * @ a folded lane, # a folded turn.
 */
const ASCII: LaneGlyphs = {
  name: 'ascii',
  role: { vert: '|', horiz: '-', branch: '+', cross: '+', open: '+', merge: '+', head: '+', close: '`', folded: '@', turn: '#' },
  ok: '*',
  warn: '!',
  err: 'x',
  run: ['o', 'O'],
  wait: '?',
  cancel: '.',
  background: '>',
  closed: '>',
  opened: 'v',
  focus: '|',
  answers: '->',
  ellipsis: '...',
  dot: '-',
};

const SETS: Readonly<Record<TreeGlyphSetName, LaneGlyphs>> = { rounded: ROUNDED, square: SQUARE, ascii: ASCII };

function isTreeGlyphSetName(value: unknown): value is TreeGlyphSetName {
  return typeof value === 'string' && (TREE_GLYPH_SET_NAMES as readonly string[]).includes(value);
}

/** The glyph set for a name; anything unrecognised draws rounded. */
export function laneGlyphs(name: TreeGlyphSetName): LaneGlyphs {
  return SETS[name];
}

/**
 * The set to draw with: the configured name, unless the terminal cannot draw
 * unicode, in which case ascii.
 */
export function resolveTreeGlyphSet(configured: unknown, unicodeCapable: boolean): TreeGlyphSetName {
  if (!unicodeCapable) return 'ascii';
  return isTreeGlyphSetName(configured) ? configured : 'rounded';
}

const ASCII_TEXT: ReadonlyArray<readonly [RegExp, string]> = [
  [/·/g, '-'], [/[−–—]/g, '-'], [/…/g, '...'], [/↳/g, '->'], [/[✓✔]/g, '*'], [/[✕✗]/g, 'x'], [/◈/g, '*'], [/[▸▶]/g, '>'], [/▾/g, 'v'], [/⋯/g, '...'],
];

/** Row text as the glyph set draws it: plain ASCII for the ascii set, unchanged otherwise. */
export function glyphText(text: string, glyphs: Pick<LaneGlyphs, 'name'>): string {
  if (glyphs.name !== 'ascii') return text;
  let out = text;
  for (const [pattern, replacement] of ASCII_TEXT) out = out.replace(pattern, replacement);
  return out;
}
