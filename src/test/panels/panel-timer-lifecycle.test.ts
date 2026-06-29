// ---------------------------------------------------------------------------
// panel-timer-lifecycle.test.ts — Regression tests for finding #26:
// refresh/poll timers must STOP while a panel is off-screen (onDeactivate) and
// RESTART when it is re-shown (onActivate). The AgentLogsPanel case is the
// subtle one: onActivate previously called the one-shot _pollCurrentAgent()
// instead of _startPolling(), so the polling interval stayed dead after the
// first switch-away.
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

  test('AgentLogsPanel restarts polling after deactivate -> activate (regression: interval was left dead)', () => {
    installTimerSpy();
    const bus = new RuntimeEventBus();
    const panel = new AgentLogsPanel(createUiRuntimeEvents(bus).agents, {
      agentManager: { list: () => [] },
      workingDirectory: TEST_ROOT,
    });
    const baseline = active.size; // constructor starts polling
    expect(baseline).toBeGreaterThanOrEqual(1);
    panel.onActivate();
    expect(active.size).toBe(baseline); // clears the ctor timer, starts a fresh one
    panel.onDeactivate();
    expect(active.size).toBe(baseline - 1); // polling stopped while off-screen
    panel.onActivate();
    expect(active.size).toBe(baseline); // KEY: polling resumes (previously stayed dead)
    panel.onDestroy();
    expect(active.size).toBe(baseline - 1);
  });
});
