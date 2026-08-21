// ---------------------------------------------------------------------------
// fleet-spawn.test.ts, the Fleet panel's ACP spawn affordance round-trips
// against a mocked daemon, never typing a path:
//   • begin lists discovered agents (acp.agents.list); none => a quiet, honest
//     absence, no picker entered.
//   • pick an agent, then a known directory (the current dir + registered
//     workspaces, no free-text retyping), then acp.sessions.create hosts it.
//   • a structured failure ({binary, stage, message}) renders verbatim, never a
//     hung row; the created row classifies attention like any other kind.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import {
  FleetSpawn,
  type AcpSpawnGateway,
  type AcpSpawnGatewayResolution,
  type AcpDiscoveredAgent,
  type AcpSpawnResult,
  type AcpWorkspaceRegistration,
} from '../../panels/fleet-spawn.ts';
import { fleetKindTag, fleetNodeAttention } from '../../panels/fleet-read-model.ts';
import { isAttachableFleetKind } from '../../panels/fleet-tabs.ts';

// ── fixtures ────────────────────────────────────────────────────────────────

function agent(id: string, binaryPath: string): AcpDiscoveredAgent {
  return { id, title: id === 'claude-code' ? 'Claude Code' : id, binaryPath, args: ['acp'] };
}

function workspace(root: string, label?: string): AcpWorkspaceRegistration {
  return { root, registeredAt: '2026-07-13T00:00:00Z', ...(label ? { label } : {}) };
}

function spawnResult(overrides: Partial<AcpSpawnResult['hosted']> = {}, started = true): AcpSpawnResult {
  return {
    hosted: {
      id: 'h-1', agentId: 'claude-code', title: 'Claude Code', binaryPath: '/usr/bin/claude-code-acp',
      cwd: '/work/app', state: 'starting', startedAt: 1, promptCount: 0, ...overrides,
    },
    started,
  };
}

interface Log {
  createInputs: Array<{ agentId: string; cwd: string }>;
  listAgents: number;
  listWorkspaces: number;
}

function mockSpawn(opts: {
  agents?: readonly AcpDiscoveredAgent[];
  workspaces?: readonly AcpWorkspaceRegistration[];
  createResult?: AcpSpawnResult;
  createThrows?: boolean;
  unavailable?: string;
  currentDir?: string;
} = {}): { spawn: FleetSpawn; notes: string[]; log: Log } {
  const notes: string[] = [];
  const log: Log = { createInputs: [], listAgents: 0, listWorkspaces: 0 };
  const gateway: AcpSpawnGateway = {
    listAgents: async () => { log.listAgents++; return opts.agents ?? []; },
    listWorkspaces: async () => { log.listWorkspaces++; return opts.workspaces ?? []; },
    createSession: async (input) => {
      log.createInputs.push(input);
      if (opts.createThrows) throw new Error('daemon exploded');
      return opts.createResult ?? spawnResult();
    },
  };
  const resolution: AcpSpawnGatewayResolution = opts.unavailable
    ? { available: false, reason: opts.unavailable }
    : { available: true, gateway };
  const spawn = new FleetSpawn({
    resolveGateway: () => resolution,
    currentDirectory: () => opts.currentDir ?? '/work/app',
    notify: (m) => notes.push(m),
    markDirty: () => {},
  });
  return { spawn, notes, log };
}

/** Flatten a rendered picker to text for content assertions. */
function renderText(spawn: FleetSpawn): string {
  return spawn.renderSpawnMode(80, 24).map((line) => line.map((c) => (c.char === '' ? ' ' : c.char)).join('')).join('\n');
}

/** Drain the microtask + timer queue so a fire-and-forget async advance settles. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── begin / discovery ─────────────────────────────────────────────────────────

describe('FleetSpawn: discovery', () => {
  test('no discovered agents => a quiet honest absence, no picker entered', async () => {
    const { spawn, notes } = mockSpawn({ agents: [] });
    await spawn.begin();
    expect(spawn.spawnModeActive()).toBe(false);
    expect(notes.join(' ')).toContain('No third-party ACP agents discovered');
  });

  test('a gateway that is unavailable refuses with its honest reason', async () => {
    const { spawn, notes } = mockSpawn({ unavailable: 'the daemon is disabled' });
    await spawn.begin();
    expect(spawn.spawnModeActive()).toBe(false);
    expect(notes.join(' ')).toContain('the daemon is disabled');
  });

  test('discovered agents enter the picker and render their titles + binaries', async () => {
    const { spawn } = mockSpawn({ agents: [agent('claude-code', '/usr/bin/claude-code-acp'), agent('opencode', '/usr/bin/opencode')] });
    await spawn.begin();
    expect(spawn.spawnModeActive()).toBe(true);
    const text = renderText(spawn);
    expect(text).toContain('Claude Code');
    expect(text).toContain('/usr/bin/claude-code-acp');
    expect(text).toContain('opencode');
  });
});

// ── pick agent -> pick dir -> create ────────────────────────────────────────────

describe('FleetSpawn: pick a known directory, then host', () => {
  test('the current dir leads and is labeled; registered workspaces follow, deduped', async () => {
    const { spawn } = mockSpawn({
      agents: [agent('claude-code', '/usr/bin/claude-code-acp')],
      workspaces: [workspace('/work/app', 'app'), workspace('/work/lib', 'lib')],
      currentDir: '/work/app',
    });
    await spawn.begin();
    spawn.handleSpawnInput('enter'); // pick the agent -> dir step
    await flush();
    const text = renderText(spawn);
    expect(text).toContain('current directory');
    expect(text).toContain('/work/app');
    // The current dir is offered once (not duplicated by the same registered root).
    expect(text.match(/\/work\/app/g)?.length).toBe(1);
    expect(text).toContain('lib');
    expect(text).toContain('/work/lib');
  });

  test('hosting sends acp.sessions.create with the picked agent + dir; no path typed', async () => {
    const { spawn, notes, log } = mockSpawn({
      agents: [agent('claude-code', '/usr/bin/claude-code-acp')],
      workspaces: [workspace('/work/lib', 'lib')],
      currentDir: '/work/app',
    });
    await spawn.begin();
    spawn.handleSpawnInput('enter'); // agent -> dir step
    await flush();
    spawn.handleSpawnInput('down');  // move to /work/lib
    spawn.handleSpawnInput('enter'); // host here
    await flush();
    expect(log.createInputs).toEqual([{ agentId: 'claude-code', cwd: '/work/lib' }]);
    expect(notes.join(' ')).toContain('Hosting Claude Code in /work/lib');
    expect(spawn.spawnModeActive()).toBe(false); // picker closes; the row appears via the read-model
  });
});

// ── failure paths ──────────────────────────────────────────────────────────────

describe('FleetSpawn: honest failures, never a hung row', () => {
  test('a structured spawn failure renders its {binary, stage, message} verbatim', async () => {
    const failure = spawnResult({ state: 'failed', error: { binary: '/usr/bin/claude-code-acp', stage: 'initialize', message: 'handshake timed out' } }, false);
    const { spawn, notes } = mockSpawn({ agents: [agent('claude-code', '/usr/bin/claude-code-acp')], createResult: failure });
    await spawn.begin();
    spawn.handleSpawnInput('enter'); // agent -> dir
    await flush();
    spawn.handleSpawnInput('enter'); // host in current dir
    await flush();
    const msg = notes.join(' ');
    expect(msg).toContain('initialize stage failed');
    expect(msg).toContain('/usr/bin/claude-code-acp');
    expect(msg).toContain('handshake timed out');
    expect(spawn.spawnModeActive()).toBe(false); // never a hung picker
  });

  test('a thrown create surfaces the error and closes the picker', async () => {
    const { spawn, notes } = mockSpawn({ agents: [agent('opencode', '/usr/bin/opencode')], createThrows: true });
    await spawn.begin();
    spawn.handleSpawnInput('enter');
    await flush();
    spawn.handleSpawnInput('enter');
    await flush();
    expect(notes.join(' ')).toContain('ACP session create failed');
    expect(spawn.spawnModeActive()).toBe(false);
  });

  test('Esc cancels the picker at any step', async () => {
    const { spawn, log } = mockSpawn({ agents: [agent('opencode', '/usr/bin/opencode')] });
    await spawn.begin();
    spawn.handleSpawnInput('escape');
    expect(spawn.spawnModeActive()).toBe(false);
    expect(log.createInputs).toEqual([]);
  });
});

// ── read-model: an acp-agent row behaves like any other kind ──────────────────

describe('acp-agent row: kind glyph/label + attention with no special-casing', () => {
  function acpNode(overrides: Partial<ProcessNode> = {}): ProcessNode {
    return {
      id: 'acp:h-1', kind: 'acp-agent', label: 'Claude Code', state: 'executing-tool',
      startedAt: 1, capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: true },
      ...overrides,
    } as ProcessNode;
  }

  test('the kind carries a glyph/label and is attachable (steer/attach work like any row)', () => {
    expect(fleetKindTag('acp-agent')).toBe('acp');
    expect(isAttachableFleetKind('acp-agent')).toBe(true);
  });

  test('attention rides on the SDK needsAttention projection; no acp-specific branch', () => {
    const waiting = acpNode({ state: 'awaiting-approval', needsAttention: { reason: 'approval' } });
    expect(fleetNodeAttention(waiting)).toEqual({ reason: 'approval' });
    const working = acpNode();
    expect(fleetNodeAttention(working)).toBeNull();
  });
});
