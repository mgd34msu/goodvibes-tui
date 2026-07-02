import { beforeEach, describe, expect, test } from 'bun:test';
import { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import { createShellPlanRuntime } from '@/runtime/index.ts';
import { createUiRuntimeEvents } from '../../../runtime/ui-events.ts';
import { OpsStrategyPanel } from '../../../panels/ops-strategy-panel.ts';
import { createRuntimeBusStub, linesText } from './_shared.ts';

describe('workspace panel migrations', () => {
  let runtimeBus: RuntimeEventBus;

  beforeEach(async () => {
    runtimeBus = createRuntimeBusStub();
  });

  test('OpsStrategyPanel renders shared workspace empty state cleanly', async () => {
    const panel = new OpsStrategyPanel(createUiRuntimeEvents(runtimeBus).planner, new AdaptivePlanner());
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Ops Strategy');
    expect(linesText(lines)).toContain('No decisions recorded yet');
    // WO-120: empty state pointed operators at '/ops' (itself — this panel IS
    // 'ops'), a dead self-referential signpost. It now points at '/plan',
    // which actually produces the strategy decisions this panel displays.
    expect(linesText(lines)).toContain('/plan');
    expect(linesText(lines)).not.toContain('/ops');
  });
});

describe('OpsStrategyPanel override verbs (WO-120)', () => {
  let runtimeBus: RuntimeEventBus;

  beforeEach(async () => {
    runtimeBus = createRuntimeBusStub();
  });

  test('o cycles the override forward through the strategy list via deps.planRuntime', () => {
    const adaptivePlanner = new AdaptivePlanner();
    const planRuntime = createShellPlanRuntime({ adaptivePlanner, runtimeBus });
    const panel = new OpsStrategyPanel(createUiRuntimeEvents(runtimeBus).planner, adaptivePlanner, planRuntime);

    expect(adaptivePlanner.getOverride()).toBeNull();
    expect(panel.handleInput('o')).toBe(true);
    expect(adaptivePlanner.getOverride()).toBe('single');

    expect(panel.handleInput('o')).toBe(true);
    expect(adaptivePlanner.getOverride()).toBe('cohort');

    const text = linesText(panel.render(80, 20));
    expect(text).toContain('COHORT');
    expect(text).toContain('ACTIVE');
  });

  test('c clears an active override via deps.planRuntime', () => {
    const adaptivePlanner = new AdaptivePlanner();
    const planRuntime = createShellPlanRuntime({ adaptivePlanner, runtimeBus });
    const panel = new OpsStrategyPanel(createUiRuntimeEvents(runtimeBus).planner, adaptivePlanner, planRuntime);

    panel.handleInput('o');
    expect(adaptivePlanner.getOverride()).not.toBeNull();

    expect(panel.handleInput('c')).toBe(true);
    expect(adaptivePlanner.getOverride()).toBeNull();

    const text = linesText(panel.render(80, 20));
    expect(text).toContain('none');
  });

  test('m cycles the operating mode forward via deps.planRuntime', () => {
    const adaptivePlanner = new AdaptivePlanner();
    const planRuntime = createShellPlanRuntime({ adaptivePlanner, runtimeBus });
    const panel = new OpsStrategyPanel(createUiRuntimeEvents(runtimeBus).planner, adaptivePlanner, planRuntime);

    expect(adaptivePlanner.getMode()).toBe('auto');
    expect(panel.handleInput('m')).toBe(true);
    expect(adaptivePlanner.getMode()).toBe('single');

    const text = linesText(panel.render(80, 20));
    expect(text).toContain('SINGLE');
  });

  test('o/c/m surface an error instead of throwing when deps.planRuntime is not wired', () => {
    const adaptivePlanner = new AdaptivePlanner();
    const panel = new OpsStrategyPanel(createUiRuntimeEvents(runtimeBus).planner, adaptivePlanner);

    expect(panel.handleInput('o')).toBe(true);
    expect(adaptivePlanner.getOverride()).toBeNull();
    const text = linesText(panel.render(80, 20));
    expect(text).toContain('Plan runtime is not wired for this runtime.');
  });
});
