import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationControlPanel } from '../../../panels/automation-control-panel.ts';
import { createAutomationReadModel, createWatchersReadModel } from '../../helpers/ui-read-models.ts';
import { baseWatcher, createDomainDispatch, createRuntimeStore, linesText } from './_shared.ts';
import {
  AutomationManager,
  AutomationJobStore,
  AutomationRunStore,
  AutomationRouteStore,
  normalizeCronSchedule,
} from '@pellux/goodvibes-sdk/platform/automation';
import type { LegacySchedulerSnapshot } from '@pellux/goodvibes-sdk/platform/automation';
import { RouteBindingManager } from '@pellux/goodvibes-sdk/platform/channels';
import { SharedSessionBroker } from '@pellux/goodvibes-sdk/platform/control-plane';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { PersistentStore } from '@pellux/goodvibes-sdk/platform/state';
import { resetTestRuntimeServices } from '../../helpers/runtime-services.ts';

// ---------------------------------------------------------------------------
// AutomationControlPanel (merged automation console — WO-111)
//
// Absorbs the former SchedulePanel and WatchersPanel spec coverage: jobs are
// exercised against a real AutomationManager (not a mock) so 'e' and 'r' are
// proven to drive real state transitions, and the Sources section coverage
// folded in from the deleted watchers-panel.test.ts.
// ---------------------------------------------------------------------------

describe('AutomationControlPanel (merged automation console)', () => {
  const originalCwd = process.cwd();
  let root = '';
  let manager: AutomationManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-automation-control-panel-'));
    process.chdir(root);
    resetTestRuntimeServices();
    const routeBindings = new RouteBindingManager({
      store: new AutomationRouteStore(join(root, 'routes.json')),
    });
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      workingDir: root,
      configDir: join(root, '.goodvibes', 'tui'),
    });
    const sessionBroker = new SharedSessionBroker({
      store: new PersistentStore(join(root, 'sessions.json')) as never,
      routeBindings,
      agentStatusProvider: { getStatus: () => null },
      messageSender: { send: () => false },
    });
    manager = new AutomationManager({
      configManager,
      jobStore: new AutomationJobStore(join(root, 'automation-jobs.json')),
      runStore: new AutomationRunStore(join(root, 'automation-runs.json')),
      legacyStore: new PersistentStore<LegacySchedulerSnapshot>(join(root, 'legacy.json')),
      routeBindings,
      sessionBroker,
      spawnTask: ({ prompt }) => `agent-${prompt.length}`,
      cancelTask: () => undefined,
      agentStatusProvider: { getStatus: () => null },
    });
  });

  afterEach(() => {
    resetTestRuntimeServices();
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });

  test('renders default Runs focus chrome and hints when wired to a real automation manager', async () => {
    const store = createRuntimeStore();
    manager.attachRuntime({ runtimeStore: store });
    await manager.createJob({
      name: 'Nightly Sweep',
      prompt: 'Run a nightly repo sweep',
      schedule: normalizeCronSchedule('0 0 * * *'),
      enabled: true,
    });

    const panel = new AutomationControlPanel(createAutomationReadModel(store), createWatchersReadModel(store), { automationManager: manager });
    const text = linesText(panel.render(100, 28));
    expect(text).toContain('Automation Control');
    expect(text).toContain('Runs');
    expect(text).toContain('Jobs');
    expect(text).toContain('Sources');
    expect(text).toContain('select run');
    expect(text).toContain('deliveries ok');
  });

  test('Tab focuses Jobs; e disables a real job through a confirm, then re-enables and r runs it now', async () => {
    const store = createRuntimeStore();
    manager.attachRuntime({ runtimeStore: store });
    const job = await manager.createJob({
      name: 'Nightly Sweep',
      prompt: 'Run a nightly repo sweep',
      schedule: normalizeCronSchedule('0 0 * * *'),
      enabled: true,
    });

    // Wrap the real manager methods so the test can await exactly the promise
    // the panel's fire-and-forget key handlers kick off.
    let pending: Promise<unknown> = Promise.resolve();
    const originalSetEnabled = manager.setEnabled.bind(manager);
    manager.setEnabled = ((id: string, enabled: boolean) => {
      const result = originalSetEnabled(id, enabled);
      pending = result;
      return result;
    }) as typeof manager.setEnabled;
    const originalRunNow = manager.runNow.bind(manager);
    manager.runNow = ((id: string) => {
      const result = originalRunNow(id);
      pending = result;
      return result;
    }) as typeof manager.runNow;

    const panel = new AutomationControlPanel(createAutomationReadModel(store), undefined, { automationManager: manager });
    panel.handleInput('tab'); // Runs -> Jobs
    let text = linesText(panel.render(100, 28));
    expect(text).toContain('Nightly Sweep');
    expect(text).toContain('enabled');

    panel.handleInput('e'); // enabled job -> confirm before disabling
    text = linesText(panel.render(100, 28));
    expect(text).toContain('Disable "Nightly Sweep"?');

    panel.handleInput('y'); // confirm
    await pending;
    text = linesText(panel.render(100, 28));
    expect(text).toContain('paused');

    panel.handleInput('e'); // disabled job -> enable immediately, no confirm
    await pending;
    text = linesText(panel.render(100, 28));
    expect(text).toContain('enabled');

    const before = manager.listRuns(job.id).length;
    panel.handleInput('r');
    await pending;
    expect(manager.listRuns(job.id).length).toBeGreaterThan(before);
  });

  test('Sources section (Tab x2 from Runs) renders watcher health folded from the former Watchers panel', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.syncWatcher(baseWatcher(), 'test');

    const panel = new AutomationControlPanel(createAutomationReadModel(store), createWatchersReadModel(store));
    panel.handleInput('tab'); // Runs -> Jobs
    panel.handleInput('tab'); // Jobs -> Sources
    const text = linesText(panel.render(100, 26));
    expect(text).toContain('Filesystem Watcher');
    expect(text).toContain('lagging');
    expect(text).toContain('source behind expected heartbeat');
  });
});
