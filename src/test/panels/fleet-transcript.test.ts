// ---------------------------------------------------------------------------
// fleet-transcript.test.ts
// Pure rendering functions for a FleetPanel session
// tab's content: the live/frozen agent transcript, the wrfc-chain member
// summary, and the on-disk ledger fallback for an evicted/never-registered
// conversation snapshot. Isolated from FleetPanel/keyboard input — see
// fleet-panel.test.ts for the integration-level "attach a tab and render it"
// coverage.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import {
  parseAgentLedger,
  renderFleetAgentTranscript,
  renderFleetChainSummary,
  renderFleetLedgerFallback,
} from '../../panels/fleet-transcript.ts';
import { MessageLineCache } from '../../core/conversation-line-cache.ts';
import { linesToText } from '../setup.ts';
import type { FleetTreeRow } from '../../panels/fleet-read-model.ts';

const LEDGER_FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'agent-ledger-sample.jsonl');

describe('renderFleetAgentTranscript', () => {
  test("a non-empty snapshot on a RUNNING agent renders content and reports mode 'live'", () => {
    const result = renderFleetAgentTranscript(
      [{ role: 'user', content: 'hello live' }],
      /* isTerminal */ false,
      new MessageLineCache(),
      80,
      20,
      null,
    );
    expect(result.mode).toBe('live');
    expect(linesToText(result.lines).some((l) => l.includes('hello live'))).toBe(true);
  });

  test("a non-empty snapshot on a TERMINAL agent renders the SAME content but reports mode 'frozen'", () => {
    const result = renderFleetAgentTranscript(
      [{ role: 'user', content: 'hello frozen' }],
      /* isTerminal */ true,
      new MessageLineCache(),
      80,
      20,
      null,
    );
    expect(result.mode).toBe('frozen');
    expect(linesToText(result.lines).some((l) => l.includes('hello frozen'))).toBe(true);
  });

  test("a 'frozen' transcript carries an honest read-only notice (design point 4) that a 'live' one does not", () => {
    const frozen = renderFleetAgentTranscript(
      [{ role: 'user', content: 'done agent content' }],
      /* isTerminal */ true,
      new MessageLineCache(),
      80,
      20,
      null,
    );
    expect(linesToText(frozen.lines).some((l) => l.includes('Read-only'))).toBe(true);
    expect(linesToText(frozen.lines).some((l) => l.includes('not a live view'))).toBe(true);

    const live = renderFleetAgentTranscript(
      [{ role: 'user', content: 'running agent content' }],
      /* isTerminal */ false,
      new MessageLineCache(),
      80,
      20,
      null,
    );
    expect(linesToText(live.lines).some((l) => l.includes('Read-only'))).toBe(false);
  });

  test("the frozen notice reserves its own row instead of pushing tail-window content out of a tight height budget", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, content: `message ${i}` }));
    const result = renderFleetAgentTranscript(messages, /* isTerminal */ true, new MessageLineCache(), 80, 5, null);
    expect(result.lines.length).toBeLessThanOrEqual(5);
    const text = linesToText(result.lines);
    expect(text.some((l) => l.includes('Read-only'))).toBe(true);
    // The most recent message is still visible alongside the notice.
    expect(text.some((l) => l.includes('message 39'))).toBe(true);
  });

  test('a height so tight the notice alone fills the budget still tail-slices the body to empty, instead of returning the full untrimmed history for the caller to head-clip', () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, content: `message ${i}` }));
    // The frozen notice renders as a single row at width 80 — a height of 1
    // leaves a budgetHeight of exactly 0 for the body.
    const result = renderFleetAgentTranscript(messages, /* isTerminal */ true, new MessageLineCache(), 80, 1, null);
    expect(result.lines).toHaveLength(1);
    const text = linesToText(result.lines);
    expect(text.some((l) => l.includes('Read-only'))).toBe(true);
    // No room for any history line — in particular NOT the oldest message,
    // which is what a full-history-then-head-clip bug would surface instead.
    expect(text.some((l) => l.includes('message 0'))).toBe(false);
  });

  test("an empty snapshot on a TERMINAL agent reports mode 'unavailable' with no lines (caller degrades to the ledger fallback)", () => {
    const result = renderFleetAgentTranscript([], true, new MessageLineCache(), 80, 20, null);
    expect(result.mode).toBe('unavailable');
    expect(result.lines).toHaveLength(0);
  });

  test("an empty snapshot on a RUNNING agent (no turn yet) reports mode 'live' with an honest placeholder, not 'unavailable'", () => {
    const result = renderFleetAgentTranscript([], false, new MessageLineCache(), 80, 20, null);
    expect(result.mode).toBe('live');
    expect(linesToText(result.lines).some((l) => l.includes('no messages yet'))).toBe(true);
  });

  test('rendering tail-windows to the requested height for a long conversation', () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, content: `message ${i}` }));
    const result = renderFleetAgentTranscript(messages, false, new MessageLineCache(), 80, 5, null);
    expect(result.lines.length).toBeLessThanOrEqual(5);
    // Tail window: the most RECENT message should be visible, not the oldest.
    expect(linesToText(result.lines).some((l) => l.includes('message 39'))).toBe(true);
  });

  test('a per-tab MessageLineCache accumulates entries across renders of the same snapshot (memoisation, not just a stateless render)', () => {
    const cache = new MessageLineCache();
    const messages = [{ role: 'user' as const, content: 'one' }, { role: 'user' as const, content: 'two' }];
    renderFleetAgentTranscript(messages, false, cache, 80, 20, null);
    expect(cache.size).toBeGreaterThan(0);
  });
});

describe('renderFleetChainSummary', () => {
  function makeMemberRow(id: string, label: string, state: ProcessNode['state']): FleetTreeRow {
    const node: ProcessNode = {
      id,
      kind: 'agent',
      parentId: 'chain-1',
      label,
      state,
      elapsedMs: 1_000,
      costState: 'unpriced',
      capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: false },
    };
    return { node, depth: 1, treePrefix: '', isLastChild: true, hasChildren: false };
  }

  test('renders one line per member row with its label and state', () => {
    const rows = [makeMemberRow('m1', 'Engineer', 'streaming'), makeMemberRow('m2', 'Reviewer', 'awaiting-approval')];
    const lines = linesToText(renderFleetChainSummary(rows, 80, false));
    expect(lines.some((l) => l.includes('Engineer') && l.includes('streaming'))).toBe(true);
    expect(lines.some((l) => l.includes('Reviewer') && l.includes('awaiting-approval'))).toBe(true);
  });

  test('d3: an empty member list on a LIVE chain reads "not started yet"', () => {
    const lines = linesToText(renderFleetChainSummary([], 80, false));
    expect(lines.some((l) => l.includes('no member agents yet'))).toBe(true);
    expect(lines.some((l) => l.includes('chain completed'))).toBe(false);
  });

  test('d3: an empty member list on a completed/pruned chain reads "chain completed", not "yet"', () => {
    // A completed chain prunes its wrapper node, so zero members means finished,
    // not not-started — the honest wording must not say "yet".
    const lines = linesToText(renderFleetChainSummary([], 80, true));
    expect(lines.some((l) => l.includes('chain completed — members no longer tracked'))).toBe(true);
    expect(lines.some((l) => l.includes('yet'))).toBe(false);
  });
});

describe('parseAgentLedger', () => {
  test('parses one JSON object per line', () => {
    const raw = '{"type":"meta","model":"m"}\n{"type":"session_end","status":"completed"}\n';
    const entries = parseAgentLedger(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]!['type']).toBe('meta');
    expect(entries[1]!['status']).toBe('completed');
  });

  test('tolerates malformed lines by skipping them rather than throwing', () => {
    const raw = '{"type":"meta"}\nnot json at all\n{"type":"session_end"}\n\n';
    const entries = parseAgentLedger(raw);
    expect(entries).toHaveLength(2);
  });

  test('empty input yields an empty array', () => {
    expect(parseAgentLedger('')).toEqual([]);
  });
});

describe('renderFleetLedgerFallback', () => {
  test('always frames the view as a degraded activity log, never a transcript replay', () => {
    const lines = linesToText(renderFleetLedgerFallback([{ type: 'meta', model: 'x', provider: 'y' }], 80, 20));
    expect(lines.some((l) => l.includes('Full transcript unavailable'))).toBe(true);
  });

  test('renders a recognizable line per known ledger entry type', () => {
    const entries = [
      { type: 'meta', model: 'claude-x', provider: 'anthropic' },
      { type: 'tool_execution', toolName: 'Read', success: true },
      { type: 'tool_execution', toolName: 'Write', success: false },
      { type: 'session_end', status: 'completed', durationMs: 5_000 },
    ];
    const lines = linesToText(renderFleetLedgerFallback(entries, 80, 20));
    expect(lines.some((l) => l.includes('claude-x'))).toBe(true);
    expect(lines.some((l) => l.includes('Read'))).toBe(true);
    expect(lines.some((l) => l.includes('Write') && l.includes('failed'))).toBe(true);
    expect(lines.some((l) => l.includes('completed'))).toBe(true);
  });

  test('an empty entry list still renders the notice plus an honest "no activity" line', () => {
    const lines = linesToText(renderFleetLedgerFallback([], 80, 20));
    expect(lines.some((l) => l.includes('no activity recorded'))).toBe(true);
  });

  // Per-turn knowledge injection ledger entries.
  // Before this case existed, these fell through to the generic 'event'
  // default (just the bare type name), giving no honest signal at all.
  describe('knowledge_injection entries', () => {
    test('a populated injection renders the turn, injected count, and token cost', () => {
      const lines = linesToText(renderFleetLedgerFallback([
        { type: 'knowledge_injection', turn: 3, injectedIds: ['mem-1', 'mem-2'], tokenCost: 340, embeddingBackend: 'available' },
      ], 80, 20));
      expect(lines.some((l) => l.includes('turn 3'))).toBe(true);
      expect(lines.some((l) => l.includes('injected 2'))).toBe(true);
      expect(lines.some((l) => l.includes('340'))).toBe(true);
    });

    test('an empty injection (nothing cleared the relevance floor) renders the honest reason, not a fabricated count', () => {
      const lines = linesToText(renderFleetLedgerFallback([
        { type: 'knowledge_injection', turn: 4, injectedIds: [], reason: 'no records cleared relevance floor', embeddingBackend: 'available' },
      ], 80, 20));
      expect(lines.some((l) => l.includes('turn 4'))).toBe(true);
      expect(lines.some((l) => l.includes('nothing injected'))).toBe(true);
      expect(lines.some((l) => l.includes('no records cleared relevance floor'))).toBe(true);
    });

    test('fallback-lexical embedding backend is tagged on the rendered line', () => {
      const lines = linesToText(renderFleetLedgerFallback([
        { type: 'knowledge_injection', turn: 1, injectedIds: ['mem-1'], tokenCost: 50, embeddingBackend: 'fallback-lexical' },
      ], 80, 20));
      expect(lines.some((l) => l.includes('lexical fallback'))).toBe(true);
    });

    test('flag-off proxy: a ledger with no knowledge_injection entries at all renders nothing injection-related', () => {
      const lines = linesToText(renderFleetLedgerFallback([
        { type: 'meta', model: 'claude-x', provider: 'anthropic' },
        { type: 'session_end', status: 'completed' },
      ], 80, 20));
      expect(lines.some((l) => l.toLowerCase().includes('inject'))).toBe(false);
    });
  });

  test('tail-windows to height for a long ledger', () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ type: 'llm_request', turn: i }));
    const lines = renderFleetLedgerFallback(entries, 80, 5);
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  test('a long ledger that overflows a small tab height still shows the degraded-view notice as the FIRST line, not just the raw activity tail (the notice must never be the thing that scrolls off)', () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ type: 'llm_request', turn: i }));
    const lines = linesToText(renderFleetLedgerFallback(entries, 80, 5));
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines[0]).toContain('Read-only');
    expect(lines[0]).toContain('Full transcript unavailable');
    // The most recent entry is still visible below the reserved notice.
    expect(lines.some((l) => l.includes('turn 29'))).toBe(true);
  });

  test('shows a truncated result preview for a successful tool_execution row ("genuinely useful", not just a name)', () => {
    const lines = linesToText(renderFleetLedgerFallback(
      [{ type: 'tool_execution', toolName: 'Read', success: true, resultPreview: 'line one\nline two of file content' }],
      80,
      20,
    ));
    expect(lines.some((l) => l.includes('Read') && l.includes('line one'))).toBe(true);
  });

  test('a tool_execution row with no resultPreview still renders (older/degraded entries do not crash)', () => {
    const lines = linesToText(renderFleetLedgerFallback([{ type: 'tool_execution', toolName: 'Read', success: true }], 80, 20));
    expect(lines.some((l) => l.includes('Read'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// — a real fixture matching the SDK writer's exact message vocabulary
// (goodvibes-sdk packages/sdk/src/platform/agents/session.ts's `meta` message
// and orchestrator-runner.ts's session_config/llm_request/llm_response/
// tool_execution/session_end messages — see this test's fixture file for the
// exact field names each type carries). Exercises parseAgentLedger +
// renderFleetLedgerFallback end-to-end against on-disk content rather than
// only hand-built entry objects, so a real drift between the writer's shape
// and this reader's assumptions would show up here.
// ---------------------------------------------------------------------------

describe('ledger fallback — real fixture (writer-shape regression)', () => {
  test('parses every line of a realistic multi-turn agent ledger', () => {
    const raw = readFileSync(LEDGER_FIXTURE_PATH, 'utf-8');
    const entries = parseAgentLedger(raw);
    expect(entries).toHaveLength(9);
    expect(entries[0]!['type']).toBe('meta');
    expect(entries.at(-1)!['type']).toBe('session_end');
  });

  test('renders an honest, information-dense activity log from the fixture: model, task, tool previews, and the final outcome', () => {
    const raw = readFileSync(LEDGER_FIXTURE_PATH, 'utf-8');
    const entries = parseAgentLedger(raw);
    const lines = linesToText(renderFleetLedgerFallback(entries, 100, 30));
    const text = lines.join('\n');

    // Read-only / not-a-transcript framing (design point 4).
    expect(text).toContain('Read-only');
    expect(text).toContain('Full transcript unavailable');

    // meta — model/provider.
    expect(text).toContain('claude-sonnet-5');
    expect(text).toContain('anthropic');

    // session_config — the task.
    expect(text).toContain('Fix the flaky retry test');

    // llm_request/llm_response — per-turn counts (request/response accounting).
    expect(text).toContain('turn 1');
    expect(text).toContain('turn 2');

    // tool_execution — success WITH preview, and failure WITH preview + "(failed)".
    expect(text).toContain('Read');
    expect(text).toContain("import { retry }");
    expect(text).toContain('Edit (failed)');
    expect(text).toContain('old_string not found');

    // session_end — honest final status + timing, not fabricated.
    expect(text).toContain('failed');
    expect(text).toMatch(/\d+(\.\d+)?s/); // formatElapsed(2700ms) renders a seconds-based duration
  });
});
