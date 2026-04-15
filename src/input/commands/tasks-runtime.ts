import type { CommandRegistry } from '../command-registry.ts';
import type { RuntimeTask, TaskLifecycleState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/tasks';
import { reviewWorktreeAttachments } from '../../runtime/worktree/registry.ts';
import { requireOperatorClient, requireOpsApi, requirePanelManager, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

function sortRuntimeTasks(tasks: RuntimeTask[]): RuntimeTask[] {
  const statusOrder: TaskLifecycleState[] = ['running', 'queued', 'blocked', 'failed', 'completed', 'cancelled'];
  const ranking = new Map(statusOrder.map((status, index) => [status, index] as const));
  return [...tasks].sort((a, b) => {
    const rankDelta = (ranking.get(a.status) ?? 99) - (ranking.get(b.status) ?? 99);
    if (rankDelta !== 0) return rankDelta;
    const aWhen = a.startedAt ?? a.queuedAt;
    const bWhen = b.startedAt ?? b.queuedAt;
    return bWhen - aWhen;
  });
}

function summarizeTaskResult(task: RuntimeTask): string {
  const payload = (
    typeof task.result === 'string'
      ? task.result
      : task.error
        ?? (task.result !== undefined ? JSON.stringify(task.result) : task.description)
        ?? task.title
  );
  const normalized = String(payload).replace(/\s+/g, ' ').trim();
  return normalized.length <= 140 ? normalized : `${normalized.slice(0, 137)}...`;
}

export function registerTasksRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'tasks',
    aliases: ['task'],
    description: 'Inspect and control runtime tasks',
    usage: '[list [status|kind] | show <taskId> | output <taskId> | create <kind> <owner> <title...> | update <taskId> <title|description|result> <value...> | complete <taskId> [result] | fail <taskId> <error...> | cancel <taskId> [note] | pause <taskId> [note] | resume <taskId> [note] | retry <taskId> [note]]',
    handler(args, ctx) {
      if (args.length === 0) {
        if (ctx.showPanel) ctx.showPanel('tasks');
        else {
          const panelManager = requirePanelManager(ctx);
          panelManager.open('tasks');
          panelManager.show();
          ctx.renderRequest();
        }
        return;
      }

      const operatorClient = requireOperatorClient(ctx);
      const tasks = sortRuntimeTasks([...operatorClient.tasks.list(500)]);
      const subcommand = args[0]?.toLowerCase() ?? 'list';

      if (subcommand === 'list') {
        const filter = args[1]?.toLowerCase();
        const filtered = tasks.filter((task) => !filter || task.status === filter || task.kind === filter);
        if (filtered.length === 0) {
          ctx.print(filter ? `No tasks matched "${filter}".` : 'No tasks recorded yet.');
          return;
        }
        ctx.print([
          `Runtime Tasks (${filtered.length})`,
          ...filtered.slice(0, 20).map((task) => `  ${task.id}  ${task.status.padEnd(9)} ${task.kind.padEnd(11)} ${task.owner}  ${task.title}`),
        ].join('\n'));
        return;
      }

      if (subcommand === 'show') {
        const taskId = args[1];
        if (!taskId) {
          ctx.print('Usage: /tasks show <taskId>');
          return;
        }
        const task = operatorClient.tasks.get(taskId);
        if (!task) {
          ctx.print(`Unknown task: ${taskId}`);
          return;
        }
        ctx.print([
          `Task ${task.id}`,
          `  title: ${task.title}`,
          `  kind: ${task.kind}`,
          `  status: ${task.status}`,
          `  owner: ${task.owner}`,
          `  cancellable: ${task.cancellable ? 'yes' : 'no'}`,
          `  queuedAt: ${new Date(task.queuedAt).toISOString()}`,
          `  startedAt: ${task.startedAt ? new Date(task.startedAt).toISOString() : 'n/a'}`,
          `  endedAt: ${task.endedAt ? new Date(task.endedAt).toISOString() : 'n/a'}`,
          `  parent: ${task.parentTaskId ?? 'none'}`,
          `  children: ${task.childTaskIds.join(', ') || '(none)'}`,
          `  correlationId: ${task.correlationId ?? 'n/a'}`,
          ...(() => {
            const shellPaths = requireShellPaths(ctx);
            const worktrees = reviewWorktreeAttachments('task', task.id, {
              workingDirectory: shellPaths.workingDirectory,
            });
            return worktrees.total > 0
              ? [
                  `  worktrees: ${worktrees.total} tracked (${worktrees.active} active / ${worktrees.paused} paused / ${worktrees.cleanupPending} cleanup)`,
                  `  worktree next: /worktree task ${task.id}`,
                ]
              : [];
          })(),
          `  summary: ${summarizeTaskResult(task)}`,
        ].join('\n'));
        return;
      }

      if (subcommand === 'output') {
        const taskId = args[1];
        if (!taskId) {
          ctx.print('Usage: /tasks output <taskId>');
          return;
        }
        const task = operatorClient.tasks.get(taskId);
        if (!task) {
          ctx.print(`Unknown task: ${taskId}`);
          return;
        }
        const payload = typeof task.result === 'string'
          ? task.result
          : task.result !== undefined
            ? JSON.stringify(task.result, null, 2)
            : task.error ?? task.description ?? task.title;
        ctx.print(String(payload));
        return;
      }

      if (subcommand === 'create') {
        const opsApi = requireOpsApi(ctx);
        const kind = args[1];
        const owner = args[2];
        const title = args.slice(3).join(' ').trim();
        if (!kind || !owner || !title) {
          ctx.print('Usage: /tasks create <kind> <owner> <title...>');
          return;
        }
        const validKinds = new Set(['exec', 'agent', 'acp', 'scheduler', 'daemon', 'mcp', 'plugin', 'integration']);
        if (!validKinds.has(kind)) {
          ctx.print(`Unknown task kind: ${kind}`);
          return;
        }
        const task = opsApi.tasks.create({
          kind: kind as import('@pellux/goodvibes-sdk/platform/runtime/store/domains/tasks').TaskKind,
          owner,
          title,
          description: title,
        });
        ctx.print(`Created task ${task.id} (${task.kind}) for ${task.owner}.`);
        return;
      }

      if (subcommand === 'update') {
        const opsApi = requireOpsApi(ctx);
        const taskId = args[1];
        const field = args[2];
        const value = args.slice(3).join(' ').trim();
        if (!taskId || !field || !value) {
          ctx.print('Usage: /tasks update <taskId> <title|description|result> <value...>');
          return;
        }
        if (field !== 'title' && field !== 'description' && field !== 'result') {
          ctx.print(`Unsupported task update field: ${field}`);
          return;
        }
        opsApi.tasks.update(taskId, field === 'result' ? { result: value } : { [field]: value });
        ctx.print(`Updated task ${taskId} field ${field}.`);
        return;
      }

      if (subcommand === 'complete') {
        const opsApi = requireOpsApi(ctx);
        const taskId = args[1];
        if (!taskId) {
          ctx.print('Usage: /tasks complete <taskId> [result]');
          return;
        }
        const result = args.slice(2).join(' ').trim() || undefined;
        opsApi.tasks.complete(taskId, result);
        ctx.print(`Completed task ${taskId}.`);
        return;
      }

      if (subcommand === 'fail') {
        const opsApi = requireOpsApi(ctx);
        const taskId = args[1];
        const errorText = args.slice(2).join(' ').trim();
        if (!taskId || !errorText) {
          ctx.print('Usage: /tasks fail <taskId> <error...>');
          return;
        }
        opsApi.tasks.fail(taskId, { error: errorText });
        ctx.print(`Failed task ${taskId}.`);
        return;
      }

      const taskId = args[1];
      const note = args.slice(2).join(' ').trim() || undefined;
      if (!taskId) {
        ctx.print(`Usage: /tasks ${subcommand} <taskId> [note]`);
        return;
      }
      const opsApi = requireOpsApi(ctx);
      try {
        switch (subcommand) {
          case 'cancel':
            opsApi.tasks.cancel(taskId, note);
            ctx.print(`Cancelled task ${taskId}.`);
            return;
          case 'pause':
            opsApi.tasks.pause(taskId, note);
            ctx.print(`Paused task ${taskId}.`);
            return;
          case 'resume':
            opsApi.tasks.resume(taskId, note);
            ctx.print(`Resumed task ${taskId}.`);
            return;
          case 'retry':
            opsApi.tasks.retry(taskId, note);
            ctx.print(`Re-queued task ${taskId}.`);
            return;
          default:
            ctx.print(`Unknown tasks subcommand: ${subcommand}`);
            return;
        }
      } catch (error) {
        ctx.print(summarizeError(error));
      }
    },
  });
}
