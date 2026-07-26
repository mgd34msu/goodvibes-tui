import { describe, test, expect, beforeEach } from 'bun:test';
import { SearchManager } from '../../input/search.ts';
import { InfiniteBuffer } from '../../core/history.ts';
import { ConversationManager } from '../../core/conversation';
import type { Cell } from '../../types/grid.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an InfiniteBuffer from an array of plain strings. */
function bufferFromLines(lines: string[]): InfiniteBuffer {
  const buf = new InfiniteBuffer();
  for (const text of lines) {
    const cells: Cell[] = Array.from(text).map(ch => ({
      char: ch,
      fg: '',
      bg: '',
      bold: false,
      italic: false,
      underline: false,
      dim: false,
      strikethrough: false,
    }));
    buf.addLine(cells);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SearchManager', () => {
  let sm: SearchManager;

  beforeEach(() => {
    sm = new SearchManager();
  });

  // --- open/close ---

  test('open() sets active=true and resets state', () => {
    sm.open();
    expect(sm.active).toBe(true);
    expect(sm.query).toBe('');
    expect(sm.matches).toHaveLength(0);
    expect(sm.currentMatch).toBe(0);
  });

  test('close() sets active=false', () => {
    sm.open();
    sm.close();
    expect(sm.active).toBe(false);
  });

  test('open() after a prior search resets matches', () => {
    const buf = bufferFromLines(['hello world']);
    sm.open();
    sm.search('hello', buf);
    expect(sm.matches).toHaveLength(1);
    sm.open(); // re-open should reset
    expect(sm.matches).toHaveLength(0);
    expect(sm.query).toBe('');
    expect(sm.currentMatch).toBe(0);
  });

  // --- search() ---

  test('search() finds exact match on one line', () => {
    const buf = bufferFromLines(['hello world']);
    sm.open();
    sm.search('hello', buf);
    expect(sm.matches).toHaveLength(1);
    expect(sm.matches[0]).toMatchObject({ line: 0, col: 0, length: 5 });
  });

  test('search() finds multiple matches on same line', () => {
    const buf = bufferFromLines(['abcabc']);
    sm.open();
    sm.search('abc', buf);
    expect(sm.matches).toHaveLength(2);
    expect(sm.matches[0]).toMatchObject({ line: 0, col: 0 });
    expect(sm.matches[1]).toMatchObject({ line: 0, col: 3 });
  });

  test('search() finds matches across multiple lines', () => {
    const buf = bufferFromLines(['foo bar', 'baz foo qux']);
    sm.open();
    sm.search('foo', buf);
    expect(sm.matches).toHaveLength(2);
    expect(sm.matches[0]).toMatchObject({ line: 0 });
    expect(sm.matches[1]).toMatchObject({ line: 1 });
  });

  test('search() is case-insensitive', () => {
    const buf = bufferFromLines(['Hello WORLD']);
    sm.open();
    sm.search('hello', buf);
    expect(sm.matches).toHaveLength(1);
    sm.search('world', buf);
    expect(sm.matches).toHaveLength(1);
  });

  test('search() with empty query returns no matches', () => {
    const buf = bufferFromLines(['hello world']);
    sm.open();
    sm.search('', buf);
    expect(sm.matches).toHaveLength(0);
  });

  test('search() with no matching text returns empty matches', () => {
    const buf = bufferFromLines(['hello world']);
    sm.open();
    sm.search('xyz', buf);
    expect(sm.matches).toHaveLength(0);
  });

  test('search() on empty buffer returns no matches', () => {
    const buf = new InfiniteBuffer();
    sm.open();
    sm.search('hello', buf);
    expect(sm.matches).toHaveLength(0);
  });

  // --- nextMatch() / prevMatch() ---

  test('nextMatch() advances currentMatch', () => {
    const buf = bufferFromLines(['abc abc abc']);
    sm.open();
    sm.search('abc', buf);
    expect(sm.matches).toHaveLength(3);
    expect(sm.currentMatch).toBe(0);
    sm.nextMatch();
    expect(sm.currentMatch).toBe(1);
    sm.nextMatch();
    expect(sm.currentMatch).toBe(2);
  });

  test('nextMatch() wraps around at end', () => {
    const buf = bufferFromLines(['abc abc']);
    sm.open();
    sm.search('abc', buf);
    expect(sm.matches).toHaveLength(2);
    sm.nextMatch(); // -> 1
    sm.nextMatch(); // -> 0 (wrap)
    expect(sm.currentMatch).toBe(0);
  });

  test('prevMatch() goes backwards', () => {
    const buf = bufferFromLines(['abc abc abc']);
    sm.open();
    sm.search('abc', buf);
    sm.nextMatch(); // -> 1
    sm.nextMatch(); // -> 2
    sm.prevMatch(); // -> 1
    expect(sm.currentMatch).toBe(1);
  });

  test('prevMatch() wraps around at start', () => {
    const buf = bufferFromLines(['abc abc']);
    sm.open();
    sm.search('abc', buf);
    expect(sm.currentMatch).toBe(0);
    sm.prevMatch(); // -> wraps to 1
    expect(sm.currentMatch).toBe(1);
  });

  test('nextMatch() does nothing when no matches', () => {
    sm.open();
    sm.nextMatch();
    expect(sm.currentMatch).toBe(0);
  });

  test('prevMatch() does nothing when no matches', () => {
    sm.open();
    sm.prevMatch();
    expect(sm.currentMatch).toBe(0);
  });

  // --- getCurrentMatchLine() ---

  test('getCurrentMatchLine() returns correct line for current match', () => {
    const buf = bufferFromLines(['no match here', 'target', 'also target']);
    sm.open();
    sm.search('target', buf);
    expect(sm.matches).toHaveLength(2);
    expect(sm.getCurrentMatchLine()).toBe(1);
    sm.nextMatch();
    expect(sm.getCurrentMatchLine()).toBe(2);
  });

  test('getCurrentMatchLine() returns -1 when no matches', () => {
    sm.open();
    expect(sm.getCurrentMatchLine()).toBe(-1);
  });

  test('getCurrentMatchLine() returns -1 after search with no results', () => {
    const buf = bufferFromLines(['hello']);
    sm.open();
    sm.search('xyz', buf);
    expect(sm.getCurrentMatchLine()).toBe(-1);
  });

  // --- getMatchesOnLine() (a.k.a. getMatchesForLine) ---

  test('getMatchesOnLine() returns all matches on the given line', () => {
    const buf = bufferFromLines(['abc def abc', 'xyz']);
    sm.open();
    sm.search('abc', buf);
    const line0 = sm.getMatchesOnLine(0);
    expect(line0).toHaveLength(2);
    const line1 = sm.getMatchesOnLine(1);
    expect(line1).toHaveLength(0);
  });

  test('getMatchesOnLine() returns empty when query is empty', () => {
    const buf = bufferFromLines(['abc']);
    sm.open();
    expect(sm.getMatchesOnLine(0)).toHaveLength(0);
  });

  // --- wrapAround ---

  test('wrapAround is false initially', () => {
    sm.open();
    expect(sm.wrapAround).toBe(false);
  });

  test('wrapAround cleared by search()', () => {
    const buf = bufferFromLines(['abc abc']);
    sm.open();
    sm.search('abc', buf);
    sm.nextMatch();
    sm.nextMatch(); // wraps
    expect(sm.wrapAround).toBe(true);
    sm.search('abc', buf); // re-search clears it
    expect(sm.wrapAround).toBe(false);
  });

  test('wrapAround set when nextMatch() wraps past last match', () => {
    const buf = bufferFromLines(['abc abc']);
    sm.open();
    sm.search('abc', buf);
    expect(sm.matches).toHaveLength(2);
    sm.nextMatch(); // 0 -> 1, no wrap
    expect(sm.wrapAround).toBe(false);
    sm.nextMatch(); // 1 -> 0, wraps
    expect(sm.wrapAround).toBe(true);
    expect(sm.currentMatch).toBe(0);
  });

  test('wrapAround set when prevMatch() wraps before first match', () => {
    const buf = bufferFromLines(['abc abc']);
    sm.open();
    sm.search('abc', buf);
    expect(sm.currentMatch).toBe(0);
    sm.prevMatch(); // 0 -> 1, wraps
    expect(sm.wrapAround).toBe(true);
    expect(sm.currentMatch).toBe(1);
  });

  test('wrapAround cleared after non-wrapping navigation', () => {
    const buf = bufferFromLines(['abc abc abc']);
    sm.open();
    sm.search('abc', buf);
    sm.nextMatch(); // 0 -> 1
    sm.nextMatch(); // 1 -> 2
    sm.nextMatch(); // 2 -> 0, wraps
    expect(sm.wrapAround).toBe(true);
    sm.nextMatch(); // 0 -> 1, no wrap
    expect(sm.wrapAround).toBe(false);
  });

  test('wrapAround false when no matches', () => {
    sm.open();
    sm.nextMatch();
    expect(sm.wrapAround).toBe(false);
    sm.prevMatch();
    expect(sm.wrapAround).toBe(false);
  });

  test('open() resets wrapAround', () => {
    const buf = bufferFromLines(['abc abc']);
    sm.open();
    sm.search('abc', buf);
    sm.nextMatch();
    sm.nextMatch(); // wraps
    expect(sm.wrapAround).toBe(true);
    sm.open();
    expect(sm.wrapAround).toBe(false);
  });

  // --- collapsed-content search: honest counts, no expansion on keystroke ---

  describe('search() with a conversationManager counts matches inside collapsed content without expanding it', () => {
    function buildLongToolResult(): { cm: ConversationManager; needle: string } {
      const cm = new ConversationManager(() => 80);
      const needle = 'zzzFindableMarkerZzz';
      // A long tool result (>200 chars, no recognized summarizer shape) stays
      // collapsed by default — its needle is nowhere in the 1-line collapsed
      // preview, only in the raw content.
      const longContent = `line one\nline two with ${needle} inside\n` + 'padding '.repeat(60);
      cm.addAssistantMessage('', { toolCalls: [{ id: 'c1', name: 'exec', arguments: {} }] });
      cm.addToolResults([{ callId: 'c1', success: true, output: longContent }]);
      cm.getDisplayBlocks();
      return { cm, needle };
    }

    test('a query matching only the raw (collapsed) content finds nothing without a conversationManager', () => {
      const { cm, needle } = buildLongToolResult();
      sm.open();
      sm.search(needle, cm.history); // no conversationManager passed — pre-existing behavior
      expect(sm.matches).toHaveLength(0);
    });

    test('the same query counts a match once a conversationManager is passed, but leaves the block collapsed', () => {
      const { cm, needle } = buildLongToolResult();
      const block = cm.getBlockRegistry().find((b) => b.type === 'tool');
      expect(block).toBeDefined();
      expect(cm.isCollapsed(block!.blockIndex)).toBe(true);

      sm.open();
      sm.search(needle, cm.history, cm);

      // Honest count: the hit is real even though nothing expanded.
      expect(sm.matches.length).toBeGreaterThan(0);
      // A single keystroke must never expand a block it merely matched.
      expect(cm.isCollapsed(block!.blockIndex)).toBe(true);
      // getCurrentMatchLine() reports -1 for a still-hidden match — there is
      // no real line to scroll to until the user navigates there.
      expect(sm.getCurrentMatchLine()).toBe(-1);
    });

    test('repeated keystrokes never expand the block either', () => {
      const { cm, needle } = buildLongToolResult();
      const block = cm.getBlockRegistry().find((b) => b.type === 'tool');
      sm.open();
      sm.search(needle.slice(0, 3), cm.history, cm);
      sm.search(needle.slice(0, 6), cm.history, cm);
      sm.search(needle, cm.history, cm);
      expect(cm.isCollapsed(block!.blockIndex)).toBe(true);
      expect(sm.matches.length).toBeGreaterThan(0);
    });

    test('revealCurrentMatch() expands exactly that block and lands on a real, navigable line', () => {
      const { cm, needle } = buildLongToolResult();
      const block = cm.getBlockRegistry().find((b) => b.type === 'tool');
      sm.open();
      sm.search(needle, cm.history, cm);
      expect(cm.isCollapsed(block!.blockIndex)).toBe(true);

      sm.lock();
      sm.revealCurrentMatch(cm.history, cm);

      expect(cm.isCollapsed(block!.blockIndex)).toBe(false);
      const matchLine = sm.getCurrentMatchLine();
      expect(matchLine).toBeGreaterThanOrEqual(0);
      const renderedLineText = cm.history.getAllLines()[matchLine].map((c) => c.char).join('');
      expect(renderedLineText).toContain(needle);
    });

    test('search close (with no user interaction) re-collapses the block search revealed', () => {
      const { cm, needle } = buildLongToolResult();
      const block = cm.getBlockRegistry().find((b) => b.type === 'tool');
      sm.open();
      sm.search(needle, cm.history, cm);
      sm.lock();
      sm.revealCurrentMatch(cm.history, cm);
      expect(cm.isCollapsed(block!.blockIndex)).toBe(false);

      sm.close(cm);
      expect(cm.isCollapsed(block!.blockIndex)).toBe(true);
    });

    test('a block the user explicitly toggled while search had it open stays expanded after close', () => {
      const { cm, needle } = buildLongToolResult();
      const block = cm.getBlockRegistry().find((b) => b.type === 'tool');
      sm.open();
      sm.search(needle, cm.history, cm);
      sm.lock();
      sm.revealCurrentMatch(cm.history, cm);
      expect(cm.isCollapsed(block!.blockIndex)).toBe(false);

      // The user explicitly acts on the block (e.g. Ctrl+Y copy, Ctrl+B
      // bookmark, or re-toggling it) while it sits auto-expanded.
      cm.searchExpansion.noteUserTouch(block!.collapseKey);

      sm.close(cm);
      expect(cm.isCollapsed(block!.blockIndex)).toBe(false);
    });

    test("closing search never disturbs a block the user had already expanded before search opened", () => {
      const { cm, needle } = buildLongToolResult();
      const block = cm.getBlockRegistry().find((b) => b.type === 'tool');
      // User expands it themselves, before search ever runs.
      cm.toggleCollapseAtLine(block!.startLine);
      expect(cm.isCollapsed(block!.blockIndex)).toBe(false);

      sm.open();
      sm.search(needle, cm.history, cm);
      sm.lock();
      sm.revealCurrentMatch(cm.history, cm); // no-op: already visible, not hidden
      sm.close(cm);

      expect(cm.isCollapsed(block!.blockIndex)).toBe(false);
    });
  });

  // --- folded tool-result group members (search reaches inside the fold) ---

  describe('search() reaches text hidden inside a collapsed assistant turn', () => {
    const NEEDLE = 'zzzGroupedMarkerZzz';

    /** Two results for one assistant turn hang under a single 'assistant_turn'
     *  header (see conversation-turn-structure.ts). Once that turn is
     *  collapsed the header is its entire visible representation and no result
     *  registers a BlockMeta of its own, so the needle — which lives ONLY in
     *  the second result's content, never in the header's summary — is
     *  reachable only through the turn's groupMemberIndexes. */
    function buildFoldedToolGroup(): { cm: ConversationManager; hitMemberIdx: number } {
      const cm = new ConversationManager(() => 80);
      // Long enough that each member is collapsed-by-default on its own too,
      // so expanding the group header alone would not reveal the needle.
      const padded = (marker: string) => `alpha\nbeta ${marker} inside\n` + 'padding '.repeat(60);
      cm.addUserMessage('run the tools');
      cm.addAssistantMessage('', { toolCalls: [
        { id: 'c1', name: 'read', arguments: {} },
        { id: 'c2', name: 'exec', arguments: {} },
      ] });
      cm.addToolResults([
        { callId: 'c1', success: true, output: padded('nothing to see') },
        { callId: 'c2', success: true, output: padded(NEEDLE) },
      ]);
      cm.getDisplayBlocks();
      // Turns default EXPANDED (collapsing must never hide prose), so the
      // hidden-content condition this suite is about is created explicitly.
      cm.setCollapsed('turn_1', true);
      cm.getDisplayBlocks();
      const group = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn');
      expect(group).toBeDefined();
      expect(group!.groupMemberIndexes).toHaveLength(2);
      return { cm, hitMemberIdx: group!.groupMemberIndexes![1] };
    }

    test('the turn is collapsed and its own rawContent is only the summary line', () => {
      const { cm } = buildFoldedToolGroup();
      const group = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn');
      // The defect this covers: the needle is in no block's rawContent at all,
      // because the members contributed no BlockMeta.
      expect(cm.isCollapsed(group!.blockIndex)).toBe(true);
      expect(group!.rawContent).not.toContain(NEEDLE);
      expect(cm.getBlockRegistry().some((b) => b.rawContent.includes(NEEDLE))).toBe(false);
    });

    test('a member-only needle finds nothing without a conversationManager', () => {
      const { cm } = buildFoldedToolGroup();
      sm.open();
      sm.search(NEEDLE, cm.history);
      expect(sm.matches).toHaveLength(0);
    });

    test('a keystroke counts the member-only hit honestly but expands nothing', () => {
      const { cm } = buildFoldedToolGroup();
      const group = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn');
      sm.open();
      sm.search(NEEDLE, cm.history, cm);

      expect(sm.matches.length).toBeGreaterThan(0);
      expect(cm.isCollapsed(group!.blockIndex)).toBe(true);
      expect(cm.getBlockRegistry().some((b) => b.collapseKey.startsWith('msg_'))).toBe(false);
    });

    test('revealCurrentMatch() expands the turn AND the hit result (and only that result), landing on the needle line', () => {
      const { cm, hitMemberIdx } = buildFoldedToolGroup();
      const group = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn');
      const otherMemberIdx = group!.groupMemberIndexes!.find((idx) => idx !== hitMemberIdx)!;

      sm.open();
      sm.search(NEEDLE, cm.history, cm);
      sm.lock();
      sm.revealCurrentMatch(cm.history, cm);

      expect(sm.matches.length).toBeGreaterThan(0);

      const registry = cm.getBlockRegistry();
      const groupAfter = registry.find((b) => b.type === 'assistant_turn');
      expect(cm.isCollapsed(groupAfter!.blockIndex)).toBe(false);
      // The hit member now has a block of its own, and it is expanded — the
      // header alone would have left its content invisible.
      const member = registry.find((b) => b.collapseKey === `msg_${hitMemberIdx}`);
      expect(member).toBeDefined();
      expect(cm.isCollapsed(member!.blockIndex)).toBe(false);
      // Its sibling member (no hit inside it) is left exactly as it was —
      // "exactly that block" expands, not every member indiscriminately. It
      // still has its own (collapsed-by-default) BlockMeta now that the
      // group itself has unfolded.
      const otherMember = registry.find((b) => b.collapseKey === `msg_${otherMemberIdx}`);
      expect(otherMember).toBeDefined();
      expect(cm.isCollapsed(otherMember!.blockIndex)).toBe(true);
      // The landed line is the real one.
      const matchLine = sm.getCurrentMatchLine();
      expect(matchLine).toBeGreaterThanOrEqual(0);
      const renderedLineText = cm.history.getAllLines()[matchLine].map((c) => c.char).join('');
      expect(renderedLineText).toContain(NEEDLE);
    });

    test('search close re-collapses the turn and the result together', () => {
      const { cm, hitMemberIdx } = buildFoldedToolGroup();
      sm.open();
      sm.search(NEEDLE, cm.history, cm);
      sm.lock();
      sm.revealCurrentMatch(cm.history, cm);

      let registry = cm.getBlockRegistry();
      expect(cm.isCollapsed(registry.find((b) => b.type === 'assistant_turn')!.blockIndex)).toBe(false);
      expect(cm.isCollapsed(registry.find((b) => b.collapseKey === `msg_${hitMemberIdx}`)!.blockIndex)).toBe(false);

      sm.close(cm);
      cm.getDisplayBlocks();

      registry = cm.getBlockRegistry();
      const groupAfter = registry.find((b) => b.type === 'assistant_turn');
      expect(groupAfter).toBeDefined();
      expect(cm.isCollapsed(groupAfter!.blockIndex)).toBe(true);
      // The member no longer materializes its own BlockMeta — folded again
      // right along with its group, exactly as it was before search opened.
      expect(registry.some((b) => b.collapseKey === `msg_${hitMemberIdx}`)).toBe(false);
    });

    test('a needle present nowhere finds nothing and expands nothing', () => {
      const { cm } = buildFoldedToolGroup();
      const group = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn');
      sm.open();
      sm.search('nonexistent_needle_qqq', cm.history, cm);

      expect(sm.matches).toHaveLength(0);
      expect(sm.getCurrentMatchLine()).toBe(-1);
      const registry = cm.getBlockRegistry();
      expect(cm.isCollapsed(group!.blockIndex)).toBe(true);
      // No member materialized — the fold is untouched.
      expect(registry.some((b) => b.collapseKey.startsWith('msg_'))).toBe(false);
    });

    test('a turn whose results are already expanded still matches, and search never touches its collapse state', () => {
      const { cm, hitMemberIdx } = buildFoldedToolGroup();
      const group = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn');
      cm.setCollapsed(group!.collapseKey, false);
      for (const memberIdx of group!.groupMemberIndexes!) {
        cm.setCollapsed(`msg_${memberIdx}`, false);
      }
      cm.getDisplayBlocks();

      sm.open();
      sm.search(NEEDLE, cm.history, cm);
      sm.lock();
      sm.revealCurrentMatch(cm.history, cm); // no-op: already visible

      expect(sm.matches.length).toBeGreaterThan(0);
      const registry = cm.getBlockRegistry();
      expect(cm.isCollapsed(registry.find((b) => b.type === 'assistant_turn')!.blockIndex)).toBe(false);
      expect(cm.isCollapsed(registry.find((b) => b.collapseKey === `msg_${hitMemberIdx}`)!.blockIndex)).toBe(false);
    });

    test('result indexes that outlived their messages are skipped, not thrown on', () => {
      // undo() splices the messages tail while the (unflushed) block registry
      // still names the group's member indexes — so the member lookup runs
      // against a snapshot shorter than those indexes.
      const { cm } = buildFoldedToolGroup();
      expect(cm.undo()).toBe(true);
      expect(cm.getMessageSnapshot().length).toBe(0);
      expect(cm.getBlockRegistry().some((b) => b.type === 'assistant_turn')).toBe(true);

      sm.open();
      expect(() => sm.search(NEEDLE, cm.history, cm)).not.toThrow();
      expect(sm.matches).toHaveLength(0);
    });
  });
});
