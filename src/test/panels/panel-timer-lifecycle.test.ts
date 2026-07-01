// ---------------------------------------------------------------------------
// panel-timer-lifecycle.test.ts — Regression tests for panel refresh/poll timers.
// TokenBudgetPanel STOPS its refresh timer while off-screen (onDeactivate) and
// RESTARTS it when re-shown (onActivate). AgentLogsPanel takes the other valid
// approach: one always-on poll timer from ctor to onDestroy, with repaints gated
// on `_active` (markDirty) — so it is inherently immune to a "dead interval".
// ---------------------------------------------------------------------------

import { describe, test, expect, afterEach } from 'bun:test';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createUiRuntimeEvents } from '../../runtime/ui-events.ts';
import { TokenBudgetPanel } from '../../panels/token-budget-panel.ts';
import { AgentLogsPanel } from '../../panels/agent-logs-panel.ts';

const TEST_ROOT = '/tmp/goodvibes-test';

// Spy on interval timers so we can count active ones across the panel lifecycle.
const realSet = globalThis.setInterval;
const realClear = globalThis.clearInterval;
let active: Set<ReturnType<typeof setInterval>>;

function installTimerSpy(): void {
  active = new Set();
  globalThis.setInterval = ((handler: () => void, timeout?: number, ...args: unknown[]) => {
    const id = realSet(handler, timeout, ...args);
    active.add(id);
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
    if (id !== undefined) active.delete(id);
    realClear(id);
  }) as typeof clearInterval;
}

afterEach(() => {
  globalThis.setInterval = realSet;
  globalThis.clearInterval = realClear;
});

describe('panel timer lifecycle (#26: no polling while off-screen)', () => {
  test('TokenBudgetPanel stops its refresh timer on deactivate and restarts on activate', () => {
    installTimerSpy();
    const panel = new TokenBudgetPanel(
      new SessionMemoryStore(),
      new ConfigManager({ surfaceRoot: 'tui', homeDir: TEST_ROOT, workingDir: TEST_ROOT }),
    );
    const baseline = active.size; // constructor does not start the refresh timer
    panel.onActivate();
    expect(active.size).toBe(baseline + 1);
    panel.onDeactivate();
    expect(active.size).toBe(baseline); // timer stopped while off-screen
    panel.onActivate();
    expect(active.size).toBe(baseline + 1); // restarts on re-show
    panel.onDestroy();
    expect(active.size).toBe(baseline);
  });

  test('AgentLogsPanel keeps one poll timer alive across activate/deactivate and clears it on destroy', () => {
    installTimerSpy();
    const bus = new RuntimeEventBus();
    const panel = new AgentLogsPanel(createUiRuntimeEvents(bus).agents, {
      agentManager: { list: () => [] },
      workingDirectory: TEST_ROOT,
    });
    const baseline = active.size; // constructor starts the always-on poll timer
    expect(baseline).toBeGreaterThanOrEqual(1);
    panel.onActivate();
    expect(active.size).toBe(baseline); // no new interval — onActivate only flips _active + polls once
    panel.onDeactivate();
    expect(active.size).toBe(baseline); // timer stays alive off-screen; markDirty() gates repaints on _active
    panel.onActivate();
    expect(active.size).toBe(baseline); // still exactly one timer (immune to the "dead interval" bug)
    panel.onDestroy();
    expect(active.size).toBe(baseline - 1); // poll timer cleared on destroy
  });
});
