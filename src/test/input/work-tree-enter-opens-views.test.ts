import { describe, expect, test } from 'bun:test';
import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import type { BlockMeta } from '../../core/conversation-types.ts';
import type { ConversationManager } from '../../core/conversation.ts';
import { WorkTreeController } from '../../core/work-tree-focus.ts';
import { handleWorkTreeToken } from '../../input/handler-work-tree-route.ts';
import { backgroundProcessId } from '../../core/work-tree-render.ts';
import { appendConversationMessages, type ConversationRenderContext } from '../../core/conversation-rendering.ts';
import { lanesScene } from '../helpers/work-tree-scenes.ts';

const enter: InputToken = { type: 'key', logicalName: 'enter', ctrl: false, meta: false, shift: false } as InputToken;

function block(workTree: NonNullable<BlockMeta['workTree']>, startLine: number): BlockMeta {
  return { blockIndex: 0, collapseKey: `k_${workTree.id}`, type: 'tool', startLine, lineCount: 1, rawContent: '', workTree } as BlockMeta;
}

function setup(blocks: BlockMeta[]) {
  const collapse = new Map<string, boolean>();
  const tree = new WorkTreeController({ blocks: () => blocks, collapseState: () => collapse, markDirty: () => {}, noteUserTouch: () => {}, drewLive: () => false });
  const opened: string[] = [];
  const state = {
    conversationManager: { workTree: tree } as unknown as ConversationManager,
    enterMatch: false, anchorLine: 0, scrollTop: 0, viewportHeight: 20,
    scroll: () => {}, requestRender: () => {}, onCopied: () => {},
    openAgent: (id: string) => { opened.push(`agent:${id}`); return true; },
    openProcess: (id: string) => { opened.push(`process:${id}`); return true; },
  };
  return { tree, state, opened, collapse };
}

describe('Enter in the work tree', () => {
  test('on an agent lane it opens that agent full screen and hands the keyboard back', () => {
    const { tree, state, opened } = setup([block({ kind: 'lane', id: 'lane:eng', hasBody: true, open: true, capped: false, agentId: 'eng', colorIndex: 1 }, 0)]);
    tree.enter(0);
    expect(handleWorkTreeToken(state, enter)).toBe(true);
    expect(opened).toEqual(['agent:eng']);
    expect(tree.focused).toBe(false);
  });

  test('on a ▶ bead it opens the background process', () => {
    const { tree, state, opened } = setup([block({ kind: 'bead', id: 'c:1:0', hasBody: true, open: false, capped: false, processId: 'bg-7' }, 0)]);
    tree.enter(0);
    handleWorkTreeToken(state, enter);
    expect(opened).toEqual(['process:bg-7']);
  });

  test('on any other bead it still opens and closes the body', () => {
    const { tree, state, opened, collapse } = setup([block({ kind: 'bead', id: 'c:1:1', hasBody: true, open: false, capped: false }, 0)]);
    tree.enter(0);
    handleWorkTreeToken(state, enter);
    expect(opened).toEqual([]);
    expect(collapse.get('k_c:1:1')).toBe(false);
    expect(tree.focused).toBe(true);
  });
});

describe('work-tree rows carry what Enter opens', () => {
  test('rendered lane rows name their agent and lane color', () => {
    const scene = lanesScene();
    const lines: Line[] = [];
    const ctx: ConversationRenderContext = {
      history: { addLine: (l) => { lines.push(l); }, addLines: (ls) => { lines.push(...ls); }, getLineCount: () => lines.length },
      blockRegistry: [], collapseState: new Map(scene.collapse), errorLineRegistry: [], messageKindRegistry: new Map(),
      configManager: null, splashOptions: {}, workTreeSources: scene.sources, treeGlyphSet: 'rounded', focusId: null, frame: 0,
    };
    appendConversationMessages(ctx, scene.messages, 120, []);
    const lanes = ctx.blockRegistry.filter((b) => b.workTree?.kind === 'lane');
    expect(lanes.map((b) => b.workTree?.agentId)).toEqual(['eng', 'wrfc', 'cc']);
    expect(lanes.every((b) => typeof b.workTree?.colorIndex === 'number' && b.workTree.colorIndex > 0)).toBe(true);
  });

  test('a backgrounded exec result names its process id, at the top level or on its first command', () => {
    expect(backgroundProcessId(JSON.stringify({ cmd: 'bun run dev', process_id: 'bg-1', pid: 1 }))).toBe('bg-1');
    expect(backgroundProcessId(JSON.stringify({ results: [{ cmd: 'x', process_id: 'bg-2' }] }))).toBe('bg-2');
    expect(backgroundProcessId(JSON.stringify({ status: 'started', processId: 'term-3' }))).toBe('term-3');
    expect(backgroundProcessId(JSON.stringify({ cmd: 'x', pid: 1 }))).toBeUndefined();
    expect(backgroundProcessId(undefined)).toBeUndefined();
  });
});
