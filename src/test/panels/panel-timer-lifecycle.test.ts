// ---------------------------------------------------------------------------
// panel-timer-lifecycle.test.ts — Regression tests for panel refresh/poll timers.
// Both TokenBudgetPanel and AgentInspectorPanel STOP their refresh timer while
// off-screen (onDeactivate) and RESTART it when re-shown (onActivate), so
// neither leaks an interval nor polls a hidden panel.
// ---------------------------------------------------------------------------

import { describe, test, expect, afterEach } from 'bun:test';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core';
import type { AgentEvent } from '@/runtime/index.ts';
import type { UiEventFeed } from '../../runtime/ui-events.ts';
import { TokenBudgetPanel } from '../../panels/token-budget-panel.ts';
import { AgentInspectorPanel } from '../../panels/agent-inspector-panel.ts';

const STUB_AGENT_EVENTS = {
  on: () => () => {},
  onEnvelope: () => () => {},
  emit: () => {},
} as unknown as UiEventFeed<AgentEvent>;

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

  test('AgentInspectorPanel (WO-110: merged agent-logs console) stops its refresh timer on deactivate and restarts on activate', () => {
    installTimerSpy();
    const panel = new AgentInspectorPanel({
      agentManager: { list: () => [], getStatus: () => null, cancel: () => true },
      agentMessageBus: { getMessages: () => [] },
      workingDirectory: TEST_ROOT,
      cancelAgent: () => true,
      agentEvents: STUB_AGENT_EVENTS,
    });
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
});
