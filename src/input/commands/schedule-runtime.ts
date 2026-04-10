import type { CommandRegistry } from '../command-registry.ts';
import {
  AutomationManager,
  formatEveryInterval,
  normalizeAtSchedule,
  normalizeCronSchedule,
  normalizeEverySchedule,
} from '../../automation/index.ts';
import type { AutomationJob } from '../../automation/jobs.ts';
import type { AutomationScheduleDefinition } from '../../automation/schedules.ts';

function formatSchedule(schedule: AutomationScheduleDefinition): string {
  switch (schedule.kind) {
    case 'cron':
      return schedule.timezone ? `${schedule.expression} [${schedule.timezone}]` : schedule.expression;
    case 'every':
      return formatEveryInterval(schedule.intervalMs);
    case 'at':
      return new Date(schedule.at).toLocaleString();
  }
}

function formatNextRun(nextRunAt?: number): string {
  return nextRunAt ? new Date(nextRunAt).toLocaleString() : 'n/a';
}

function formatPrompt(job: AutomationJob): string {
  const prompt = (job.execution.prompt ?? job.description ?? '').trim();
  return prompt.length > 60 ? `${prompt.slice(0, 60)}...` : prompt;
}

function resolveJob(manager: AutomationManager, id: string): AutomationJob | undefined {
  return manager.listJobs().find((job) => job.id === id || job.id.startsWith(id));
}

function parseAtValue(raw: string): number {
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid date/time: "${raw}". Use an ISO timestamp or a format Date.parse understands.`);
  }
  return parsed;
}

export function registerScheduleRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'schedule',
    aliases: ['sched'],
    description: 'Manage automation jobs and scheduled runs',
    usage: 'add <cron|every|at> <value> <prompt...> | list | remove <id> | enable <id> | disable <id> | run <id>',
    argsHint: 'add cron <expr> | add every <interval> | add at <timestamp> | list | remove | enable | disable | run',
    async handler(args, ctx) {
      const manager = AutomationManager.getInstance();
      await manager.start();
      const sub = args[0];

      if (!sub || sub === 'list') {
        const jobs = manager.listJobs();
        if (jobs.length === 0) {
          ctx.print(
            'No automation jobs.\n'
            + 'Use:\n'
            + '  /schedule add cron "*/30 * * * *" "check build status"\n'
            + '  /schedule add every 15m "summarize open PRs"\n'
            + '  /schedule add at 2026-04-10T09:00:00 "send release reminder"'
          );
          return;
        }
        const lines = ['Automation jobs:', ''];
        for (const job of jobs) {
          const status = job.enabled ? '● enabled ' : '○ paused  ';
          const next = formatNextRun(job.nextRunAt);
          const last = job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : 'never';
          lines.push(`  ${job.id.slice(0, 12)}  ${status} runs:${job.runCount}  next:${next}  last:${last}`);
          lines.push(`    name: ${job.name}  schedule: ${formatSchedule(job.schedule)}`);
          lines.push(`    prompt: ${formatPrompt(job)}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'add') {
        const scheduleKind = args[1];
        if (!scheduleKind) {
          ctx.print(
            'Usage:\n'
            + '  /schedule add cron "<expr>" <prompt...> [--name <name>] [--model <model>] [--template <tmpl>] [--tz <timezone>]\n'
            + '  /schedule add every <interval> <prompt...> [--name <name>] [--model <model>] [--template <tmpl>]\n'
            + '  /schedule add at <timestamp> <prompt...> [--name <name>] [--model <model>] [--template <tmpl>]'
          );
          return;
        }

        const legacyCronMode = scheduleKind !== 'cron' && scheduleKind !== 'every' && scheduleKind !== 'at';
        const scheduleArg = legacyCronMode ? args[1] : args[2];
        const valueStartIndex = legacyCronMode ? 2 : 3;
        if (!scheduleArg) {
          ctx.print('Missing schedule value.');
          return;
        }

        let name: string | undefined;
        let model: string | undefined;
        let template: string | undefined;
        let timezone: string | undefined;
        const promptWords: string[] = [];
        for (let i = valueStartIndex; i < args.length; i++) {
          const token = args[i]!;
          if (token === '--name' && i + 1 < args.length) {
            name = args[++i];
          } else if (token === '--model' && i + 1 < args.length) {
            model = args[++i];
          } else if (token === '--template' && i + 1 < args.length) {
            template = args[++i];
          } else if ((token === '--tz' || token === '--timezone') && i + 1 < args.length) {
            timezone = args[++i];
          } else {
            promptWords.push(token);
          }
        }

        const prompt = promptWords.join(' ').trim();
        if (!prompt) {
          ctx.print('Missing prompt text for automation job.');
          return;
        }

        try {
          const schedule = legacyCronMode
            ? normalizeCronSchedule(scheduleArg, timezone)
            : scheduleKind === 'cron'
              ? normalizeCronSchedule(scheduleArg, timezone)
              : scheduleKind === 'every'
                ? normalizeEverySchedule(scheduleArg)
                : normalizeAtSchedule(parseAtValue(scheduleArg));
          const job = await manager.createJob({
            name: name ?? prompt.slice(0, 40),
            prompt,
            schedule,
            description: prompt,
            model,
            template,
            enabled: true,
          });
          ctx.print(
            `Automation job created: ${job.id}\n`
            + `  name: ${job.name}\n`
            + `  schedule: ${formatSchedule(job.schedule)}\n`
            + `  next run: ${formatNextRun(job.nextRunAt)}`
          );
        } catch (error) {
          ctx.print(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }

      if (sub === 'remove') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /schedule remove <id>');
          return;
        }
        const job = resolveJob(manager, id);
        if (!job) {
          ctx.print(`Automation job not found: ${id}`);
          return;
        }
        await manager.removeJob(job.id);
        ctx.print(`Removed automation job: ${job.id} (${job.name})`);
        return;
      }

      if (sub === 'enable' || sub === 'disable') {
        const id = args[1];
        if (!id) {
          ctx.print(`Usage: /schedule ${sub} <id>`);
          return;
        }
        const job = resolveJob(manager, id);
        if (!job) {
          ctx.print(`Automation job not found: ${id}`);
          return;
        }
        const updated = await manager.setEnabled(job.id, sub === 'enable');
        if (!updated) {
          ctx.print(`Automation job not found: ${id}`);
          return;
        }
        ctx.print(
          `${sub === 'enable' ? 'Enabled' : 'Disabled'} automation job: ${updated.id}\n`
          + `  next run: ${formatNextRun(updated.nextRunAt)}`
        );
        return;
      }

      if (sub === 'run') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /schedule run <id>');
          return;
        }
        const job = resolveJob(manager, id);
        if (!job) {
          ctx.print(`Automation job not found: ${id}`);
          return;
        }
        try {
          const run = await manager.runNow(job.id);
          ctx.print(
            `Running automation job ${job.id} immediately\n`
            + `  run: ${run.id}\n`
            + `  agent: ${run.agentId ?? 'unavailable'}`
          );
        } catch (error) {
          ctx.print(`Error running automation job: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }

      ctx.print(
        'Usage:\n'
        + '  /schedule add cron "<expr>" <prompt...>\n'
        + '  /schedule add every <interval> <prompt...>\n'
        + '  /schedule add at <timestamp> <prompt...>\n'
        + '  /schedule list\n'
        + '  /schedule remove <id>\n'
        + '  /schedule enable <id>\n'
        + '  /schedule disable <id>\n'
        + '  /schedule run <id>'
      );
    },
  });
}
