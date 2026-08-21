// ---------------------------------------------------------------------------
// fleet-observed-steer.test.ts, the drill-in steer composer for observed
// FOREIGN coding agents:
//   • a row with a live tmux channel opens a compose input on 's', and Enter
//     round-trips fleet.observed.steer against a mocked daemon carrying the
//     node id + the typed text (the daemon routes the send-keys server-side);
//   • a channel-less row opens NO input, its detail states the honest reason.
// Owner ruling: steer is drill-in only, and stop is never offered on an
// observed row.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import { FleetActs, type FleetDiffSurface } from '../../panels/fleet-acts.ts';
import { renderObservedDetailLines, type ObservedNode } from '../../panels/fleet-observed-render.ts';
import type { FleetGateway, FleetObservedSteerResult } from '../../panels/fleet-gateway.ts';
import { lineToString } from '../setup.ts';

function observedNode(steerKind: 'tmux' | 'none'): ObservedNode {
  return {
    id: 'observed:4242',
    kind: 'observed-external',
    label: 'claude (foreign)',
    state: 'streaming',
    elapsedMs: 1000,
    costState: 'unpriced',
    capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: true },
    observed: {
      externalKind: 'claude-code',
      pid: 4242,
      cwd: '/home/dev/project',
      liveness: { state: 'active', cpuSeconds: 3, detail: 'active: CPU advanced since the last scan' },
      steer: steerKind === 'tmux'
        ? { kind: 'tmux', paneId: '%90', tty: '/dev/pts/11' }
        : { kind: 'none', reason: 'no controlling tty; not inside tmux' },
      steerDrillInOnly: true,
    },
  } as unknown as ObservedNode;
}

function stubDiffSurface(): FleetDiffSurface {
  return { show: () => {}, armConfirm: () => {}, close: () => {} };
}

function makeActs(steerObserved: FleetGateway['steerObserved']) {
  const notes: string[] = [];
  const gateway = { steerObserved } as unknown as FleetGateway;
  const acts = new FleetActs({
    resolveGateway: () => ({ available: true, gateway }),
    diffSurface: stubDiffSurface(),
    notify: (m) => notes.push(m),
    markDirty: () => {},
    findNode: () => null,
  });
  return { acts, notes };
}

function typeText(acts: FleetActs, text: string): void {
  for (const ch of text) acts.handleObservedSteerInput(ch);
}

describe('observed-agent drill-in steer', () => {
  test('a tmux-channel row round-trips fleet.observed.steer with the node id + typed text', async () => {
    const calls: Array<{ id: string; text: string }> = [];
    const steerObserved: FleetGateway['steerObserved'] = async (input) => {
      calls.push(input);
      return { queued: true, messageId: 'm-1' } as FleetObservedSteerResult;
    };
    const { acts, notes } = makeActs(steerObserved);
    const node = observedNode('tmux');

    // 's' on the selected observed row opens the composer (drill-in).
    expect(acts.handleTreeKey('s', node as ProcessNode)).toBe(true);
    expect(acts.observedSteerActive()).toBe(true);

    typeText(acts, 'run the tests');
    expect(acts.observedSteerDraftFor(node.id)).toBe('run the tests');

    // Enter submits; the composer closes immediately.
    acts.handleObservedSteerInput('return');
    expect(acts.observedSteerActive()).toBe(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([{ id: 'observed:4242', text: 'run the tests' }]);
    expect(notes.some((n) => /delivered to the foreign session/i.test(n))).toBe(true);
  });

  test('Esc cancels the composer without sending', async () => {
    const calls: Array<{ id: string; text: string }> = [];
    const { acts } = makeActs(async (input) => { calls.push(input); return { queued: true, messageId: 'x' } as FleetObservedSteerResult; });
    const node = observedNode('tmux');
    acts.handleTreeKey('s', node as ProcessNode);
    typeText(acts, 'abc');
    acts.handleObservedSteerInput('escape');
    expect(acts.observedSteerActive()).toBe(false);
    await Promise.resolve();
    expect(calls).toEqual([]);
  });

  test('a channel-less row opens NO input and states the honest reason', () => {
    const { acts, notes } = makeActs(async () => ({ queued: false, reason: 'no channel' }) as FleetObservedSteerResult);
    const node = observedNode('none');
    expect(acts.handleTreeKey('s', node as ProcessNode)).toBe(true);
    expect(acts.observedSteerActive()).toBe(false); // no composer opened
    expect(notes.some((n) => /Cannot steer/i.test(n) && /no controlling tty/i.test(n))).toBe(true);
  });

  test('a refused send surfaces the honest reason', async () => {
    const { acts, notes } = makeActs(async () => ({ queued: false, reason: 'the pane went away' }) as FleetObservedSteerResult);
    const node = observedNode('tmux');
    acts.handleTreeKey('s', node as ProcessNode);
    typeText(acts, 'hi');
    acts.handleObservedSteerInput('return');
    await Promise.resolve();
    await Promise.resolve();
    expect(notes.some((n) => /refused/i.test(n) && /pane went away/i.test(n))).toBe(true);
  });

  test('detail render: no-channel row shows the reason and NO compose input', () => {
    const text = renderObservedDetailLines(observedNode('none'), 80).map(lineToString).join('\n');
    expect(text).toContain('unavailable: no controlling tty');
    expect(text).not.toContain('send');
    expect(text).not.toContain('s: steer'); // no channel ⇒ no steer affordance at all
  });

  test('detail render: an open draft on a tmux row renders the compose input line', () => {
    const text = renderObservedDetailLines(observedNode('tmux'), 80, undefined, 'restart the build').map(lineToString).join('\n');
    expect(text).toContain('restart the build');
    expect(text).toContain('Enter: send');
  });

  test('detail render: a tmux row with no open draft shows the discoverability hint', () => {
    const text = renderObservedDetailLines(observedNode('tmux'), 80).map(lineToString).join('\n');
    expect(text).toContain('s: steer this session');
  });
});
