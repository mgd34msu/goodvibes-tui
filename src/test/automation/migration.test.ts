import { describe, expect, test } from 'bun:test';
import { migrateLegacySchedules } from '@pellux/goodvibes-sdk/platform/automation/index';

describe('legacy scheduler migration', () => {
  test('maps scheduled tasks and history into first-class automation records', () => {
    const migrated = migrateLegacySchedules({
      tasks: [
        {
          id: 'sched-1234',
          name: 'Nightly status',
          cron: '0 2 * * *',
          timezone: 'America/Chicago',
          prompt: 'Summarize nightly build status',
          model: 'gpt-5.4',
          template: 'reviewer',
          enabled: true,
          lastRun: 1_700_000_000_000,
          nextRun: 1_700_000_360_000,
          runCount: 4,
          missedRuns: 1,
          createdAt: 1_699_999_000_000,
        },
      ],
      history: [
        {
          taskId: 'sched-1234',
          startedAt: 1_700_000_000_000,
          agentId: 'agent-1',
          status: 'completed',
        },
      ],
    });

    expect(migrated.jobs).toHaveLength(1);
    expect(migrated.runs).toHaveLength(1);
    expect(migrated.jobs[0]).toMatchObject({
      id: 'sched-1234',
      status: 'enabled',
      schedule: { kind: 'cron', expression: '0 2 * * *' },
      execution: { modelId: 'gpt-5.4' },
      source: { kind: 'schedule' },
    });
    expect(migrated.runs[0]).toMatchObject({
      jobId: 'sched-1234',
      status: 'completed',
      triggeredBy: { kind: 'migration' },
    });
  });
});
