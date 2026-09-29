import { describe, expect, test } from 'bun:test';
import { layoutLaneGraph, SPINE, type GutterCell, type GutterRow, type LaneEvent } from '../../renderer/lane-graph/layout.ts';
import { laneGlyphs, resolveTreeGlyphSet, type TreeGlyphSetName } from '../../renderer/lane-graph/glyphs.ts';

const TREE_GLYPH_SET_NAMES: readonly TreeGlyphSetName[] = ['rounded', 'square', 'ascii'];

/** A gutter row as text, trailing blanks trimmed. */
function gutterText(row: GutterRow, glyph: (role: GutterCell['role']) => string): string {
  let out = '';
  for (let col = 0; col < row.length; col++) out += row[col] ? glyph(row[col]!.role) : ' ';
  return out.replace(/\s+$/, '');
}

const widthFor = (lanes: number): number => {
  const events: LaneEvent[] = [{ kind: 'head' }];
  for (let i = 1; i < lanes; i++) events.push(spawn(SPINE, `l${i}`));
  return layoutLaneGraph(events).gutterWidth;
};
import { probeUnicodeSupport } from '../../renderer/term-caps.ts';

function draw(events: readonly LaneEvent[], set: TreeGlyphSetName = 'rounded', bead = '●'): string[] {
  const glyphs = laneGlyphs(set);
  const layout = layoutLaneGraph(events);
  return layout.rows.map((row) => gutterText(row, (role) => (role === 'bead' ? bead : glyphs.role[role])));
}

const bead = (lane: string): LaneEvent => ({ kind: 'bead', lane });
const spawn = (parent: string, lane: string): LaneEvent => ({ kind: 'spawn', parent, lane });
const merge = (lane: string): LaneEvent => ({ kind: 'merge', lane });

describe('lane layout: a single lane', () => {
  test('the spine opens on the header and closes on the answer', () => {
    expect(draw([{ kind: 'head' }, { kind: 'row' }, bead(SPINE), bead(SPINE), { kind: 'answer' }])).toEqual(['╭─', '│', '●', '●', '╰─']);
  });

  test('one live lane keeps text 6 columns in', () => {
    expect(layoutLaneGraph([{ kind: 'head' }, bead(SPINE), { kind: 'answer' }]).gutterWidth).toBe(6);
  });
});

describe('lane layout: branch and merge', () => {
  test('a lane branches off its parent with ├─╮ and merges back with ├─╯', () => {
    expect(draw([{ kind: 'head' }, spawn(SPINE, 'a'), bead('a'), bead('a'), merge('a'), bead(SPINE), { kind: 'answer' }]))
      .toEqual(['╭─', '├─╮', '│ ●', '│ ●', '├─╯', '●', '╰─']);
  });

  test('a new lane crossing a live lane draws ┼ on it', () => {
    const rows = draw([{ kind: 'head' }, spawn(SPINE, 'a'), spawn(SPINE, 'b'), bead('a'), bead('b'), merge('b'), merge('a'), { kind: 'answer' }]);
    expect(rows).toEqual(['╭─', '├─╮', '├─┼─╮', '│ ● │', '│ │ ●', '├─┼─╯', '├─╯', '╰─']);
  });

  test('concurrent lanes run side by side and a finished lane frees its slot without moving the others', () => {
    const rows = draw([
      { kind: 'head' }, spawn(SPINE, 'a'), spawn(SPINE, 'b'), spawn(SPINE, 'c'),
      bead('a'), bead('b'), merge('b'), bead('c'), merge('a'), bead('c'), { kind: 'answer' }, bead('c'),
    ]);
    expect(rows).toEqual(['╭─', '├─╮', '├─┼─╮', '├─┼─┼─╮', '│ ● │ │', '│ │ ● │', '├─┼─╯ │', '│ │   ●', '├─╯   │', '│     ●', '╰─    │', '      ●']);
  });

  test('up to four live lanes put the text 10 columns in, more lanes widen it', () => {
    expect(widthFor(1)).toBe(6);
    expect(widthFor(2)).toBe(10);
    expect(widthFor(4)).toBe(10);
    expect(widthFor(5)).toBe(12);
    const four = layoutLaneGraph([{ kind: 'head' }, spawn(SPINE, 'a'), spawn(SPINE, 'b'), spawn(SPINE, 'c'), merge('c'), merge('b'), merge('a'), { kind: 'answer' }]);
    expect(four.maxLive).toBe(4);
    expect(four.gutterWidth).toBe(10);
  });

  test('lane colors follow creation order, the spine first', () => {
    const layout = layoutLaneGraph([{ kind: 'head' }, spawn(SPINE, 'a'), spawn('a', 'b'), merge('b'), merge('a'), { kind: 'answer' }]);
    expect([layout.laneColor.get(SPINE), layout.laneColor.get('a'), layout.laneColor.get('b')]).toEqual([0, 1, 2]);
    // The branch point is drawn in the parent's color, the horizontal run and ╮ in the child's.
    const spawnRow = layout.rows[2]!;
    expect(spawnRow[2]).toEqual({ role: 'branch', color: 1 });
    expect(spawnRow[3]).toEqual({ role: 'horiz', color: 2 });
    expect(spawnRow[4]).toEqual({ role: 'open', color: 2 });
  });
});

describe('lane layout: nesting', () => {
  test('three levels deep: each child branches from its parent and merges back into it', () => {
    const rows = draw([
      { kind: 'head' }, bead(SPINE), spawn(SPINE, 'eng'), bead('eng'), spawn('eng', 'tester'), bead('tester'),
      spawn('tester', 'res'), bead('res'), merge('res'), bead('tester'), merge('tester'), bead('eng'), merge('eng'), { kind: 'answer' },
    ]);
    expect(rows).toEqual([
      '╭─', '●', '├─╮', '│ ●', '│ ├─╮', '│ │ ●', '│ │ ├─╮', '│ │ │ ●', '│ │ ├─╯', '│ │ ●', '│ ├─╯', '│ ●', '├─╯', '╰─',
    ]);
  });

  test('a lane whose parent already ended merges into the nearest live ancestor', () => {
    const rows = draw([{ kind: 'head' }, spawn(SPINE, 'a'), spawn('a', 'b'), merge('a'), merge('b'), { kind: 'answer' }]);
    expect(rows[3]).toBe('├─╯ │');
    expect(rows[4]).toBe('├───╯');
  });

  test('a lane with nothing left to merge into just ends', () => {
    const rows = draw([{ kind: 'head' }, spawn(SPINE, 'a'), { kind: 'answer' }, bead('a'), merge('a')]);
    expect(rows.slice(2)).toEqual(['╰─│', '  ●', '  ╰']);
  });
});

describe('lane layout: folded lanes and turns', () => {
  test('a folded lane is one ◉ on its parent lane, in its own color', () => {
    const layout = layoutLaneGraph([{ kind: 'head' }, { kind: 'folded', lane: SPINE, child: 'eng' }, spawn(SPINE, 'cc'), bead('cc'), { kind: 'answer' }]);
    expect(layout.rows.map((row) => gutterText(row, (role) => (role === 'bead' ? '●' : laneGlyphs('rounded').role[role])))).toEqual(['╭─', '◉', '├─╮', '│ ●', '╰─│']);
    expect(layout.rows[1]![0]).toEqual({ role: 'folded', color: 1 });
    expect(layout.laneColor.get('cc')).toBe(2);
  });

  test('a folded turn is a single ◆ and opens no lane', () => {
    const layout = layoutLaneGraph([{ kind: 'turn' }, { kind: 'row' }]);
    expect(layout.rows.map((row) => gutterText(row, (role) => laneGlyphs('rounded').role[role as 'turn']))).toEqual(['◆', '']);
  });

  test('the continuation gutter under a row carries every lane still live after it', () => {
    const layout = layoutLaneGraph([{ kind: 'head' }, spawn(SPINE, 'a'), bead(SPINE), merge('a'), { kind: 'answer' }]);
    const text = (i: number): string => gutterText(layout.cont[i]!, (role) => laneGlyphs('rounded').role[role as 'vert']);
    expect([text(0), text(1), text(2), text(3), text(4)]).toEqual(['│', '│ │', '│ │', '│', '']);
  });
});

describe('glyph sets', () => {
  const events: LaneEvent[] = [{ kind: 'head' }, spawn(SPINE, 'a'), bead('a'), merge('a'), { kind: 'folded', lane: SPINE, child: 'b' }, { kind: 'answer' }];

  test('rounded', () => {
    expect(draw(events, 'rounded')).toEqual(['╭─', '├─╮', '│ ●', '├─╯', '◉', '╰─']);
  });

  test('square: └ for ╰ and ● for ◉', () => {
    expect(draw(events, 'square')).toEqual(['┌─', '├─┐', '│ ●', '├─┘', '●', '└─']);
  });

  test('ascii: | + ` - and ascii beads', () => {
    const glyphs = laneGlyphs('ascii');
    expect(draw(events, 'ascii', glyphs.ok)).toEqual(['+-', '+-+', '| *', '+-+', '@', '`-']);
    expect([glyphs.ok, glyphs.warn, glyphs.err, glyphs.run[0], glyphs.wait, glyphs.cancel, glyphs.background]).toEqual(['*', '!', 'x', 'o', '?', '.', '>']);
    for (const set of TREE_GLYPH_SET_NAMES) {
      if (set === 'ascii') continue;
      expect(Object.values(laneGlyphs(set).role).every((ch) => ch.length === 1)).toBe(true);
    }
    expect([...Object.values(glyphs.role), glyphs.ok, glyphs.closed, glyphs.opened].every((ch) => /^[\x20-\x7e]+$/.test(ch))).toBe(true);
  });

  test('ascii is chosen whatever the setting when the terminal cannot draw unicode', () => {
    expect(resolveTreeGlyphSet('square', true)).toBe('square');
    expect(resolveTreeGlyphSet('fancy', true)).toBe('rounded');
    expect(resolveTreeGlyphSet(undefined, true)).toBe('rounded');
    expect(resolveTreeGlyphSet('rounded', false)).toBe('ascii');
    expect(probeUnicodeSupport({ TERM: 'dumb', LANG: 'en_US.UTF-8' })).toBe(false);
    expect(probeUnicodeSupport({ TERM: 'xterm-256color', LANG: 'C' })).toBe(false);
    expect(probeUnicodeSupport({ TERM: 'xterm-256color', LC_ALL: 'en_US.ISO-8859-1' })).toBe(false);
    expect(probeUnicodeSupport({ TERM: 'xterm-256color', LANG: 'en_US.UTF-8' })).toBe(true);
    expect(probeUnicodeSupport({ TERM: 'xterm-ghostty' })).toBe(true);
  });
});
