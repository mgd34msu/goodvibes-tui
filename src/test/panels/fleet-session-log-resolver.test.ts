// ---------------------------------------------------------------------------
// fleet-session-log-resolver.test.ts
//
//, proves the REAL `resolveSessionLogPath` wiring (not a test stub):
// src/panels/builtin/operations.ts wires FleetPanel's `resolveSessionLogPath`
// action to `ui.environment.shellPaths.resolveProjectPath('tui', 'sessions',
// \`${agentId}.jsonl\`)`, which per the brief's anchors must land on the
// exact path goodvibes-sdk's `AgentSession` writes to:
// `<workingDirectory>/.goodvibes/tui/sessions/<agentId>.jsonl`
// (see goodvibes-sdk packages/sdk/src/platform/agents/session.ts:56 and
// orchestrator-runner.ts:454, which resolve through the SDK's
// resolveScopedDirectory + surfaceRoot:'tui' to the same place).
//
// Rather than re-testing operations.ts's full panel-registration wiring
// (which needs a whole ResolvedBuiltinPanelDeps), this test reproduces the
// EXACT one-line closure shape from operations.ts against a real
// ShellPathService and a scratch `.goodvibes` layout on disk, then drives it
// through FleetPanel's real ledger-fallback load path end to end, proving
// the resolver finds the right file, not just that the callback is wired.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import type { ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import { FleetPanel, type FleetActionCallbacks } from '../../panels/fleet-panel.ts';
import { buildFleetSnapshot, createStaticFleetReadModel } from '../../panels/fleet-read-model.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const NOW = 1_700_000_000_000;

function linesText(lines: Line[]): string {
  return lines.map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd()).join('\n');
}

function makeDoneAgentNode(id: string): ProcessNode {
  return {
    id,
    kind: 'agent',
    label: `[Agent] ${id}`,
    state: 'done',
    elapsedMs: 100_000,
    costState: 'unpriced',
    capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
  };
}

describe('resolveSessionLogPath: real ShellPathService wiring (operations.ts shape)', () => {
  test('resolves to <workingDirectory>/.goodvibes/tui/sessions/<agentId>.jsonl', () => {
    const workingDirectory = makeProjectTempDir('gv-fleet-resolver');
    try {
      const shellPaths = createShellPathService({ workingDirectory, homeDirectory: workingDirectory });
      // The EXACT expression from src/panels/builtin/operations.ts's FleetPanel
      // factory registration.
      const resolveSessionLogPath = (agentId: string) =>
        shellPaths.resolveProjectPath('tui', 'sessions', `${agentId}.jsonl`);

      expect(resolveSessionLogPath('agent-done-01')).toBe(
        join(workingDirectory, '.goodvibes', 'tui', 'sessions', 'agent-done-01.jsonl'),
      );
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  test('a scratch on-disk ledger at the resolved path is found and rendered by FleetPanel end to end (not just a path-string match)', async () => {
    const workingDirectory = makeProjectTempDir('gv-fleet-resolver-e2e');
    try {
      const shellPaths = createShellPathService({ workingDirectory, homeDirectory: workingDirectory });
      const agentId = 'agent-done-e2e';
      const resolveSessionLogPath = (agentId: string) =>
        shellPaths.resolveProjectPath('tui', 'sessions', `${agentId}.jsonl`);

      const sessionsDir = join(workingDirectory, '.goodvibes', 'tui', 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        join(sessionsDir, `${agentId}.jsonl`),
        [
          JSON.stringify({ type: 'meta', agentId, model: 'claude-sonnet-5', provider: 'anthropic', title: '', timestamp: NOW }),
          JSON.stringify({ type: 'session_end', status: 'completed', toolCallCount: 0, durationMs: 1_000, timestamp: new Date(NOW).toISOString() }),
        ].join('\n') + '\n',
        'utf-8',
      );

      const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeDoneAgentNode(agentId)], NOW));
      const actions: Partial<FleetActionCallbacks> = {
        getConversationSnapshot: () => [], // evicted/never-registered — forces the ledger fallback path
        resolveSessionLogPath,
      };
      const panel = new FleetPanel(readModel, actions);

      panel.handleInput('enter'); // attach the terminal agent's tab (read-only)
      let text = linesText(panel.render(100, 24));
      expect(text).toContain('Loading');

      // Let the real fs.readFile()-backed ledger load settle.
      await new Promise((resolve) => setTimeout(resolve, 20));

      text = linesText(panel.render(100, 24));
      expect(text).toContain('Full transcript unavailable'); // honest degraded-view framing
      expect(text).toContain('claude-sonnet-5'); // content actually came from the file at the resolved path
      expect(text).toContain('completed');
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  test('a missing file at the resolved path degrades to an empty (not thrown) ledger, matching agent-inspector-panel.ts\'s ENOENT convention', async () => {
    const workingDirectory = makeProjectTempDir('gv-fleet-resolver-missing');
    try {
      const shellPaths = createShellPathService({ workingDirectory, homeDirectory: workingDirectory });
      const agentId = 'agent-never-wrote-a-file';
      const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeDoneAgentNode(agentId)], NOW));
      const actions: Partial<FleetActionCallbacks> = {
        getConversationSnapshot: () => [],
        resolveSessionLogPath: (id: string) => shellPaths.resolveProjectPath('tui', 'sessions', `${id}.jsonl`),
      };
      const panel = new FleetPanel(readModel, actions);

      panel.handleInput('enter');
      panel.render(100, 24);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const text = linesText(panel.render(100, 24));

      expect(text).toContain('no activity recorded');
      expect(text).not.toContain('Error');
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });
});
