import { describe, test, expect } from 'bun:test';
import { KnowledgeGraphPanel } from '../../../panels/knowledge-graph-panel.ts';
import { runBasePanelContractSuite, EMPTY_KNOWLEDGE_API, W, H } from './_shared.ts';

// WO-123: KnowledgeGraphPanel now requires an injected KnowledgeApi (no more
// static GRAPH_COMMANDS/MEMORY_COMMANDS catalogue).
runBasePanelContractSuite({
  label: 'KnowledgeGraphPanel (empty graph)',
  factory: () => new KnowledgeGraphPanel(EMPTY_KNOWLEDGE_API),
});

// ---------------------------------------------------------------------------
// WO-123 — Populated graph + review-queue contract
// ---------------------------------------------------------------------------

const SAMPLE_NODE = {
  id: 'node_alpha',
  kind: 'topic' as const,
  slug: 'alpha',
  title: 'Alpha subsystem',
  summary: 'Core alpha subsystem notes',
  aliases: [],
  status: 'active' as const,
  confidence: 80,
  metadata: {},
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const SAMPLE_SOURCE = {
  id: 'source_beta',
  connectorId: 'url',
  sourceType: 'url' as const,
  title: 'Beta reference doc',
  canonicalUri: 'https://example.test/beta',
  summary: 'Reference documentation for beta',
  tags: [],
  status: 'indexed' as const,
  metadata: {},
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const SAMPLE_ISSUE = {
  id: 'issue_gamma',
  severity: 'warning' as const,
  code: 'stale-source',
  message: 'Source has not been recrawled in 90 days',
  status: 'open' as const,
  metadata: {},
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function makeApi(overrides: { reviewCalls?: Array<{ issueId: string; action: string }> } = {}) {
  const reviewCalls = overrides.reviewCalls ?? [];
  return {
    sources: { list: (_limit?: number) => [SAMPLE_SOURCE] },
    graph: {
      nodes: { list: (_limit?: number) => [SAMPLE_NODE] },
      issues: {
        list: (_limit?: number) => [SAMPLE_ISSUE],
        review: async (input: { issueId: string; action: string }) => {
          reviewCalls.push(input);
          return {
            ok: true as const,
            issue: { ...SAMPLE_ISSUE, status: 'resolved' as const },
          };
        },
      },
      items: {
        search: (_query: string, _limit?: number) => [
          { kind: 'source' as const, id: SAMPLE_SOURCE.id, score: 1, reason: 'title match', source: SAMPLE_SOURCE },
        ],
      },
    },
    jobs: {
      schedules: {
        list: (_limit?: number) => [
          { id: 'sched_1', jobId: 'knowledge-light-consolidation', label: 'Nightly consolidation', enabled: true, schedule: {}, metadata: {}, createdAt: Date.now(), updatedAt: Date.now() },
        ],
      },
    },
  } as unknown as import('@pellux/goodvibes-sdk/platform/knowledge').KnowledgeApi;
}

describe('KnowledgeGraphPanel — populated graph (browse mode)', () => {
  test('render() returns exactly H lines with data', () => {
    const panel = new KnowledgeGraphPanel(makeApi());
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
  });

  test('every rendered line has exactly W cells with data', () => {
    const panel = new KnowledgeGraphPanel(makeApi());
    const lines = panel.render(W, H);
    for (const line of lines) {
      expect(line).toHaveLength(W);
    }
  });

  test('header shows real source/node/issue counts, not a command catalogue', () => {
    const panel = new KnowledgeGraphPanel(makeApi());
    const lines = panel.render(W, H);
    const rendered = lines.map((l) => l.map((c) => c.char).join('')).join('\n');
    expect(rendered).toContain('sources');
    expect(rendered).toContain('nodes');
    expect(rendered).not.toContain('/knowledge status');
    expect(rendered).not.toContain('/recall add');
  });

  test('Tab switches to Review Queue mode', () => {
    const panel = new KnowledgeGraphPanel(makeApi());
    panel.render(W, H);
    panel.handleInput('tab');
    const lines = panel.render(W, H);
    const rendered = lines.map((l) => l.map((c) => c.char).join('')).join('\n');
    expect(rendered).toContain('Review Queue');
    expect(rendered).toContain(SAMPLE_ISSUE.code);
  });

  test('M opens the memory panel via the injected callback', () => {
    let opened = false;
    const panel = new KnowledgeGraphPanel(makeApi(), () => { opened = true; });
    panel.render(W, H);
    panel.handleInput('m');
    expect(opened).toBe(true);
  });
});

describe('KnowledgeGraphPanel — review queue actions (ConfirmState-gated)', () => {
  test('accept action requires confirmation before mutating', async () => {
    const reviewCalls: Array<{ issueId: string; action: string }> = [];
    const panel = new KnowledgeGraphPanel(makeApi({ reviewCalls }));
    panel.render(W, H);
    panel.handleInput('tab'); // enter review mode
    panel.render(W, H);

    panel.handleInput('a'); // stage accept — should NOT mutate yet
    expect(reviewCalls).toHaveLength(0);
    const confirmLines = panel.render(W, H);
    const confirmText = confirmLines.map((l) => l.map((c) => c.char).join('')).join('\n');
    expect(confirmText).toContain('Accept');

    panel.handleInput('y'); // confirm
    await Promise.resolve();
    await Promise.resolve();
    expect(reviewCalls).toHaveLength(1);
    expect(reviewCalls[0]?.action).toBe('accept');
  });

  test('cancelling a confirm (n) does not mutate', () => {
    const reviewCalls: Array<{ issueId: string; action: string }> = [];
    const panel = new KnowledgeGraphPanel(makeApi({ reviewCalls }));
    panel.render(W, H);
    panel.handleInput('tab');
    panel.render(W, H);

    panel.handleInput('x'); // stage reject
    panel.handleInput('n'); // cancel
    expect(reviewCalls).toHaveLength(0);
  });
});
