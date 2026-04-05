import { randomBytes } from 'node:crypto';

import type { CommandRegistry } from '../command-registry.ts';
import { getSessionManager } from '../../sessions/manager.ts';
import { scan, persistProviders } from '../../discovery/index.ts';
import { planManager } from '../../core/plan-manager-instance.ts';
import { classifyIntent } from '../../core/intent-classifier.ts';
import { sessionLineageTracker } from '../../core/session-lineage.ts';
import { handlePlanCommand } from '../../core/plan-command-handler.ts';
import { TaskScheduler } from '../../scheduler/scheduler.ts';

function printSessionExport(
  ctx: { print: (text: string) => void },
  sessionId: string,
  title: string,
  messages: Array<Record<string, unknown>>,
  format: string,
): void {
  const lines: string[] = [];
  if (format === 'markdown') {
    lines.push(`# Session: ${title || sessionId}`);
    lines.push('');
    for (const msg of messages) {
      const role = String(msg.role ?? 'unknown');
      const content = String(msg.content ?? '');
      if (!content.trim()) continue;
      if (role === 'user') {
        lines.push('## User');
        lines.push('');
        lines.push(content);
        lines.push('');
      } else if (role === 'assistant') {
        lines.push('## Assistant');
        lines.push('');
        lines.push(content);
        lines.push('');
      } else if (role === 'tool') {
        const toolName = String(msg.toolName ?? 'tool');
        lines.push(`## Tool Result: ${toolName}`);
        lines.push('');
        lines.push('```');
        lines.push(content.slice(0, 2000) + (content.length > 2000 ? '\n...(truncated)' : ''));
        lines.push('```');
        lines.push('');
      }
    }
  } else {
    for (const msg of messages) {
      const role = String(msg.role ?? 'unknown').toUpperCase();
      const content = String(msg.content ?? '');
      if (!content.trim()) continue;
      lines.push(`[${role}]`);
      lines.push(content);
      lines.push('');
    }
  }
  ctx.print(lines.join('\n'));
}

export function registerSessionWorkflowCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'scan',
    aliases: [],
    description: 'Scan localhost and LAN for local LLM servers',
    async handler(_args, ctx) {
      ctx.print('Scanning for local LLM servers...');
      ctx.renderRequest();

      const result = await scan();

      if (result.servers.length === 0) {
        ctx.print(
          `[Scan] No local LLM servers found (scanned ${result.scannedHosts} hosts, ` +
          `${result.scannedPorts} ports in ${Math.round(result.durationMs / 1000)}s)`,
        );
      } else {
        const lines = [
          `[Scan] Found ${result.servers.length} server(s) in ${Math.round(result.durationMs / 1000)}s:`,
          '',
          ...result.servers.map((server) =>
            `  ${server.name.padEnd(30)} ${server.models.length} model(s)  ${server.host}:${server.port}`,
          ),
          '',
          'Use /model to select a discovered model.',
        ];
        ctx.print(lines.join('\n'));
      }

      try {
        ctx.providerRegistry.registerDiscoveredProviders(result.servers);
      } catch (err) {
        ctx.print(`[Scan] Warning: failed to register some providers: ${(err as Error).message}`);
      }

      if (result.servers.length > 0) persistProviders(result.servers);
      ctx.renderRequest();
    },
  });

  registry.register({
    name: 'session',
    aliases: ['sess'],
    description: 'Manage sessions: list, rename, resume, fork, save, info, export, search, delete',
    usage: '[list | rename <name> | resume <id|name> | fork | save | info <id> | export <id> [format] | search <query> | delete <id>]',
    argsHint: '<list|rename|resume|fork|save|info|export|search|delete>',
    async handler(args, ctx) {
      const sm = getSessionManager();
      const sub = args[0];

      if (!sub) {
        const id = ctx.runtime.sessionId;
        const msgCount = ctx.conversationManager.getMessageCount();
        const title = ctx.conversationManager.title || '(untitled)';
        const meta = sm.getMeta(id);
        const started = meta ? new Date(meta.timestamp).toLocaleString() : 'this session';
        ctx.print([
          'Current session',
          `  ID:       ${id}`,
          `  Name:     ${title}`,
          `  Started:  ${started}`,
          `  Messages: ${msgCount}`,
          `  Model:    ${ctx.runtime.model} (${ctx.runtime.provider})`,
        ].join('\n'));
        return;
      }

      if (sub === 'list') {
        const sessions = sm.list();
        if (sessions.length === 0) {
          ctx.print('No saved sessions. Use /session save [name] to save the current session.');
          return;
        }
        const lines = ['Sessions (most recent first):', ''];
        for (const session of sessions) {
          const date = new Date(session.timestamp).toLocaleString();
          const name = session.title || session.name;
          const model = session.model ? ` [${session.model}]` : '';
          const active = session.name === ctx.runtime.sessionId ? ' *' : '  ';
          lines.push(`${active} ${session.name.padEnd(28)} ${name.slice(0, 22).padEnd(22)} ${date}  ${session.messageCount} msgs${model}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'rename') {
        const newName = args.slice(1).join(' ').trim();
        if (!newName) {
          ctx.print('Usage: /session rename <new-name>');
          return;
        }
        try {
          const existingMeta = sm.getMeta(ctx.runtime.sessionId);
          if (!existingMeta) {
            const exportData = ctx.conversationManager.toJSON() as { messages: object[]; timestamp?: number };
            sm.save(ctx.runtime.sessionId, exportData.messages ?? [], {
              title: ctx.conversationManager.title || '',
              model: ctx.runtime.model,
              provider: ctx.runtime.provider,
              timestamp: Date.now(),
            });
          }
          sm.rename(ctx.runtime.sessionId, newName);
          ctx.conversationManager.title = newName;
          ctx.print(`Session renamed to: ${newName}`);
          ctx.renderRequest();
        } catch (e) {
          ctx.print(`Failed to rename: ${(e as Error).message}`);
        }
        return;
      }

      if (sub === 'resume') {
        const target = args.slice(1).join(' ').trim();
        if (!target) {
          ctx.print('Usage: /session resume <session-id-or-name>');
          return;
        }
        const sessions = sm.list();
        const found = sessions.find((session) =>
          session.name === target ||
          session.name.startsWith(target) ||
          session.title.toLowerCase() === target.toLowerCase(),
        );
        if (!found) {
          ctx.print(`Session not found: ${target}\nUse /session list to see available sessions.`);
          return;
        }
        try {
          const { meta, messages } = sm.load(found.name);
          ctx.conversationManager.resetAll();
          ctx.conversationManager.fromJSON({ messages: messages as never[] });
          if (meta.title) ctx.conversationManager.title = meta.title;
          ctx.conversationManager.rebuildHistory();
          ctx.runtime.sessionId = found.name;
          if (meta.model) {
            ctx.runtime.model = meta.model;
            try {
              ctx.providerRegistry.setCurrentModel(meta.model);
            } catch {
              // model may not exist locally
            }
          }
          if (meta.provider) ctx.runtime.provider = meta.provider;
          ctx.renderRequest();
          ctx.print(`Resumed session: ${found.name}\n  Name: ${meta.title || '(untitled)'}\n  Messages: ${messages.length}\n  Model: ${meta.model || ctx.runtime.model}`);
        } catch (e) {
          ctx.print(`Failed to resume session: ${(e as Error).message}`);
        }
        return;
      }

      if (sub === 'fork') {
        const newId = `user-${randomBytes(4).toString('hex')}`;
        const exportData = ctx.conversationManager.toJSON() as { messages: object[]; timestamp?: number };
        const messages = exportData.messages ?? [];
        const currentTitle = ctx.conversationManager.title;
        const forkName = args[1] ? args.slice(1).join(' ').trim() : `fork-of-${ctx.runtime.sessionId.slice(0, 8)}`;
        const meta = {
          title: forkName,
          model: ctx.runtime.model,
          provider: ctx.runtime.provider,
          timestamp: Date.now(),
        };
        try {
          sm.save(newId, messages, meta);
          ctx.runtime.sessionId = newId;
          ctx.conversationManager.title = forkName;
          ctx.renderRequest();
          ctx.print(`Session forked:\n  New ID: ${newId}\n  Name:   ${forkName}\n  From:   ${currentTitle || ctx.runtime.sessionId}\n  Messages: ${messages.length}`);
        } catch (e) {
          ctx.print(`Failed to fork session: ${(e as Error).message}`);
        }
        return;
      }

      if (sub === 'save') {
        const exportData = ctx.conversationManager.toJSON() as { messages: object[]; timestamp?: number };
        const messages = exportData.messages ?? [];
        const rawName = args[1] ? args.slice(1).join(' ').trim() : (ctx.conversationManager.title || ctx.runtime.sessionId);
        const meta = {
          title: ctx.conversationManager.title,
          model: ctx.runtime.model,
          provider: ctx.runtime.provider,
          timestamp: Date.now(),
        };
        try {
          const { filePath, sanitizedName } = sm.save(rawName, messages, meta);
          ctx.runtime.sessionId = sanitizedName;
          const nameNote = sanitizedName !== rawName ? ` (saved as "${sanitizedName}")` : '';
          ctx.print(`Session saved: ${rawName}${nameNote}\n  → ${filePath}`);
        } catch (e) {
          ctx.print(`Failed to save session: ${(e as Error).message}`);
        }
        return;
      }

      if (sub === 'info') {
        const target = args[1] || ctx.runtime.sessionId;
        const sessions = sm.list();
        const found = sessions.find((session) => session.name === target || session.name.startsWith(target));
        if (!found) {
          ctx.print(`Session not found: ${target}`);
          return;
        }
        const date = new Date(found.timestamp).toLocaleString();
        ctx.print([
          `Session: ${found.name}`,
          `  Title:    ${found.title || '(untitled)'}`,
          `  Model:    ${found.model || '(unknown)'}`,
          `  Provider: ${found.provider || '(unknown)'}`,
          `  Date:     ${date}`,
          `  Messages: ${found.messageCount}`,
          `  File:     ${found.filePath}`,
        ].join('\n'));
        return;
      }

      if (sub === 'export') {
        const target = args[1];
        if (!target) {
          ctx.print('Usage: /session export <session-id> [markdown|text]\nUse /session export . to export the current session.');
          return;
        }
        const format = (args[2] || 'markdown').toLowerCase();
        const sessionId = target === '.' ? ctx.runtime.sessionId : target;
        const sessions = sm.list();
        const found = sessions.find((session) => session.name === sessionId || session.name.startsWith(sessionId));
        if (!found && target !== '.') {
          try {
            const { meta, messages } = sm.load(sessionId);
            printSessionExport(ctx, sessionId, meta.title, messages as Array<Record<string, unknown>>, format);
          } catch {
            ctx.print(`Session not found: ${sessionId}`);
          }
          return;
        }
        const loadName = found ? found.name : sessionId;
        try {
          const { meta, messages } = sm.load(loadName);
          printSessionExport(ctx, loadName, meta.title, messages as Array<Record<string, unknown>>, format);
        } catch (e) {
          ctx.print(`Failed to export session: ${(e as Error).message}`);
        }
        return;
      }

      if (sub === 'search') {
        const query = args.slice(1).join(' ').trim();
        if (!query) {
          ctx.print('Usage: /session search <keyword>');
          return;
        }
        const results = sm.search(query);
        if (results.length === 0) {
          ctx.print(`No sessions found matching: "${query}"`);
          return;
        }
        const lines = [`Search results for "${query}" (${results.length} session${results.length !== 1 ? 's' : ''}):\n`];
        for (const result of results) {
          const date = new Date(result.session.timestamp).toLocaleString();
          lines.push(`  ${result.session.name}  ${result.session.title || '(untitled)'}  ${date}  (${result.matchCount} match${result.matchCount !== 1 ? 'es' : ''})`);
          for (const snippet of result.snippets) {
            lines.push(`    > ${snippet}`);
          }
          lines.push('');
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'delete') {
        const target = args[1];
        if (!target) {
          ctx.print('Usage: /session delete <session-id>');
          return;
        }
        const sessions = sm.list();
        const found = sessions.find((session) => session.name === target || session.name.startsWith(target));
        if (!found) {
          ctx.print(`Session not found: ${target}`);
          return;
        }
        if (found.name === ctx.runtime.sessionId) {
          ctx.print(`Cannot delete the active session (${found.name}).\nSwitch to another session first with /session resume <id>.`);
          return;
        }
        try {
          sm.delete(found.name);
          ctx.print(`Session deleted: ${found.name}${found.title ? ` (${found.title})` : ''}`);
        } catch (e) {
          ctx.print(`Failed to delete session: ${(e as Error).message}`);
        }
        return;
      }

      ctx.print('Unknown subcommand: ' + sub + '\nUsage: /session [list | rename <name> | resume <id> | fork [name] | save [name] | info [id] | export <id> [format] | search <query> | delete <id>]');
    },
  });

  registry.register({
    name: 'plan',
    description: 'Manage execution plans and adaptive execution strategy',
    usage: '[list | show <id> | mode | explain | override <strategy> | status | clear | <task description>]',
    argsHint: '[list|show|mode|explain|override|status|clear|<task>]',
    handler(args, ctx) {
      const plannerSubs = ['mode', 'explain', 'override', 'status', 'clear'];
      if (args.length > 0 && plannerSubs.includes(args[0].toLowerCase())) {
        const result = handlePlanCommand(args[0], args.slice(1));
        ctx.print(result.output);
        return;
      }

      if (args.length === 0) {
        const active = planManager.getActive();
        if (!active) {
          ctx.print('No active plan. Use /plan <task description> to create one.');
          return;
        }
        const summary = planManager.getSummary(active);
        ctx.print(`Active plan: "${active.title}" [${active.status.toUpperCase()}]\n${summary}`);
        return;
      }

      if (args[0] === 'list') {
        const plans = planManager.list();
        if (plans.length === 0) {
          ctx.print('No plans found.');
          return;
        }
        ctx.print(`Plans (${plans.length}):\n${plans.map((plan) => {
          const marker = plan.status === 'active' ? '▶' : ' ';
          return `  ${marker} ${plan.id.slice(0, 8)}  [${plan.status.padEnd(8)}]  ${plan.title}`;
        }).join('\n')}`);
        return;
      }

      if (args[0] === 'show') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /plan show <plan-id>');
          return;
        }
        const plans = planManager.list();
        const plan = plans.find((entry) => entry.id === id || entry.id.startsWith(id));
        if (!plan) {
          ctx.print(`Plan not found: ${id}`);
          return;
        }
        ctx.print(planManager.toMarkdown(plan));
        return;
      }

      const taskDescription = args.join(' ');
      const classification = classifyIntent(taskDescription);
      const plan = planManager.create(taskDescription, []);
      plan.awaitingPlan = true;
      planManager.save(plan);
      sessionLineageTracker.setOriginalTask(taskDescription.slice(0, 200));

      ctx.print(
        `Plan created: "${plan.title}" (${plan.id.slice(0, 8)})\n` +
        `Intent: ${classification.intent} (confidence: ${(classification.confidence * 100).toFixed(0)}%)\n` +
        `Signals: ${classification.signals.join(', ') || 'none'}\n` +
        'The model will write the execution plan — agents will be spawned automatically.',
      );

      ctx.conversationManager.addSystemMessage(
        `You are creating an execution plan for the following task: "${taskDescription}"\n\n` +
        'Output the plan in EXACTLY this markdown format and nothing else:\n\n' +
        '## Phase 1: [Phase Name] [PENDING]\n' +
        '- [ ] [Task description] — PENDING\n' +
        '- [ ] [Task description] — PENDING (depends: [other task description])\n\n' +
        '## Phase 2: [Phase Name] [PENDING]\n' +
        '- [ ] [Task description] — PENDING (depends: [Phase 1 task description])\n\n' +
        'Rules:\n' +
        '- Each item must be a concrete, independently executable task\n' +
        '- Use (depends: ...) only where execution order truly matters\n' +
        '- Items without dependencies in the same phase can run in parallel\n' +
        '- Keep phases to 2-4 items each, aim for maximum parallelism\n' +
        '- Output ONLY the plan markdown — the system will parse it and spawn agents automatically',
      );

      ctx.activatePlan?.(plan.id, taskDescription);
    },
  });

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

  registry.register({
    name: 'fork',
    aliases: ['branch-save'],
    description: 'Save a named snapshot of the current conversation',
    usage: '[name]',
    argsHint: '[name]',
    handler(args, ctx) {
      const name = args[0];
      const branchName = ctx.conversationManager.forkBranch(name);
      const msgCount = ctx.conversationManager.getMessageCount();
      ctx.print(`Forked conversation as "${branchName}" (${msgCount} message${msgCount === 1 ? '' : 's'}).`);
    },
  });

  registry.register({
    name: 'branch',
    aliases: ['br'],
    description: 'List conversation branches or switch to one',
    usage: '[name]',
    argsHint: '[name]',
    handler(args, ctx) {
      if (args.length === 0) {
        const branches = ctx.conversationManager.listBranches();
        if (branches.length === 0) {
          ctx.print('No branches. Use /fork [name] to create one.');
          return;
        }
        const current = ctx.conversationManager.getCurrentBranch();
        const lines = [`Branches (current: ${current}):`];
        for (const branch of branches) {
          const marker = branch.isCurrent ? '▶' : ' ';
          lines.push(`  ${marker} ${branch.name}  (${branch.messageCount} message${branch.messageCount === 1 ? '' : 's'})`);
        }
        ctx.print(lines.join('\n'));
        return;
      }
      const name = args[0];
      const ok = ctx.conversationManager.switchBranch(name);
      if (!ok) {
        ctx.print(`Branch "${name}" not found. Use /fork [name] to create one, or /branch to list.`);
        return;
      }
      ctx.print(`Switched to branch "${name}".`);
      ctx.renderRequest();
    },
  });

  registry.register({
    name: 'merge',
    aliases: [],
    description: 'Append messages from a branch after the fork point',
    usage: '<name>',
    argsHint: '<name>',
    handler(args, ctx) {
      const name = args[0];
      if (!name) {
        ctx.print('Usage: /merge <branch-name>\nSee /branch for available branches.');
        return;
      }
      const ok = ctx.conversationManager.mergeBranch(name);
      if (!ok) {
        ctx.print(`Branch "${name}" not found. Use /branch to list available branches.`);
        return;
      }
      ctx.print(`Merged branch "${name}" into current conversation.`);
      ctx.renderRequest();
    },
  });
}
