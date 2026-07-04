// ---------------------------------------------------------------------------
// fleet-transcript.test.ts
// Wave-3 (W3.1 Part C6) — pure rendering functions for a FleetPanel session
// tab's content: the live/frozen agent transcript, the wrfc-chain member
// summary, and the on-disk ledger fallback for an evicted/never-registered
// conversation snapshot. Isolated from FleetPanel/keyboard input — see
// fleet-panel.test.ts for the integration-level "attach a tab and render it"
// coverage.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
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
      capabilities: { interruptible: true, killable: true, pausable: false, steerable: false },
    };
    return { node, depth: 1, treePrefix: '', isLastChild: true, hasChildren: false };
  }

  test('renders one line per member row with its label and state', () => {
    const rows = [makeMemberRow('m1', 'Engineer', 'streaming'), makeMemberRow('m2', 'Reviewer', 'awaiting-approval')];
    const lines = linesToText(renderFleetChainSummary(rows, 80));
    expect(lines.some((l) => l.includes('Engineer') && l.includes('streaming'))).toBe(true);
    expect(lines.some((l) => l.includes('Reviewer') && l.includes('awaiting-approval'))).toBe(true);
  });

  test('an empty member list renders an honest placeholder instead of a blank tab', () => {
    const lines = linesToText(renderFleetChainSummary([], 80));
    expect(lines.some((l) => l.includes('no member agents yet'))).toBe(true);
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

  test('tail-windows to height for a long ledger', () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ type: 'llm_request', turn: i }));
    const lines = renderFleetLedgerFallback(entries, 80, 5);
    expect(lines.length).toBeLessThanOrEqual(5);
  });
});
