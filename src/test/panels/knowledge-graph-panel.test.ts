import { describe, expect, test } from 'bun:test';
import { KnowledgeGraphPanel } from '../../panels/knowledge-graph-panel.ts';
import type { Line } from '../../types/grid.ts';

// W6.1 (the purge): this file used to also cover IntelligencePanel
// (DELETE-disposition — no surviving human surface; its read model still
// backs the `/intelligence` CLI subcommands) alongside KnowledgeGraphPanel.
// Renamed from intelligence-knowledge-panels.test.ts now that only
// KnowledgeGraphPanel (MIGRATE-TO-MODAL, not yet converted) remains.

function linesText(lines: Line[]): string {
  return lines.map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd()).join('\n');
}

const W = 100;
const H = 26;

function makeKnowledgeApi(overrides: {
  sources?: unknown[];
  nodes?: unknown[];
  issues?: unknown[];
  schedules?: unknown[];
} = {}) {
  const sources = overrides.sources ?? [];
  const nodes = overrides.nodes ?? [];
  const issues = overrides.issues ?? [];
  const schedules = overrides.schedules ?? [];
  return {
    sources: { list: (_limit?: number) => sources },
    graph: {
      nodes: { list: (_limit?: number) => nodes },
      issues: {
        list: (_limit?: number) => issues,
        review: async (input: { issueId: string; action: string }) => ({
          ok: true as const,
          issue: { ...(issues.find((i) => (i as { id: string }).id === input.issueId) as object ?? {}), status: 'resolved' },
        }),
      },
      items: { search: (_query: string, _limit?: number) => [] },
    },
    jobs: { schedules: { list: (_limit?: number) => schedules } },
  } as unknown as import('@pellux/goodvibes-sdk/platform/knowledge').KnowledgeApi;
}

describe('KnowledgeGraphPanel', () => {
  test('empty graph: honest empty state with a single enabling command', () => {
    const panel = new KnowledgeGraphPanel(makeKnowledgeApi());
    const text = linesText(panel.render(W, H));
    expect(text).toContain('No ingested knowledge yet.');
    expect(text).toContain('/knowledge ingest-url');
    // Only one enabling command mention — no full command catalogue.
    expect(text).not.toContain('/recall add');
    expect(text).not.toContain('/knowledge packet');
  });

  test('ingested graph: live node/source/issue counts render, not a command list', () => {
    const panel = new KnowledgeGraphPanel(makeKnowledgeApi({
      sources: [{ id: 'src_1', connectorId: 'url', sourceType: 'url', title: 'Doc one', status: 'indexed', tags: [], metadata: {}, createdAt: 0, updatedAt: 0 }],
      nodes: [{ id: 'node_1', kind: 'topic', slug: 'n1', title: 'Node one', aliases: [], status: 'active', confidence: 70, metadata: {}, createdAt: 0, updatedAt: 0 }],
      issues: [{ id: 'issue_1', severity: 'error', code: 'broken-link', message: 'Link is dead', status: 'open', metadata: {}, createdAt: 0, updatedAt: 0 }],
    }));
    const text = linesText(panel.render(W, H));
    expect(text).toContain('sources');
    expect(text).toContain('Doc one');
    expect(text).not.toContain('/knowledge status');
  });

  test('Tab enters the review-queue mode and back', () => {
    const panel = new KnowledgeGraphPanel(makeKnowledgeApi({
      issues: [{ id: 'issue_1', severity: 'warning', code: 'stale-source', message: 'stale', status: 'open', metadata: {}, createdAt: 0, updatedAt: 0 }],
    }));
    panel.render(W, H);
    expect(panel.handleInput('tab')).toBe(true);
    const reviewText = linesText(panel.render(W, H));
    expect(reviewText).toContain('Review Queue');
    expect(reviewText).toContain('stale-source');
    expect(panel.handleInput('tab')).toBe(true);
    const browseText = linesText(panel.render(W, H));
    expect(browseText).toContain('Browse');
  });

  test('M opens the memory panel via the injected callback instead of a dead hint', () => {
    let opened = false;
    const panel = new KnowledgeGraphPanel(makeKnowledgeApi(), () => { opened = true; });
    panel.render(W, H);
    expect(panel.handleInput('M')).toBe(true);
    expect(opened).toBe(true);
  });

  test('review actions are ConfirmState-gated (y/n mirrors MemoryPanel)', () => {
    const panel = new KnowledgeGraphPanel(makeKnowledgeApi({
      issues: [{ id: 'issue_1', severity: 'warning', code: 'stale-source', message: 'stale', status: 'open', metadata: {}, createdAt: 0, updatedAt: 0 }],
    }));
    panel.render(W, H);
    panel.handleInput('tab');
    panel.render(W, H);
    expect(panel.handleInput('r')).toBe(true); // stage resolve
    const confirmText = linesText(panel.render(W, H));
    expect(confirmText).toContain('Resolve');
    expect(panel.handleInput('n')).toBe(true); // cancel — no crash, returns to review list
    const afterCancel = linesText(panel.render(W, H));
    expect(afterCancel).toContain('Review Queue');
  });
});
