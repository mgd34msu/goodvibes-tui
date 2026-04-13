import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchedulePanel } from '../../panels/schedule-panel.ts';
import { AutomationManager } from '../../automation/index.ts';
import { normalizeCronSchedule } from '../../automation/schedules.ts';
import { AutomationJobStore } from '../../automation/store/jobs.ts';
import { AutomationRouteStore } from '../../automation/store/routes.ts';
import { AutomationRunStore } from '../../automation/store/runs.ts';
import { RouteBindingManager } from '../../channels/route-manager.ts';
import { SharedSessionBroker } from '../../control-plane/session-broker.ts';
import { ConfigManager } from '../../config/manager.ts';
import { PersistentStore } from '../../state/persistent-store.ts';
import type { LegacySchedulerSnapshot } from '../../automation/migration.ts';
import { resetTestRuntimeServices } from '../helpers/runtime-services.ts';

function linesText(lines: ReturnType<SchedulePanel['render']>): string {
  return lines.map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd()).join('\n');
}

describe('SchedulePanel', () => {
  const originalCwd = process.cwd();
  let root = '';
  let manager: AutomationManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-schedule-panel-'));
    process.chdir(root);
    resetTestRuntimeServices();
    const routeBindings = new RouteBindingManager({
      store: new AutomationRouteStore(join(root, 'routes.json')),
    });
    const configManager = new ConfigManager({
      workingDir: root,
      configDir: join(root, '.goodvibes', 'tui'),
    });
    let spawnCount = 0;
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
      spawnTask: ({ prompt }) => {
        const id = `agent-${++spawnCount}-${prompt.length}`;
        return id;
      },
      cancelTask: () => undefined,
      agentStatusProvider: { getStatus: () => null },
    });
    (AutomationManager as unknown as { instance: AutomationManager | null }).instance = manager;
  });

  afterEach(() => {
    resetTestRuntimeServices();
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });

  test('renders empty guidance when no scheduled tasks exist', () => {
    const panel = new SchedulePanel(manager);
    panel.onActivate();
    const text = linesText(panel.render(90, 20));
    expect(text).toContain('No scheduled tasks');
  });

  test('renders scheduled task rows through the shared workspace path', () => {
    const panel = new SchedulePanel(manager);
    return manager.createJob({
      name: 'Daily Sweep',
      prompt: 'Run a daily repo sweep',
      schedule: normalizeCronSchedule('0 0 * * *'),
      enabled: true,
    }).then(() => {
      panel.onActivate();
      const text = linesText(panel.render(100, 24));
      expect(text).toContain('Daily Sweep');
      expect(text).toContain('0 0 * * *');
      expect(text).toContain('Run a daily repo sweep');
    });
  });
});
