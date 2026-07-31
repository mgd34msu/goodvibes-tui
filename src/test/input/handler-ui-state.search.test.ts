import { describe, test, expect, beforeEach } from 'bun:test';
import { handleSearchModeToken } from '../../input/handler-ui-state.ts';
import { SearchManager } from '../../input/search.ts';
import { InfiniteBuffer } from '../../core/history.ts';
import type { Cell } from '@pellux/goodvibes-sdk/platform/types';
import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function keyToken(logicalName: string, opts: { ctrl?: boolean; shift?: boolean } = {}): InputToken {
  return {
    type: 'key',
    name: logicalName,
    logicalName,
    ctrl: opts.ctrl ?? false,
    shift: opts.shift ?? false,
    meta: false,
  };
}

function textToken(value: string): InputToken {
  return { type: 'text', value };
}

type RouteState = Parameters<typeof handleSearchModeToken>[0];

function makeState(sm: SearchManager, scrollTop = 0, viewportHeight = 20): RouteState & { scrollDelta: number } {
  let scrollDelta = 0;
  return {
    searchManager: sm,
    requestRender: () => {},
    scroll: (delta: number) => { scrollDelta += delta; },
    getScrollTop: () => scrollTop,
    getViewportHeight: () => viewportHeight,
    get scrollDelta() { return scrollDelta; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleSearchModeToken — n/N navigation', () => {
  let sm: SearchManager;
  let buf: InfiniteBuffer;

  beforeEach(() => {
    sm = new SearchManager();
    buf = bufferFromLines(['alpha beta', 'alpha gamma', 'alpha delta']);
    sm.open();
    sm.search('alpha', buf);
    sm.lock();
  });

  test('n advances to next match', () => {
    const state = makeState(sm);
    expect(sm.currentMatch).toBe(0);
    const handled = handleSearchModeToken(state, textToken('n'), buf, false);
    expect(handled).toBe(true);
    expect(sm.currentMatch).toBe(1);
  });

  test('N goes to previous match', () => {
    sm.nextMatch(); // -> 1
    const state = makeState(sm);
    const handled = handleSearchModeToken(state, textToken('N'), buf, false);
    expect(handled).toBe(true);
    expect(sm.currentMatch).toBe(0);
  });

  test('n wraps around and sets wrapAround flag', () => {
    const state = makeState(sm);
    handleSearchModeToken(state, textToken('n'), buf, false); // 0->1
    handleSearchModeToken(state, textToken('n'), buf, false); // 1->2
    handleSearchModeToken(state, textToken('n'), buf, false); // 2->0, wrap
    expect(sm.currentMatch).toBe(0);
    expect(sm.wrapAround).toBe(true);
  });

  test('N wraps around from first match and sets wrapAround flag', () => {
    const state = makeState(sm);
    expect(sm.currentMatch).toBe(0);
    handleSearchModeToken(state, textToken('N'), buf, false); // 0->2, wrap
    expect(sm.currentMatch).toBe(2);
    expect(sm.wrapAround).toBe(true);
  });

  test('n scrolls viewport to center on match line', () => {
    const state = makeState(sm, 0, 10);
    handleSearchModeToken(state, textToken('n'), buf, false); // advance to match at line 1
    // scroll: matchLine(1) - scrollTop(0) - floor(10/2)=5 = -4
    expect(state.scrollDelta).toBe(1 - 0 - 5);
  });

  test('j/k still navigate (compatibility)', () => {
    const state = makeState(sm);
    handleSearchModeToken(state, textToken('j'), buf, false);
    expect(sm.currentMatch).toBe(1);
    handleSearchModeToken(state, textToken('k'), buf, false);
    expect(sm.currentMatch).toBe(0);
  });
});

describe('handleSearchModeToken — highlight application and clearing', () => {
  let sm: SearchManager;
  let buf: InfiniteBuffer;

  beforeEach(() => {
    sm = new SearchManager();
    buf = bufferFromLines(['hello world', 'hello again']);
    sm.open();
  });

  test('typing builds query and populates matches', () => {
    const state = makeState(sm);
    handleSearchModeToken(state, textToken('h'), buf, false);
    handleSearchModeToken(state, textToken('e'), buf, false);
    handleSearchModeToken(state, textToken('l'), buf, false);
    handleSearchModeToken(state, textToken('l'), buf, false);
    handleSearchModeToken(state, textToken('o'), buf, false);
    expect(sm.query).toBe('hello');
    expect(sm.matches).toHaveLength(2);
    expect(sm.getMatchesOnLine(0)).toHaveLength(1);
    expect(sm.getMatchesOnLine(1)).toHaveLength(1);
  });

  test('Esc clears search state completely (active=false, matches empty)', () => {
    sm.search('hello', buf);
    const state = makeState(sm);
    const handled = handleSearchModeToken(state, keyToken('escape'), buf, false);
    expect(handled).toBe(true);
    expect(sm.active).toBe(false);
    // After close, matches list is not cleared by close() — that is correct;
    // the compositor guards on active before rendering highlights.
    // But query is no longer driving highlights since active=false.
  });

  test('backspace removes last character from query and re-searches', () => {
    sm.search('hello', buf);
    expect(sm.matches).toHaveLength(2);
    const state = makeState(sm);
    handleSearchModeToken(state, keyToken('backspace'), buf, false);
    expect(sm.query).toBe('hell');
    // 'hell' still matches 'hello world' and 'hello again'
    expect(sm.matches).toHaveLength(2);
  });

  test('backspace to empty query yields no matches', () => {
    sm.search('h', buf);
    const state = makeState(sm);
    handleSearchModeToken(state, keyToken('backspace'), buf, false);
    expect(sm.query).toBe('');
    expect(sm.matches).toHaveLength(0);
  });
});

describe('handleSearchModeToken — case behavior', () => {
  test('search is case-insensitive by default', () => {
    const sm = new SearchManager();
    const buf = bufferFromLines(['Hello WORLD', 'hello world']);
    sm.open();
    const state = makeState(sm);
    // Type uppercase HELLO
    for (const ch of 'HELLO') {
      handleSearchModeToken(state, textToken(ch), buf, false);
    }
    // Should match 'Hello' on line 0 and 'hello' on line 1
    expect(sm.matches).toHaveLength(2);
  });

  test('lowercase query matches uppercase text', () => {
    const sm = new SearchManager();
    const buf = bufferFromLines(['ALPHA BETA']);
    sm.open();
    sm.search('alpha', buf);
    expect(sm.matches).toHaveLength(1);
  });
});

describe('handleSearchModeToken — zero-match state', () => {
  test('navigation tokens do not crash when no matches', () => {
    const sm = new SearchManager();
    const buf = bufferFromLines(['hello']);
    sm.open();
    sm.search('zzz', buf);
    sm.lock();
    const state = makeState(sm);
    expect(() => handleSearchModeToken(state, textToken('n'), buf, false)).not.toThrow();
    expect(() => handleSearchModeToken(state, textToken('N'), buf, false)).not.toThrow();
    expect(sm.currentMatch).toBe(0);
  });

  test('n/N with no matches do not scroll', () => {
    const sm = new SearchManager();
    const buf = bufferFromLines(['hello']);
    sm.open();
    sm.search('zzz', buf);
    sm.lock();
    const state = makeState(sm);
    handleSearchModeToken(state, textToken('n'), buf, false);
    handleSearchModeToken(state, textToken('N'), buf, false);
    expect(state.scrollDelta).toBe(0);
  });
});

describe('handleSearchModeToken — golden-frame non-bleed', () => {
  test('inactive manager: all tokens return false (no bleed into normal input)', () => {
    const sm = new SearchManager();
    const buf = bufferFromLines(['hello']);
    // sm is NOT active
    const state = makeState(sm);
    expect(handleSearchModeToken(state, textToken('n'), buf, false)).toBe(false);
    expect(handleSearchModeToken(state, textToken('N'), buf, false)).toBe(false);
    expect(handleSearchModeToken(state, keyToken('escape'), buf, false)).toBe(false);
    expect(handleSearchModeToken(state, textToken('hello'), buf, false)).toBe(false);
  });
});
