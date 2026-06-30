import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createUiRuntimeEvents } from '../../runtime/ui-events.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core';
import { ContextVisualizerPanel } from '../../panels/context-visualizer-panel.ts';
import type { Line } from '../../types/grid.ts';

function linesText(lines: Line[]): string {
  return lines.map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd()).join('\n');
}

function makePanel(opts: { input: number; limit: number }): ContextVisualizerPanel {
  const bus = new RuntimeEventBus();
  return new ContextVisualizerPanel(
    createUiRuntimeEvents(bus).turns,
    new SessionMemoryStore(),
    new ConfigManager({ surfaceRoot: 'tui', homeDir: '/tmp', workingDir: '/tmp' }),
    () => ({ input: opts.input, output: 0, cacheRead: 0, cacheWrite: 0 }),
    opts.limit,
  );
}

const W = 90;
const H = 22;

describe('ContextVisualizerPanel', () => {
  test('empty state offers concrete next-step commands', () => {
    const panel = makePanel({ input: 0, limit: 0 });
    const text = linesText(panel.render(W, H));
    expect(text).toContain('Context limit unavailable');
    expect(text).toContain('/model');
  });

  test('healthy pressure renders a healthy pill and calm footer', () => {
    const panel = makePanel({ input: 1000, limit: 100000 });
    const text = linesText(panel.render(W, H));
    expect(text).toContain('healthy');
    expect(text).toContain('composition');
    expect(text).not.toContain('reduce context now');
  });

  test('high pressure surfaces a compaction hint in the footer', () => {
    const panel = makePanel({ input: 95000, limit: 100000 });
    const text = linesText(panel.render(W, H));
    expect(text).toContain('critical');
    expect(text).toContain('reduce context now');
  });

  test('over limit renders an over-limit pill', () => {
    const panel = makePanel({ input: 120000, limit: 100000 });
    const text = linesText(panel.render(W, H));
    expect(text).toContain('over limit');
  });

  test('render returns exactly H lines of W cells', () => {
    const panel = makePanel({ input: 5000, limit: 100000 });
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
    for (const line of lines) expect(line).toHaveLength(W);
  });
});
