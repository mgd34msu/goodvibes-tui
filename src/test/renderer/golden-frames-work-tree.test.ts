// ---------------------------------------------------------------------------
// golden-frames-work-tree.test.ts, the conversation work tree's golden frames.
//
// The concept page's work-tree scenes (single lane, opened beads, agent lanes,
// three levels of nesting, live/waiting/failed/cancelled states, folded lanes),
// rendered through the real transcript path (appendConversationMessages) at a
// fixed clock, plus the single lane in the square and ascii glyph sets. The
// layout audit (golden-frames-audit.test.ts) checks every frame written here.
//
// Theme sets: golden-frames/ for goodvibes (this file), and
// golden-frames-goodvibes-neon/ through golden-frames-work-tree-neon.test.ts.
//
// Update path:
//   GOODVIBES_UPDATE_GOLDENS=1 bun test src/test/renderer/golden-frames-work-tree.test.ts
//   GOODVIBES_UPDATE_GOLDENS=1 bun test src/test/renderer/golden-frames-work-tree-neon.test.ts
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { appendConversationMessages, type ConversationRenderContext } from '../../core/conversation-rendering.ts';
import { activeTokens, setActiveThemeMode, setActiveThemeName } from '../../renderer/theme.ts';
import { primeSemanticSummary } from '../../renderer/lane-graph/semantic-memo.ts';
import { settleSyntaxHighlighting } from '../../renderer/code-block.ts';
import { beadBody } from '../../renderer/lane-graph/bead.ts';
import type { TreeGlyphSetName } from '../../renderer/lane-graph/glyphs.ts';
import { auditFrame } from '../helpers/frame-audit.ts';
import { assertGoldenIn, encodeGolden } from '../helpers/golden-snapshot.ts';
import { WORK_TREE_SCENES, openBeadScene, singleLaneScene, type WorkTreeScene } from '../helpers/work-tree-scenes.ts';

const THEME = process.env['GOODVIBES_GOLDEN_THEME'] ?? 'goodvibes';
setActiveThemeName(THEME);
setActiveThemeMode('dark');
const DIR = new URL(THEME === 'goodvibes' ? './golden-frames/' : `./golden-frames-${THEME}/`, import.meta.url).pathname;
const W = 120;

// The opened edit's ◈ summary is computed by tree-sitter asynchronously; a
// frame must not depend on whether it landed, so it is fixed here.
{
  const scene = openBeadScene();
  const assistant = scene.messages[1];
  const edit = assistant?.role === 'assistant' ? assistant.toolCalls?.[2] : undefined;
  const result = scene.messages.find((m) => m.role === 'tool' && m.callId === 'c-edit');
  const body = edit && result?.role === 'tool' ? beadBody(edit, 'ok', result.content) : null;
  if (body?.kind === 'diff' && body.path) {
    primeSemanticSummary(body.diff, body.path, {
      symbols: [{ kind: 'modified', symbolKind: 'function', name: 'withRetry' }, { kind: 'added', symbolKind: 'variable', name: 'backoff' }],
      imports: [],
      totalChanges: 2,
    });
  }
}

function render(scene: WorkTreeScene, glyphs: TreeGlyphSetName = 'rounded', width = W): Line[] {
  const lines: Line[] = [];
  const context: ConversationRenderContext = {
    history: { addLine: (l) => { lines.push(l); }, addLines: (ls) => { lines.push(...ls); }, getLineCount: () => lines.length },
    blockRegistry: [],
    collapseState: new Map(scene.collapse),
    errorLineRegistry: [],
    messageKindRegistry: new Map(),
    configManager: null,
    splashOptions: {},
    workTreeSources: scene.sources,
    treeGlyphSet: glyphs,
    focusId: scene.focusId,
    frame: 0,
  };
  appendConversationMessages(context, scene.messages, width, []);
  return lines;
}

/**
 * A frame drawn once tree-sitter highlighting has settled. The first draw of
 * a code line uses the regex placeholder and schedules the parse; the settled
 * draw is what the app shows once the parse lands, and it no longer depends
 * on whether another test file in this process parsed the same code first.
 */
async function renderSettled(draw: () => Line[]): Promise<Line[]> {
  draw();
  await settleSyntaxHighlighting();
  return draw();
}

describe(`golden-frames : work tree (${THEME})`, () => {
  for (const make of WORK_TREE_SCENES) {
    const name = make().name;
    test(`work-tree-${name}`, async () => {
      const lines = await renderSettled(() => render(make()));
      expect(lines.length).toBeGreaterThan(0);
      assertGoldenIn(DIR, `work-tree-${name}`, lines);
      expect(encodeGolden(name, render(make()))).toBe(encodeGolden(name, lines));
      expect(auditFrame(lines, W, activeTokens()).map((i) => `${i.kind} row ${i.row}: ${i.detail}`)).toEqual([]);
    });
  }

  for (const glyphs of ['square', 'ascii'] as const) {
    test(`work-tree-single-lane-${glyphs}`, async () => {
      const lines = await renderSettled(() => render(singleLaneScene(), glyphs));
      assertGoldenIn(DIR, `work-tree-single-lane-${glyphs}`, lines);
    });
  }

  test('work-tree-lanes-80: the lane graph at 80 columns', async () => {
    const lines = await renderSettled(() => render(WORK_TREE_SCENES[2]!(), 'rounded', 80));
    assertGoldenIn(DIR, 'work-tree-lanes-80', lines);
    expect(lines.every((l) => l.length === 80)).toBe(true);
  });
});
