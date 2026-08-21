/**
 * light-transcript-chrome.test.ts, ux/light-transcript wiring.
 *
 * The transcript-side chrome that paints on the TRANSPARENT terminal background
 * (tool-call status glyphs, the footer risk:remote marker, the idle
 * process-indicator status line, system-message left-border notices, and the
 * completed thinking block) now resolves its foregrounds per render through
 * activeUiTones()/activeTheme() instead of the static dark UI_TONES. In light
 * mode those foregrounds invert toward dark so they read on a light terminal.
 *
 * Each site is proven two ways:
 *   1. The flip is real, the light render's colour set differs from dark, and
 *      the exact designed light hex appears (dark hex disappears).
 *   2. The dark path is untouched, the dark render is byte-identical across
 *      renders AND carries the pre-change dark hex (the values are byte-equal to
 *      the old static reads, so every dark golden in the suite stays put).
 *
 * afterEach restores the shared default (dark) so sibling test files and the
 * golden suite are never left in light mode.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { ToolCall } from '@pellux/goodvibes-sdk/platform/types';
import { renderToolCallBlock } from '../../renderer/tool-call.ts';
import { renderProcessIndicator } from '../../renderer/process-indicator.ts';
import { renderSystemMessage } from '../../renderer/system-message.ts';
import { renderThinkingBlock } from '../../renderer/thinking.ts';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { setActiveThemeMode } from '../../renderer/theme.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';

afterEach(() => setActiveThemeMode('dark'));

const W = 100;

/** Distinct non-empty foreground colours across a rendered surface. */
function fgSet(lines: Line[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines) for (const cell of line) if (cell.fg) out.add(cell.fg);
  return out;
}

/** Render `fn` under light mode, always restoring dark afterwards. */
function underLight<T>(fn: () => T): T {
  setActiveThemeMode('light');
  try {
    return fn();
  } finally {
    setActiveThemeMode('dark');
  }
}

// ── tool-call status glyphs (chrome.good / chrome.bad) ─────────────────────
describe('tool-call status glyph flips with themeMode', () => {
  const doneCall: ToolCall = { id: 'c1', name: 'read', arguments: { path: 'src/x.ts' } };
  const errorCall: ToolCall = { id: 'c2', name: 'write', arguments: { path: 'src/y.ts' } };

  test('done ✓ uses chrome.good: #22c55e dark, #15803d light', () => {
    const dark = fgSet(renderToolCallBlock(doneCall, 'done', '3 lines', W, 1_500));
    const light = fgSet(underLight(() => renderToolCallBlock(doneCall, 'done', '3 lines', W, 1_500)));
    expect(dark.has('#22c55e')).toBe(true);
    expect(dark.has('#15803d')).toBe(false);
    expect(light.has('#15803d')).toBe(true);
    expect(light.has('#22c55e')).toBe(false);
  });

  test('error ✕ + error suffix use chrome.bad: #ef4444 dark, #dc2626 light', () => {
    const dark = fgSet(renderToolCallBlock(errorCall, 'error', undefined, W, undefined, 'permission denied'));
    const light = fgSet(underLight(() => renderToolCallBlock(errorCall, 'error', undefined, W, undefined, 'permission denied')));
    expect(dark.has('#ef4444')).toBe(true);
    expect(dark.has('#dc2626')).toBe(false);
    expect(light.has('#dc2626')).toBe(true);
    expect(light.has('#ef4444')).toBe(false);
  });

  test('dark render is byte-identical across renders (dark-path proof)', () => {
    const a = renderToolCallBlock(doneCall, 'done', '3 lines', W, 1_500);
    const b = renderToolCallBlock(doneCall, 'done', '3 lines', W, 1_500);
    expect(fgSet(a)).toEqual(fgSet(b));
  });
});

// ── footer risk:remote marker (chrome.remote) ──────────────────────────────
describe('footer risk:remote marker flips with themeMode', () => {
  const footer = (): Line[] => UIFactory.createFooter(
    W, '> Ask me anything', { up: 1024, down: 512 }, false, 0,
    'claude-opus-4', 7, undefined, '/workspace/my-project', 'anthropic',
    100_000, 0.80, false, 60_000, undefined, undefined, true,
    'plan', 'idle', undefined, 'remote', false,
  );

  test('risk:remote uses chrome.remote; #a78bfa dark, #6d28d9 light (distinct from reasoningAccent #7c3aed)', () => {
    const dark = fgSet(footer());
    const light = fgSet(underLight(footer));
    expect(dark.has('#a78bfa')).toBe(true);
    expect(dark.has('#6d28d9')).toBe(false);
    expect(light.has('#6d28d9')).toBe(true);
    expect(light.has('#a78bfa')).toBe(false);
    expect(light.has('#7c3aed')).toBe(false); // never collides with the reasoning accent
  });
});

// ── idle process-indicator status line (accent.brand) ──────────────────────
describe('process-indicator plain status flips with themeMode', () => {
  test('active status uses accent.brand: #00ffff dark, #0077aa light', () => {
    const dark = fgSet(renderProcessIndicator(W, 1, 0));
    const light = fgSet(underLight(() => renderProcessIndicator(W, 1, 0)));
    expect(dark.has('#00ffff')).toBe(true);
    expect(dark.has('#0077aa')).toBe(false);
    expect(light.has('#0077aa')).toBe(true);
    expect(light.has('#00ffff')).toBe(false);
  });
});

// ── system-message left-border notices (BORDERS sweep) ─────────────────────
describe('system-message border/text flip with themeMode', () => {
  test('error border uses chrome.bad: #ef4444 dark, #dc2626 light', () => {
    const dark = fgSet(renderSystemMessage('the build failed with an error', W, 'error'));
    const light = fgSet(underLight(() => renderSystemMessage('the build failed with an error', W, 'error')));
    expect(dark.has('#ef4444')).toBe(true);
    expect(light.has('#dc2626')).toBe(true);
    expect(light.has('#ef4444')).toBe(false);
  });

  test('warning border uses chrome.warn: #f59e0b dark, #b45309 light', () => {
    const dark = fgSet(renderSystemMessage('context usage is high', W, 'warning'));
    const light = fgSet(underLight(() => renderSystemMessage('context usage is high', W, 'warning')));
    expect(dark.has('#f59e0b')).toBe(true);
    expect(light.has('#b45309')).toBe(true);
    expect(light.has('#f59e0b')).toBe(false);
  });

  test('info border=state.info + text=chrome.faint: #38bdf8/#475569 dark, #0369a1/#94a3b8 light', () => {
    const dark = fgSet(renderSystemMessage('[Plan] step complete', W, 'info'));
    const light = fgSet(underLight(() => renderSystemMessage('[Plan] step complete', W, 'info')));
    expect(dark.has('#38bdf8')).toBe(true); // state.info (dark)
    expect(dark.has('#475569')).toBe(true); // chrome.faint (dark) == fg.dim
    expect(light.has('#0369a1')).toBe(true); // state.info (light)
    expect(light.has('#94a3b8')).toBe(true); // chrome.faint (light)
    expect(light.has('#38bdf8')).toBe(false);
  });
});

// ── completed thinking block (BORDERS.THINKING sweep) ──────────────────────
describe('thinking block accent/text flip with themeMode', () => {
  const TEXT = 'Weighing the two approaches and going with the second one.';

  test('accent=state.reasoning + text=chrome.faint: #a855f7/#475569 dark, #7c3aed/#94a3b8 light', () => {
    const dark = fgSet(renderThinkingBlock(TEXT, W));
    const light = fgSet(underLight(() => renderThinkingBlock(TEXT, W)));
    expect(dark.has('#a855f7')).toBe(true); // state.reasoning (dark)
    expect(dark.has('#475569')).toBe(true); // chrome.faint (dark)
    expect(light.has('#7c3aed')).toBe(true); // state.reasoning (light)
    expect(light.has('#94a3b8')).toBe(true); // chrome.faint (light)
    expect(light.has('#a855f7')).toBe(false);
  });

  test('dark render is byte-identical across renders (dark-path proof)', () => {
    expect(fgSet(renderThinkingBlock(TEXT, W))).toEqual(fgSet(renderThinkingBlock(TEXT, W)));
  });
});
