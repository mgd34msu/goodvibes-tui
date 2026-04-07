import { beforeEach, describe, expect, test } from 'bun:test';
import { SchedulePanel } from '../../panels/schedule-panel.ts';
import { TaskScheduler } from '../../scheduler/scheduler.ts';

function linesText(lines: ReturnType<SchedulePanel['render']>): string {
  return lines.map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd()).join('\n');
}

describe('SchedulePanel', () => {
  beforeEach(() => {
    TaskScheduler.resetInstance();
  });

  test('renders empty guidance when no scheduled tasks exist', () => {
    const panel = new SchedulePanel();
    panel.onActivate();
    const text = linesText(panel.render(90, 20));
    expect(text).toContain('No scheduled tasks');
  });

  test('renders scheduled task rows through the shared workspace path', () => {
    const scheduler = TaskScheduler.getInstance();
    scheduler.add({
      name: 'Daily Sweep',
      cron: '0 0 * * *',
      prompt: 'Run a daily repo sweep',
      enabled: true,
    });
    const panel = new SchedulePanel();
    panel.onActivate();
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('Daily Sweep');
    expect(text).toContain('0 0 * * *');
    expect(text).toContain('Run a daily repo sweep');
  });
});
