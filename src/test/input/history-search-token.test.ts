import { describe, expect, test } from 'bun:test';
import { handleHistorySearchToken } from '../../input/handler-ui-state.ts';
import { HistorySearch } from '../../input/input-history.ts';
import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';

function makeKey(logicalName: string, opts: { ctrl?: boolean } = {}): InputToken {
  return {
    type: 'key',
    name: logicalName,
    logicalName,
    ctrl: opts.ctrl ?? false,
    shift: false,
    meta: false,
  } as InputToken;
}

function makeSearch(entries: string[], draft = 'saved-draft'): HistorySearch {
  const hs = new HistorySearch(() => entries);
  hs.open(draft);
  return hs;
}

describe('handleHistorySearchToken — INPUT-1: Enter accepts match', () => {
  test('Enter (logicalName=enter) writes match into prompt and closes search', () => {
    const hs = makeSearch(['npm install', 'npm run dev']);
    hs.search('npm');
    expect(hs.active).toBe(true);
    expect(hs.currentMatch?.entry).toBe('npm install');

    const state = { historySearch: hs, prompt: '', cursorPos: 0, requestRender: () => {} };
    const handled = handleHistorySearchToken(state, makeKey('enter'));

    expect(handled).toBe(true);
    expect(state.prompt).toBe('npm install');
    expect(state.cursorPos).toBe('npm install'.length);
    expect(hs.active).toBe(false);
  });

  test('legacy logicalName=return also accepts (defensive alias)', () => {
    const hs = makeSearch(['git status']);
    hs.search('git');
    const state = { historySearch: hs, prompt: '', cursorPos: 0, requestRender: () => {} };
    handleHistorySearchToken(state, makeKey('return'));

    expect(state.prompt).toBe('git status');
    expect(hs.active).toBe(false);
  });

  test('Enter with no match writes empty string and closes', () => {
    const hs = makeSearch(['npm install'], 'my-draft');
    // no search call → no matches
    const state = { historySearch: hs, prompt: 'my-draft', cursorPos: 8, requestRender: () => {} };
    handleHistorySearchToken(state, makeKey('enter'));

    expect(state.prompt).toBe('');
    expect(hs.active).toBe(false);
  });
});

describe('handleHistorySearchToken — cancel paths still restore saved draft', () => {
  test('Escape cancels and restores savedDraft', () => {
    const hs = makeSearch(['npm install'], 'saved-draft');
    hs.search('npm');
    const state = { historySearch: hs, prompt: '', cursorPos: 0, requestRender: () => {} };
    handleHistorySearchToken(state, makeKey('escape'));

    expect(state.prompt).toBe('saved-draft');
    expect(state.cursorPos).toBe('saved-draft'.length);
    expect(hs.active).toBe(false);
  });

  test('Ctrl+G cancels and restores savedDraft', () => {
    const hs = makeSearch(['npm install'], 'saved-draft');
    hs.search('npm');
    const state = { historySearch: hs, prompt: '', cursorPos: 0, requestRender: () => {} };
    handleHistorySearchToken(state, makeKey('g', { ctrl: true }));

    expect(state.prompt).toBe('saved-draft');
    expect(state.cursorPos).toBe('saved-draft'.length);
    expect(hs.active).toBe(false);
  });
});

describe('handleHistorySearchToken — inactive guard', () => {
  test('returns false when historySearch is inactive', () => {
    const hs = new HistorySearch(() => ['npm install']);
    // not opened → active = false
    const state = { historySearch: hs, prompt: 'untouched', cursorPos: 0, requestRender: () => {} };
    const handled = handleHistorySearchToken(state, makeKey('enter'));

    expect(handled).toBe(false);
    expect(state.prompt).toBe('untouched');
  });
});
