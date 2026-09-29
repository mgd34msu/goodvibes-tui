/**
 * The ways into the modals that replaced the side panes, and the Agents
 * modal's stop rule: Esc backs out and never stops work; stopping is ctrl+x,
 * confirmed (ctrl+x again, Enter on Stop, or y).
 */

import { describe, expect, test } from 'bun:test';
import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import { SelectionManager } from '@pellux/goodvibes-terminal-shell';
import { AgentsModal, type FleetActionCallbacks } from '../../input/agents-modal.ts';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import { confirmThrough } from '../../input/confirm-dialog.ts';
import { resolveViewName } from '../../input/views.ts';
import { handleMouseToken, type MouseRouteState } from '../../input/handler-feed-routes.ts';
import { buildFleetSnapshot, createStaticFleetReadModel } from '../../panels/fleet-read-model.ts';
import { buildSteerMessage, parseReviewDiff } from '../../panels/diff-review-model.ts';
import { buildShellFooter } from '../../renderer/shell-surface.ts';
import { footerTargetRows, type FooterTarget } from '../../renderer/footer-targets.ts';

const NOW = 1_700_000_000_000;

function node(id: string, toolName: string): ProcessNode {
  return {
    id,
    kind: 'agent',
    label: `[Agent] ${id}`,
    task: id,
    state: 'executing-tool',
    startedAt: NOW - 60_000,
    elapsedMs: 60_000,
    usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1, toolCallCount: 1 },
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    costUsd: 0.01,
    costState: 'priced',
    currentActivity: { kind: 'tool', text: `Running ${toolName}`, toolName, at: NOW - 1_000 },
    capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: false },
  } as ProcessNode;
}

function agents(nodes: ProcessNode[]): { host: SurfaceModalHost; modal: AgentsModal; killed: string[] } {
  const host = new SurfaceModalHost();
  const killed: string[] = [];
  const actions: FleetActionCallbacks = {
    interrupt: () => true,
    resume: () => true,
    kill: (id) => { killed.push(id); return [id]; },
    getConversationSnapshot: () => [],
    resolveSessionLogPath: (id) => `/nonexistent/${id}.jsonl`,
    steer: () => ({ queued: false, reason: 'not steerable' }) as never,
  };
  const modal = new AgentsModal({
    readModel: createStaticFleetReadModel(buildFleetSnapshot(nodes, NOW)),
    actions,
    confirm: (options) => confirmThrough(host, options),
    requestRender: () => {},
    tickMs: 0,
  });
  host.push(modal);
  return { host, modal, killed };
}

const ctrlX: InputToken = { type: 'key', name: 'x', logicalName: 'x', ctrl: true, shift: false, meta: false } as InputToken;
const enter: InputToken = { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false } as InputToken;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('Agents modal: stopping asks first, and Esc never stops', () => {
  test('ctrl+x opens the stop confirm; ctrl+x again stops the agent', async () => {
    const { host, killed } = agents([node('agent-1', 'Bash')]);
    host.handleToken(ctrlX);
    expect(host.modals().map((m) => m.name)).toEqual(['agents', 'confirm']);
    expect(killed).toEqual([]);
    host.handleToken(ctrlX);
    await settle();
    expect(killed).toEqual(['agent-1']);
    expect(host.modals().map((m) => m.name)).toEqual(['agents']);
  });

  test('Enter on the confirm keeps the safe default (no stop); Esc backs out without stopping', async () => {
    const { host, killed } = agents([node('agent-1', 'Bash')]);
    host.handleToken(ctrlX);
    host.handleToken(enter);
    await settle();
    expect(killed).toEqual([]);
    host.handleToken(ctrlX);
    host.escape();
    await settle();
    expect(killed).toEqual([]);
    // Esc on the Agents modal itself closes it; the agent keeps running.
    host.escape();
    await settle();
    expect(host.active).toBe(false);
    expect(killed).toEqual([]);
  });
});

describe('Agents modal: deep-link targets', () => {
  test('a <tool>:tool target selects the process whose current step is that tool', () => {
    const { modal } = agents([node('agent-1', 'Bash'), node('agent-2', 'read_file')]);
    expect(modal.reveal({ id: 'read_file', kind: 'tool' })).toBe(true);
    expect(modal.selectedId).toBe('agent-2');
    expect(modal.status).toBeNull();
  });

  test('a tool nothing is running says so plainly (not "no longer running")', () => {
    const { modal } = agents([node('agent-1', 'Bash')]);
    expect(modal.reveal({ id: 'web_search', kind: 'tool' })).toBe(false);
    expect(modal.status?.text).toBe('Nothing is running web_search right now.');
  });

  test('an id:kind target selects that process', () => {
    const { modal } = agents([node('agent-1', 'Bash'), node('agent-2', 'Read')]);
    expect(modal.reveal({ id: 'agent-1', kind: 'agent' })).toBe(true);
    expect(modal.selectedId).toBe('agent-1');
  });
});

describe('old view names route to their modals', () => {
  const noRedirect = (): string | undefined => undefined;
  test('cost opens Usage on its Agents (per-agent cost) tab; tokens and context open Usage', () => {
    expect(resolveViewName('cost', noRedirect)).toEqual({ kind: 'usage', tab: 'agents' });
    expect(resolveViewName('tokens', noRedirect)).toEqual({ kind: 'usage' });
    expect(resolveViewName('context', noRedirect)).toEqual({ kind: 'usage' });
  });

  test('sessions opens the session picker without needing a registered redirect', () => {
    expect(resolveViewName('sessions', noRedirect)).toEqual({ kind: 'sessions' });
  });

  test('fleet and its old aliases open Agents; git/diff/review open Changes', () => {
    for (const name of ['fleet', 'cockpit', 'wrfc', 'tasks', 'ops']) expect(resolveViewName(name, noRedirect)).toEqual({ kind: 'agents' });
    expect(resolveViewName('git', noRedirect)).toEqual({ kind: 'changes', mode: 'git' });
    expect(resolveViewName('diff', noRedirect)).toEqual({ kind: 'changes' });
  });
});

describe('the status line opens Usage on a click', () => {
  const W = 120;
  function footer() {
    return buildShellFooter({
      width: W, promptText: '', promptLineCount: 1, usage: { up: 1_000, down: 200 }, showExitNotice: false, lastCopyTime: 0,
      contextWindow: 100_000, compactThreshold: 0.8, lastInputTokens: 50_000,
      runningAgentCount: 0, runningProcessCount: 0, indicatorFocused: false,
    }).lines;
  }

  test('the status line (context bar and cost) is the one clickable Usage row', () => {
    const lines = footer();
    const start = 40 - lines.length;
    const rows = footerTargetRows(lines, start);
    expect([...rows.entries()]).toEqual([[39, 'usage']]);
    expect(lines[39 - start]!.map((c) => c.char).join('')).toContain('context');
  });

  function mouseState(targets: ReadonlyMap<number, FooterTarget>, opened: FooterTarget[], mouseDownRow = -1): MouseRouteState {
    return {
      conversationManager: null,
      selection: new SelectionManager(),
      mouseDownRow,
      mouseDownCol: -1,
      scrollTop: 0,
      viewportHeight: 30,
      lineCount: 0,
      scroll: () => {},
      requestRender: () => {},
      handlePaste: () => {},
      handleCopy: () => {},
      footerTargetAt: (row) => targets.get(row),
      openFooterTarget: (target) => { opened.push(target); },
    };
  }

  test('press and release on a usage row opens Usage; nothing opens on a drag onto it', () => {
    const targets = new Map<number, FooterTarget>([[36, 'usage']]);
    const opened: FooterTarget[] = [];
    const press = handleMouseToken(mouseState(targets, opened), { type: 'mouse', button: 0, col: 10, row: 36, action: 'press' } as InputToken);
    expect(press.handled).toBe(true);
    expect(opened).toEqual([]);
    const release = handleMouseToken(mouseState(targets, opened, press.mouseDownRow), { type: 'mouse', button: 0, col: 10, row: 36, action: 'release' } as InputToken);
    expect(release.handled).toBe(true);
    expect(opened).toEqual(['usage']);

    // A selection dragged from the conversation that ends on the row opens nothing.
    const dragged: FooterTarget[] = [];
    handleMouseToken(mouseState(targets, dragged, 5), { type: 'mouse', button: 0, col: 10, row: 36, action: 'release' } as InputToken);
    expect(dragged).toEqual([]);
  });
});

describe('Changes review comments carry the semantic summary', () => {
  const DIFF = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@',
    ' const x = 1;',
    '-const y = 2;',
    '+const y = 3;',
    '',
  ].join('\n');

  test('a known summary for the commented file is included; an unknown one is not', () => {
    const hunk = parseReviewDiff(DIFF)[0]!.hunks[0]!;
    const withSummary = buildSteerMessage([{ hunk, comment: 'why 3?' }], 'this session', new Map([[hunk.filePath, '1 semantic change: ~  const  y']]));
    expect(withSummary).toContain("Structure of this file's change: 1 semantic change: ~  const  y");
    const without = buildSteerMessage([{ hunk, comment: 'why 3?' }], 'this session');
    expect(without).not.toContain('Structure of this file');
    expect(without).toContain('why 3?');
  });
});
