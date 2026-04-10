import type { CommandRegistry } from '../command-registry.ts';
import {
  AutomationManager,
  formatEveryInterval,
  normalizeCronStaggerMs,
  normalizeAtSchedule,
  normalizeCronSchedule,
  normalizeEverySchedule,
} from '../../automation/index.ts';
import type { AutomationJob } from '../../automation/jobs.ts';
import type { AutomationScheduleDefinition } from '../../automation/schedules.ts';
import type {
  AutomationExecutionPolicy,
  AutomationExternalContentSource,
  AutomationSessionTarget,
  AutomationWakeMode,
} from '../../automation/session-targets.ts';

function formatSchedule(schedule: AutomationScheduleDefinition): string {
  switch (schedule.kind) {
    case 'cron':
      return [
        schedule.expression,
        schedule.timezone ? `[${schedule.timezone}]` : '',
        schedule.staggerMs !== undefined ? `[stagger ${schedule.staggerMs}ms]` : '',
      ].filter(Boolean).join(' ');
    case 'every':
      return formatEveryInterval(schedule.intervalMs);
    case 'at':
      return new Date(schedule.at).toLocaleString();
  }
}

function parseAutomationTarget(raw: string | undefined): AutomationSessionTarget | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  if (value.startsWith('session:')) {
    return { kind: 'session', sessionId: value.slice('session:'.length), createIfMissing: true };
  }
  if (value.startsWith('route:')) {
    return { kind: 'route', routeId: value.slice('route:'.length), preserveThread: true };
  }
  if (value === 'main' || value === 'current' || value === 'isolated' || value === 'pinned' || value === 'background') {
    return { kind: value, createIfMissing: true };
  }
  return { kind: 'session', sessionId: value, createIfMissing: true };
}

function parseReasoningEffort(raw: string | undefined): AutomationExecutionPolicy['reasoningEffort'] | undefined {
  if (!raw) return undefined;
  if (raw === 'instant' || raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  throw new Error(`Invalid reasoning effort: "${raw}". Use instant, low, medium, or high.`);
}

function parseWakeMode(raw: string | undefined): AutomationWakeMode | undefined {
  if (!raw) return undefined;
  if (raw === 'now' || raw === 'next-heartbeat') return raw;
  throw new Error(`Invalid wake mode: "${raw}". Use now or next-heartbeat.`);
}

function parseFallbackModels(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  return raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
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
            + '  /schedule add cron "<expr>" <prompt...> [--name <name>] [--model <model>] [--provider <provider>] [--template <tmpl>] [--tz <timezone>] [--stagger <ms>]\n'
            + '  /schedule add every <interval> <prompt...> [--name <name>] [--model <model>] [--provider <provider>] [--template <tmpl>]\n'
            + '  /schedule add at <timestamp> <prompt...> [--name <name>] [--model <model>] [--provider <provider>] [--template <tmpl>]'
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
        let provider: string | undefined;
        let template: string | undefined;
        let timezone: string | undefined;
        let staggerMs: number | undefined;
        let target: AutomationSessionTarget | undefined;
        let reasoningEffort: AutomationExecutionPolicy['reasoningEffort'] | undefined;
        let thinking: string | undefined;
        let wakeMode: AutomationWakeMode | undefined;
        let fallbackModels: string[] | undefined;
        let externalContentSource: AutomationExternalContentSource | undefined;
        let allowUnsafeExternalContent: boolean | undefined;
        let lightContext: boolean | undefined;
        const toolAllowlist: string[] = [];
        const promptWords: string[] = [];
        try {
          for (let i = valueStartIndex; i < args.length; i++) {
            const token = args[i]!;
            if (token === '--name' && i + 1 < args.length) {
              name = args[++i];
            } else if (token === '--model' && i + 1 < args.length) {
              model = args[++i];
            } else if (token === '--provider' && i + 1 < args.length) {
              provider = args[++i];
            } else if (token === '--template' && i + 1 < args.length) {
              template = args[++i];
            } else if ((token === '--tz' || token === '--timezone') && i + 1 < args.length) {
              timezone = args[++i];
            } else if (token === '--stagger' && i + 1 < args.length) {
              const parsed = normalizeCronStaggerMs(args[++i]);
              if (parsed === undefined) throw new Error(`Invalid stagger window: "${args[i]}"`);
              staggerMs = parsed;
            } else if (token === '--target' && i + 1 < args.length) {
              target = parseAutomationTarget(args[++i]);
            } else if (token === '--reasoning' && i + 1 < args.length) {
              reasoningEffort = parseReasoningEffort(args[++i]);
            } else if (token === '--thinking' && i + 1 < args.length) {
              thinking = args[++i];
            } else if (token === '--wake' && i + 1 < args.length) {
              wakeMode = parseWakeMode(args[++i]);
            } else if ((token === '--fallback' || token === '--fallbacks') && i + 1 < args.length) {
              fallbackModels = parseFallbackModels(args[++i]);
            } else if (token === '--tool' && i + 1 < args.length) {
              const tool = args[++i]?.trim();
              if (tool) toolAllowlist.push(tool);
            } else if (token === '--external-source' && i + 1 < args.length) {
              externalContentSource = args[++i] as AutomationExternalContentSource;
            } else if (token === '--allow-unsafe-external-content') {
              allowUnsafeExternalContent = true;
            } else if (token === '--light-context') {
              lightContext = true;
            } else {
              promptWords.push(token);
            }
          }
        } catch (error) {
          ctx.print(`Error: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }

        const prompt = promptWords.join(' ').trim();
        if (!prompt) {
          ctx.print('Missing prompt text for automation job.');
          return;
        }

        try {
          const schedule = legacyCronMode
            ? normalizeCronSchedule(scheduleArg, timezone, staggerMs)
            : scheduleKind === 'cron'
              ? normalizeCronSchedule(scheduleArg, timezone, staggerMs)
              : scheduleKind === 'every'
                ? normalizeEverySchedule(scheduleArg)
                : normalizeAtSchedule(parseAtValue(scheduleArg));
          const job = await manager.createJob({
            name: name ?? prompt.slice(0, 40),
            prompt,
            schedule,
            description: prompt,
            model,
            provider,
            fallbackModels,
            template,
            target,
            reasoningEffort,
            thinking,
            wakeMode,
            toolAllowlist: toolAllowlist.length > 0 ? toolAllowlist : undefined,
            allowUnsafeExternalContent,
            externalContentSource,
            lightContext,
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
        + '  /schedule add cron "<expr>" <prompt...> [--target main|current|isolated|pinned|session:<id>] [--stagger <ms>]\n'
        + '  /schedule add every <interval> <prompt...> [--target <target>]\n'
        + '  /schedule add at <timestamp> <prompt...> [--target <target>]\n'
        + '  /schedule list\n'
        + '  /schedule remove <id>\n'
        + '  /schedule enable <id>\n'
        + '  /schedule disable <id>\n'
        + '  /schedule run <id>'
      );
    },
  });
}
