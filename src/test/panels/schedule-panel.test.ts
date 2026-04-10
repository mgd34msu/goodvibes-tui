import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchedulePanel } from '../../panels/schedule-panel.ts';
import { AutomationManager } from '../../automation/index.ts';
import { normalizeCronSchedule } from '../../automation/schedules.ts';
import { AutomationJobStore } from '../../automation/store/jobs.ts';
import { AutomationRunStore } from '../../automation/store/runs.ts';
import { PersistentStore } from '../../state/persistent-store.ts';
import type { LegacySchedulerSnapshot } from '../../automation/migration.ts';

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
    AutomationManager.resetInstance();
    manager = new AutomationManager({
      jobStore: new AutomationJobStore(join(root, 'automation-jobs.json')),
      runStore: new AutomationRunStore(join(root, 'automation-runs.json')),
      legacyStore: new PersistentStore<LegacySchedulerSnapshot>(join(root, 'legacy.json')),
      spawnTask: () => 'agent-schedule-panel-test',
    });
    (AutomationManager as unknown as { instance: AutomationManager | null }).instance = manager;
  });

  afterEach(() => {
    AutomationManager.resetInstance();
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });

  test('renders empty guidance when no scheduled tasks exist', () => {
    const panel = new SchedulePanel();
    panel.onActivate();
    const text = linesText(panel.render(90, 20));
    expect(text).toContain('No scheduled tasks');
  });

  test('renders scheduled task rows through the shared workspace path', () => {
    const panel = new SchedulePanel();
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
