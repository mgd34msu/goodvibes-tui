import type { CommandRegistry } from '../command-registry.ts';
import { TaskScheduler } from '../../scheduler/scheduler.ts';

export function registerScheduleRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'schedule',
    aliases: ['sched'],
    description: 'Manage scheduled agent tasks (cron-like)',
    usage: 'add|list|remove|enable|disable|run',
    argsHint: 'add <cron> <prompt> [--name <n>] [--tz <zone>] | list | remove <id> | enable <id> | disable <id> | run <id>',
    async handler(args, ctx) {
      const scheduler = TaskScheduler.getInstance();
      const sub = args[0];

      if (!sub || sub === 'list') {
        const tasks = scheduler.list();
        if (tasks.length === 0) {
          ctx.print('No scheduled tasks.\nUse: /schedule add "*/30 * * * *" "check build status"');
          return;
        }
        const lines = ['Scheduled tasks:', ''];
        for (const task of tasks) {
          const status = task.enabled ? '● enabled ' : '○ disabled';
          const tzLabel = task.timezone ? ` [${task.timezone}]` : '';
          const fmtDate = (ms: number) => {
            try {
              const opts: Intl.DateTimeFormatOptions = task.timezone
                ? { timeZone: task.timezone, dateStyle: 'short', timeStyle: 'short' }
                : { dateStyle: 'short', timeStyle: 'short' };
              return new Intl.DateTimeFormat(undefined, opts).format(new Date(ms));
            } catch {
              return new Date(ms).toLocaleString();
            }
          };
          const next = task.nextRun ? `next: ${fmtDate(task.nextRun)}${tzLabel}` : 'next: unknown';
          const last = task.lastRun ? `last: ${fmtDate(task.lastRun)}` : 'last: never';
          const missed = task.missedRuns > 0 ? `  missed:${task.missedRuns}` : '';
          lines.push(`  ${task.id.slice(0, 12)}  ${status}  runs:${task.runCount}${missed}  ${next}  ${last}`);
          lines.push(`    name: ${task.name || '(unnamed)'}  cron: ${task.cron}${tzLabel}`);
          lines.push(`    prompt: ${task.prompt.slice(0, 60)}${task.prompt.length > 60 ? '…' : ''}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'add') {
        const cron = args[1];
        if (!cron) {
          ctx.print('Usage: /schedule add "<cron>" "<prompt>" [--name <name>] [--model <model>] [--template <tmpl>] [--tz <timezone>]\n' +
            'Examples:\n' +
            '  /schedule add "*/30 * * * *" "check build status and report failures"\n' +
            '  /schedule add "0 9 * * 1-5" "summarize open PRs" --name morning-standup --tz America/New_York');
          return;
        }

        const remaining = args.slice(2);
        let name: string | undefined;
        let model: string | undefined;
        let template: string | undefined;
        let timezone: string | undefined;
        const promptWords: string[] = [];

        let i = 0;
        while (i < remaining.length) {
          const tok = remaining[i];
          if (tok === '--name' && i + 1 < remaining.length) {
            name = remaining[++i];
          } else if (tok === '--model' && i + 1 < remaining.length) {
            model = remaining[++i];
          } else if (tok === '--template' && i + 1 < remaining.length) {
            template = remaining[++i];
          } else if ((tok === '--tz' || tok === '--timezone') && i + 1 < remaining.length) {
            timezone = remaining[++i];
          } else {
            promptWords.push(tok);
          }
          i++;
        }

        const prompt = promptWords.join(' ');
        if (!prompt) {
          ctx.print('Usage: /schedule add "<cron>" "<prompt>"');
          return;
        }

        try {
          const task = scheduler.add({
            name: name ?? prompt.slice(0, 40),
            cron,
            prompt,
            model,
            template,
            timezone,
            enabled: true,
          });
          const tzLabel = task.timezone ? ` [${task.timezone}]` : '';
          const fmtNext = task.nextRun
            ? (() => {
                try {
                  const opts: Intl.DateTimeFormatOptions = task.timezone
                    ? { timeZone: task.timezone, dateStyle: 'short', timeStyle: 'short' }
                    : { dateStyle: 'short', timeStyle: 'short' };
                  return new Intl.DateTimeFormat(undefined, opts).format(new Date(task.nextRun)) + tzLabel;
                } catch {
                  return new Date(task.nextRun).toLocaleString();
                }
              })()
            : 'unknown';
          ctx.print(`Scheduled task created: ${task.id}\n  name: ${task.name}\n  cron: ${cron}${tzLabel}\n  next run: ${fmtNext}`);
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
        return;
      }

      if (sub === 'remove') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /schedule remove <id>');
          return;
        }
        const all = scheduler.list();
        const task = all.find((entry) => entry.id === id || entry.id.startsWith(id));
        if (!task) {
          ctx.print(`Task not found: ${id}`);
          return;
        }
        scheduler.remove(task.id);
        ctx.print(`Removed scheduled task: ${task.id} (${task.name || task.prompt.slice(0, 30)})`);
        return;
      }

      if (sub === 'enable') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /schedule enable <id>');
          return;
        }
        const all = scheduler.list();
        const task = all.find((entry) => entry.id === id || entry.id.startsWith(id));
        if (!task) {
          ctx.print(`Task not found: ${id}`);
          return;
        }
        scheduler.setEnabled(task.id, true);
        const next = task.nextRun ? new Date(task.nextRun).toLocaleString() : 'unknown';
        ctx.print(`Enabled task: ${task.id} — next run: ${next}`);
        return;
      }

      if (sub === 'disable') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /schedule disable <id>');
          return;
        }
        const all = scheduler.list();
        const task = all.find((entry) => entry.id === id || entry.id.startsWith(id));
        if (!task) {
          ctx.print(`Task not found: ${id}`);
          return;
        }
        scheduler.setEnabled(task.id, false);
        ctx.print(`Disabled task: ${task.id}`);
        return;
      }

      if (sub === 'run') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /schedule run <id>');
          return;
        }
        const all = scheduler.list();
        const task = all.find((entry) => entry.id === id || entry.id.startsWith(id));
        if (!task) {
          ctx.print(`Task not found: ${id}`);
          return;
        }
        try {
          const agentId = await scheduler.runNow(task.id);
          ctx.print(`Running task ${task.id} immediately — agent: ${agentId}`);
        } catch (e) {
          ctx.print(`Error running task: ${(e as Error).message}`);
        }
        return;
      }

      ctx.print('Usage: /schedule add|list|remove|enable|disable|run\n' +
        '  /schedule add "<cron>" <prompt words...>   Create a new scheduled task\n' +
        '  /schedule list                             List all scheduled tasks\n' +
        '  /schedule remove <id>                     Remove a task\n' +
        '  /schedule enable <id>                     Enable a task\n' +
        '  /schedule disable <id>                    Disable a task\n' +
        '  /schedule run <id>                        Run a task immediately');
    },
  });
}
