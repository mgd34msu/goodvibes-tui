/**
 * tasks-runtime.ts — `/tasks`.
 *
 * The reads are a UNION now: this surface's own runtime tasks (the exec, agent
 * and ACP work the loop here spawned) plus the daemon's (scheduled work,
 * channel-driven runs, tasks other surfaces submitted). Before the daemon
 * became its own product one registry held both, and `tasks.list(500)` off the
 * in-process transport answered synchronously. It no longer holds both, so this
 * command crosses a wire and is async — the same shape `/ci` and the fleet act
 * verbs already use.
 *
 * The list output is unchanged for a local-only fleet: same header, same
 * columns, same 20-row cap, same filter semantics. What is added is the daemon
 * half, and one honest line when the daemon could not be reached — a partial
 * list of real tasks beats an error page, but it must not read as complete.
 *
 * Writes do NOT degrade that way. A lifecycle act against a task this terminal
 * does not own is routed to the daemon's verb where one exists (cancel, retry)
 * and refused by name where none does (update, complete, fail, pause and
 * resume have no wire verb). Applying one locally would report success and
 * change nothing on the process that actually runs the task.
 */
import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import type { RuntimeTask, TaskLifecycleState } from '@/runtime/index.ts';
import { reviewWorktreeAttachments } from '@/runtime/index.ts';
import { requireOperatorClient, requireOpsApi, requirePanelManager, requireShellPaths } from './runtime-services.ts';
import { createTasksClient, type TasksClient, type UnionTask } from '@pellux/goodvibes-sdk/platform/runtime/client';
import { createDaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

function sortRuntimeTasks(tasks: readonly UnionTask[]): UnionTask[] {
  const statusOrder: TaskLifecycleState[] = ['running', 'queued', 'blocked', 'failed', 'completed', 'cancelled'];
  const ranking = new Map(statusOrder.map((status, index) => [status, index] as const));
  return [...tasks].sort((a, b) => {
    const rankDelta = (ranking.get(a.task.status) ?? 99) - (ranking.get(b.task.status) ?? 99);
    if (rankDelta !== 0) return rankDelta;
    const aWhen = a.task.startedAt ?? a.task.queuedAt;
    const bWhen = b.task.startedAt ?? b.task.queuedAt;
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

/** The union reader: the in-process source plus this workspace's daemon. */
function tasksClientFor(ctx: CommandContext): TasksClient {
  const operatorClient = requireOperatorClient(ctx);
  return createTasksClient({
    local: {
      list: (limit) => operatorClient.tasks.list(limit),
      get: (taskId) => operatorClient.tasks.get(taskId),
    },
    verbs: createDaemonVerbCaller({
      configManager: ctx.platform.configManager,
      // Lazy, matching getOperatorRpc: a disabled-daemon context with no shell
      // paths wired still gets the honest reason instead of a throw.
      homeDirectory: () => requireShellPaths(ctx).homeDirectory,
    }),
  });
}

/** The five lifecycle acts the operator contract carries no verb for. */
const LOCAL_ONLY_ACTS = new Set(['update', 'complete', 'fail', 'pause', 'resume']);

function refuseDaemonOwnedAct(taskId: string, subcommand: string): string {
  return `${taskId} runs on the daemon, and the operator contract carries no ${subcommand} verb to reach it with. `
    + 'Cancel and retry are available; the rest act on this terminal\'s own tasks.';
}

export function registerTasksRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'tasks',
    aliases: ['task'],
    description: 'Inspect and control runtime tasks',
    usage: '[list [status|kind] | show <taskId> | output <taskId> | create <kind> <owner> <title...> | update <taskId> <title|description|result> <value...> | complete <taskId> [result] | fail <taskId> <error...> | cancel <taskId> [note] | pause <taskId> [note] | resume <taskId> [note] | retry <taskId> [note]]',
    async handler(args, ctx) {
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

      const subcommand = args[0]?.toLowerCase() ?? 'list';
      const tasksClient = tasksClientFor(ctx);

      if (subcommand === 'list') {
        const { tasks: union, daemonUnavailable } = await tasksClient.list(500);
        const tasks = sortRuntimeTasks(union);
        const filter = args[1]?.toLowerCase();
        const filtered = tasks.filter((entry) => !filter || entry.task.status === filter || entry.task.kind === filter);
        // The daemon note rides ALONGSIDE whatever was found rather than
        // replacing it: the local half is real work, and hiding it behind an
        // error would lose tasks that are genuinely running here.
        const daemonNote = daemonUnavailable
          ? [`  (the daemon's tasks are not included: ${daemonUnavailable})`]
          : [];
        if (filtered.length === 0) {
          ctx.print([
            filter ? `No tasks matched "${filter}".` : 'No tasks recorded yet.',
            ...daemonNote,
          ].join('\n'));
          return;
        }
        ctx.print([
          `Runtime Tasks (${filtered.length})`,
          ...filtered.slice(0, 20).map(({ task }) => `  ${task.id}  ${task.status.padEnd(9)} ${task.kind.padEnd(11)} ${task.owner}  ${task.title}`),
          ...daemonNote,
        ].join('\n'));
        return;
      }

      if (subcommand === 'show') {
        const taskId = args[1];
        if (!taskId) {
          ctx.print('Usage: /tasks show <taskId>');
          return;
        }
        const found = await tasksClient.get(taskId);
        if (!found) {
          ctx.print(`Unknown task: ${taskId}`);
          return;
        }
        const { task, origin } = found;
        ctx.print([
          `Task ${task.id}`,
          `  title: ${task.title}`,
          `  kind: ${task.kind}`,
          `  status: ${task.status}`,
          `  owner: ${task.owner}`,
          `  runs on: ${origin === 'local' ? 'this terminal' : 'the daemon'}`,
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
                  `  worktrees: ${worktrees.total} tracked (${worktrees.active} active / ${worktrees.paused} paused / ${worktrees.pendingCleanup} cleanup)`,
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
        const found = await tasksClient.get(taskId);
        if (!found) {
          ctx.print(`Unknown task: ${taskId}`);
          return;
        }
        const { task } = found;
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
        // Created HERE on purpose: a task this command creates is one this
        // terminal's loop is expected to drive, so it belongs in the registry
        // that drives it. Submitting work TO the daemon is what /schedule and
        // the channel surfaces do.
        const task = opsApi.tasks.create({
          kind: kind as import('@/runtime/index.ts').TaskKind,
          owner,
          title,
          description: title,
        });
        ctx.print(`Created task ${task.id} (${task.kind}) for ${task.owner}.`);
        return;
      }

      const taskId = args[1];
      if (!taskId) {
        ctx.print(subcommand === 'update'
          ? 'Usage: /tasks update <taskId> <title|description|result> <value...>'
          : `Usage: /tasks ${subcommand} <taskId> [note]`);
        return;
      }

      // Which registry owns this id decides what may be done to it. An act
      // aimed at a daemon task must never be applied to a local record that
      // does not exist — that reports success and changes nothing.
      const found = await tasksClient.get(taskId);
      if (!found) {
        ctx.print(`Unknown task: ${taskId}`);
        return;
      }

      if (found.origin === 'daemon') {
        if (LOCAL_ONLY_ACTS.has(subcommand)) {
          ctx.print(refuseDaemonOwnedAct(taskId, subcommand));
          return;
        }
        try {
          switch (subcommand) {
            case 'cancel':
              await tasksClient.cancel(taskId);
              ctx.print(`Cancelled task ${taskId} on the daemon.`);
              return;
            case 'retry':
              await tasksClient.retry(taskId);
              ctx.print(`Re-queued task ${taskId} on the daemon.`);
              return;
            default:
              ctx.print(`Unknown tasks subcommand: ${subcommand}`);
              return;
          }
        } catch (error) {
          ctx.print(summarizeError(error));
          return;
        }
      }

      const opsApi = requireOpsApi(ctx);
      try {
        if (subcommand === 'update') {
          const field = args[2];
          const value = args.slice(3).join(' ').trim();
          if (!field || !value) {
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
          opsApi.tasks.complete(taskId, args.slice(2).join(' ').trim() || undefined);
          ctx.print(`Completed task ${taskId}.`);
          return;
        }
        if (subcommand === 'fail') {
          const errorText = args.slice(2).join(' ').trim();
          if (!errorText) {
            ctx.print('Usage: /tasks fail <taskId> <error...>');
            return;
          }
          opsApi.tasks.fail(taskId, { error: errorText });
          ctx.print(`Failed task ${taskId}.`);
          return;
        }
        const note = args.slice(2).join(' ').trim() || undefined;
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
