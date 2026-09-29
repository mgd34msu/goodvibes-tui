import { describe, expect, test } from 'bun:test';
import { readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import { ConversationManager } from '../../core/conversation.ts';
import { boundFoldState, loadWorkTreeFolds, MAX_FOLD_KEYS, saveWorkTreeFolds, sweepOrphanWorkTreeFolds } from '../../core/work-tree-fold-store.ts';
import { lanesScene, openBeadScene } from '../helpers/work-tree-scenes.ts';

type Message = ConversationMessageSnapshot;

function manager(messages: Message[], sources = {}): ConversationManager {
  const cm = new ConversationManager(() => 120);
  cm.fromJSON({ messages });
  cm.setWorkTreeSources(sources);
  cm.setUnicodeCapable(true);
  return cm;
}

function screen(cm: ConversationManager): string[] {
  return cm.getDisplayBlocks().map((l) => l.map((c) => c.char || ' ').join('').replace(/\s+$/, ''));
}

describe('keyboard in the work tree', () => {
  test('entering focuses the last row at or above the anchor, drawn with the fill and ┃', () => {
    const scene = openBeadScene();
    const cm = manager(scene.messages, scene.sources);
    const lines = cm.getDisplayBlocks();
    expect(cm.workTree.enter(lines.length)).toBe(true);
    const focused = screen(cm).find((l) => l.startsWith('┃  ✓'));
    expect(focused).toContain('exec bun test test/retry.test.ts');
    const row = cm.getDisplayBlocks().find((l) => l[0]!.char === '┃' && l[3]!.char === '✓')!;
    expect(row[1]!.bg).not.toBe('');
    expect(row[row.length - 2]!.bg).not.toBe('');
    expect(row[row.length - 1]!.bg).toBe('');
  });

  test('↑↓ move, → opens a body, ← closes it, Enter toggles, Esc leaves without touching anything else', () => {
    const scene = openBeadScene();
    const cm = manager(scene.messages, scene.sources);
    cm.workTree.enter(cm.getDisplayBlocks().length);
    expect(cm.workTree.move(-1)).toBe(true); // onto the edit
    expect(cm.workTree.focus).toBe('c:1:2');
    expect(cm.workTree.act('unfold')).toBe(true);
    expect(screen(cm).some((l) => l.includes('▾ edit src/net/retry.ts'))).toBe(true);
    expect(screen(cm).some((l) => l.includes('+       if (i === opts.attempts - 1) break;'))).toBe(true);
    expect(cm.workTree.act('fold')).toBe(true);
    expect(screen(cm).some((l) => l.includes('▸ edit src/net/retry.ts'))).toBe(true);
    expect(cm.workTree.act('activate')).toBe(true);
    expect(screen(cm).some((l) => l.includes('▾ edit src/net/retry.ts'))).toBe(true);
    const before = cm.getMessageCount();
    cm.workTree.leave();
    expect(cm.workTree.focused).toBe(false);
    expect(cm.getMessageCount()).toBe(before);
    expect(screen(cm).some((l) => l.startsWith('┃  ✓'))).toBe(false);
  });

  test('← on a closed spine bead folds the turn to its header; → unfolds it', () => {
    const scene = openBeadScene();
    const cm = manager(scene.messages, scene.sources);
    cm.workTree.enter(cm.getDisplayBlocks().length);
    cm.workTree.move(-3); // the read
    expect(cm.workTree.act('fold')).toBe(true);
    expect(cm.workTree.focus).toBe('turn_1');
    expect(screen(cm).some((l) => l.includes('read src/net/retry.ts'))).toBe(false);
    expect(screen(cm).some((l) => /◆ +claude-opus-5-5 · 4 tools · 1\.9s ▸/.test(l))).toBe(true);
    expect(cm.workTree.act('unfold')).toBe(true);
    expect(screen(cm).some((l) => l.includes('read src/net/retry.ts'))).toBe(true);
  });

  test('← on a lane folds it to one ◉ bead on its parent lane and the listener hears it', () => {
    const scene = lanesScene();
    const cm = manager(scene.messages, scene.sources);
    let heard = 0;
    cm.workTree.onFoldChange(() => { heard++; });
    cm.getDisplayBlocks();
    const engineerLine = screen(cm).findIndex((l) => l.includes('├─╮') && l.includes('engineer'));
    cm.workTree.enter(engineerLine);
    expect(cm.workTree.focus).toBe('lane_eng');
    expect(cm.workTree.act('fold')).toBe(true);
    expect(heard).toBe(1);
    expect(screen(cm).some((l) => /^┃  ◉ +engineer add a maxDelayMs cap ▸/.test(l))).toBe(true);
    expect(cm.workTree.foldState()).toContainEqual(['lane_eng', true]);
    expect(cm.workTree.act('activate')).toBe(true);
    expect(screen(cm).some((l) => l.includes('├─╮') && l.includes('engineer'))).toBe(true);
  });

  test('Tab on a closed bead opens it (an unset bead key is a closed bead)', () => {
    const scene = openBeadScene();
    const cm = manager(scene.messages, scene.sources);
    const lines = screen(cm);
    const readLine = lines.findIndex((l) => l.includes('read src/net/retry.ts'));
    cm.toggleCollapseAtLine(readLine);
    expect(screen(cm).some((l) => l.includes('▾ read src/net/retry.ts'))).toBe(true);
    expect(screen(cm).some((l) => l.includes('src/net/retry.ts  20 lines'))).toBe(true);
  });

  test('a restored fold state comes back with the session', () => {
    const scene = openBeadScene();
    const cm = manager(scene.messages, scene.sources);
    cm.workTree.restoreFoldState([['turn_1', true], ['not_a_work_tree_key', true]]);
    expect(screen(cm).some((l) => l.includes('read src/net/retry.ts'))).toBe(false);
    expect(cm.workTree.foldState()).toEqual([['turn_1', true]]);
  });
});

describe('fold-state sidecar', () => {
  const dir = (): string => makeProjectTempDir('gv-folds');

  test('saves beside the session file and loads back, dropping keys it does not own', () => {
    const d = dir();
    try {
      saveWorkTreeFolds(d, 'Session One', [['turn_4', true], ['bead_c:5:0', false], ['code_1_2', true]]);
      expect(readdirSync(d)).toEqual(['session-one.work-tree.json']);
      expect(loadWorkTreeFolds(d, 'Session One')).toEqual([['turn_4', true], ['bead_c:5:0', false]]);
      expect(loadWorkTreeFolds(d, 'missing')).toEqual([]);
      writeFileSync(join(d, 'session-one.work-tree.json'), '{ torn');
      expect(loadWorkTreeFolds(d, 'Session One')).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('bounded to the most recent MAX_FOLD_KEYS decisions', () => {
    const many = Array.from({ length: MAX_FOLD_KEYS + 5 }, (_, i) => [`turn_${i}`, true] as const);
    const kept = boundFoldState(many);
    expect(kept).toHaveLength(MAX_FOLD_KEYS);
    expect(kept[0]![0]).toBe('turn_5');
  });

  test('the sweep removes a settled sidecar whose session file is gone, and crash residue', () => {
    const d = dir();
    try {
      writeFileSync(join(d, 'live.jsonl'), '');
      writeFileSync(join(d, 'live.work-tree.json'), '{}');
      writeFileSync(join(d, 'gone.work-tree.json'), '{}');
      writeFileSync(join(d, 'fresh.work-tree.json'), '{}');
      writeFileSync(join(d, 'live.work-tree.json.tmp-99'), '{}');
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(join(d, 'gone.work-tree.json'), old, old);
      utimesSync(join(d, 'live.work-tree.json.tmp-99'), old, old);
      expect(sweepOrphanWorkTreeFolds(d)).toBe(2);
      expect(readdirSync(d).sort()).toEqual(['fresh.work-tree.json', 'live.jsonl', 'live.work-tree.json']);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
