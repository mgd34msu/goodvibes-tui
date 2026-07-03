import { describe, test, expect } from 'bun:test';
import { MemoryPanel } from '../../../panels/memory-panel.ts';
import { runBasePanelContractSuite, EMPTY_MEMORY_REGISTRY, W, H } from './_shared.ts';

runBasePanelContractSuite({
  label: 'MemoryPanel (no records)',
  factory: () => new MemoryPanel(EMPTY_MEMORY_REGISTRY),
});

// ---------------------------------------------------------------------------
// Wave B1 — Populated-records contract (MemoryPanel)
// ---------------------------------------------------------------------------

const SAMPLE_MEMORY_RECORD = {
  id: 'mem_test1234',
  cls: 'fact' as const,
  summary: 'Use Bun runtime for all tests',
  detail: undefined,
  tags: ['runtime', 'arch'],
  scope: 'project' as const,
  reviewState: 'fresh' as const,
  confidence: 80,
  createdAt: Date.now() - 10000,
  updatedAt: Date.now() - 10000,
  provenance: [],
  staleReason: undefined,
  reviewedAt: undefined,
  reviewedBy: undefined,
};

const SAMPLE_MEMORY_RECORD_2 = {
  id: 'mem_test5678',
  cls: 'decision' as const,
  summary: 'Use SQLite for persistent storage',
  detail: undefined,
  tags: ['db'],
  scope: 'project' as const,
  reviewState: 'reviewed' as const,
  confidence: 90,
  createdAt: Date.now() - 20000,
  updatedAt: Date.now() - 5000,
  provenance: [],
  staleReason: undefined,
  reviewedAt: Date.now() - 5000,
  reviewedBy: 'operator',
};

describe('MemoryPanel — populated records', () => {
  const makeRegistry = () => ({
    search: (_opts?: unknown) => [SAMPLE_MEMORY_RECORD, SAMPLE_MEMORY_RECORD_2],
    subscribe: (_cb: () => void) => () => {},
    reviewQueue: (_limit: number) => [],
    review: (_id: string, _opts: unknown) => {},
  } as unknown as import('@pellux/goodvibes-sdk/platform/state').MemoryRegistry);

  test('render() returns exactly H lines with records', () => {
    const panel = new MemoryPanel(makeRegistry());
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
  });

  test('every rendered line has exactly W cells with records', () => {
    const panel = new MemoryPanel(makeRegistry());
    const lines = panel.render(W, H);
    for (const line of lines) {
      expect(line).toHaveLength(W);
    }
  });

  test('renderItem: selected row contains record summary substring', () => {
    const panel = new MemoryPanel(makeRegistry());
    const lines = panel.render(W, H);
    const rendered = lines.map((l) => l.map((c) => c.char).join('')).join('\n');
    expect(rendered).toContain('Use Bun runtime');
  });

  test('clampSelection: selectedIndex stays in bounds after render', () => {
    const panel = new MemoryPanel(makeRegistry());
    panel.render(W, H);
    const idx = (panel as unknown as { selectedIndex: number }).selectedIndex;
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(2);
  });
});
