import { describe, expect, test } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { linesToText } from '../setup.ts';

const W = 80;

/** createFooter has a long positional signature; this wraps the args we vary. */
function footer(opts: {
  prompt?: string;
  usageUp?: number;
  usageDown?: number;
  cursorPos?: number;
  contextWindow?: number;
  lastInputTokens?: number;
  commandArgsHint?: string;
}): string[] {
  return linesToText(UIFactory.createFooter(
    W,
    opts.prompt ?? '',
    { up: opts.usageUp ?? 0, down: opts.usageDown ?? 0 },
    false,                       // showExitNotice
    0,                           // lastCopyTime
    'gpt-4o',                    // model
    undefined,                   // toolCount
    opts.cursorPos,              // cursorPos
    undefined,                   // workingDir
    undefined,                   // provider
    opts.contextWindow,          // contextWindow
    undefined,                   // compactThreshold
    false,                       // dangerMode
    opts.lastInputTokens,        // lastInputTokens
    opts.commandArgsHint,        // commandArgsHint
  ));
}

describe('footer render truths (item 5)', () => {
  test('5c — input-token meter shows "—" (not a false 0) before usage is known', () => {
    const tokenLine = footer({ usageUp: 0 }).find((t) => t.includes('Token Usage'));
    expect(tokenLine).toBeDefined();
    expect(tokenLine!).toContain('Input: —');
  });

  test('5c — input-token meter shows the count once usage is known', () => {
    const tokenLine = footer({ usageUp: 1234 }).find((t) => t.includes('Token Usage'));
    expect(tokenLine).toBeDefined();
    expect(tokenLine!).not.toContain('Input: —');
    expect(tokenLine!).toMatch(/Input: \d/);
  });

  test('5c — context meter shows "—" instead of a false 0 before the first input count', () => {
    const barLine = footer({ contextWindow: 100_000, lastInputTokens: 0 }).find((t) => t.includes('Context Usage'));
    expect(barLine).toBeDefined();
    expect(barLine!).toContain('— /');
  });

  test('5b — a long ghost hint is clamped with an ellipsis, not hard-cut', () => {
    const longHint = 'add <name> <url> --branch <branch> --path <path> --pin <sha> --trust <mode> --enable';
    const text = footer({
      prompt: '/marketplace',
      cursorPos: '/marketplace'.length,
      commandArgsHint: longHint,
    }).join('\n');
    expect(text).toContain('…');
  });
});
