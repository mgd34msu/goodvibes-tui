/**
 * tasks-client.ts — `/tasks` shows every runtime task, not just this
 * terminal's.
 *
 * ── What `/tasks` used to read ────────────────────────────────────────────
 *
 * `ctx.clients.operator.tasks.list(500)` — a DirectTransport call straight into
 * this process's own task read model, answered synchronously because there was
 * no wire to cross. While the app hosted a daemon, that model held every task
 * on the machine.
 *
 * Now it holds this surface's own: the exec, agent and ACP tasks the loop here
 * spawned. The daemon holds its own set — scheduled work, channel-driven runs,
 * tasks other surfaces submitted — and a `/tasks` list that showed only the
 * local half would read as complete while omitting most of it.
 *
 * ── The union, and who wins ───────────────────────────────────────────────
 *
 * Local rows are AUTHORITATIVE for tasks this terminal owns: they are live, and
 * the lifecycle acts below (`update`, `complete`, `fail`, `pause`, `resume`)
 * reach a registry that is genuinely here. The daemon's rows fill in the rest.
 * A task carried by both — an id the local registry knows AND the daemon lists
 * — is shown from the local copy, which is the fresher one.
 *
 * ── Reading is allowed to be optimistic; writing is not ───────────────────
 *
 * A read that cannot reach the daemon degrades to the local half and says so
 * once, because a partial list of real tasks is more useful than an error page.
 * A WRITE against a task this surface does not own must not be attempted
 * locally: it would look like it worked and change nothing on the daemon that
 * actually runs the task. Those route to the daemon's verb where one exists
 * (`tasks.cancel`, `tasks.retry`) and refuse by name where one does not.
 *
 * The contract carries six task verbs — create, get, list, status, cancel,
 * retry. There is no wire verb for update/complete/fail/pause/resume, so those
 * are honestly refused for a daemon-owned task rather than silently applied to
 * a local record that does not exist.
 */
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { RuntimeTask } from '@/runtime/index.ts';
import type { DaemonVerbCaller } from './operator-endpoint.ts';

/** Where a task record came from — which decides what may be done to it. */
export type TaskOrigin = 'local' | 'daemon';

export interface UnionTask {
  readonly task: RuntimeTask;
  readonly origin: TaskOrigin;
}

export interface TasksUnionResult {
  readonly tasks: readonly UnionTask[];
  /**
   * Why the daemon's half is missing, when it is. `null` means the union is
   * complete — either the daemon answered, or none is configured and the local
   * set genuinely IS every task.
   */
  readonly daemonUnavailable: string | null;
}

/** The narrow local source: whatever already answers this surface's own tasks. */
export interface LocalTaskSource {
  list(limit: number): readonly RuntimeTask[];
  get(taskId: string): RuntimeTask | null;
}

export interface TasksClient {
  /** Local rows union the daemon's, deduped by id with local winning. */
  list(limit?: number): Promise<TasksUnionResult>;
  /** One task, local first, then the daemon. Null when neither has it. */
  get(taskId: string): Promise<UnionTask | null>;
  /** Cancel a daemon-owned task over `tasks.cancel`. */
  cancel(taskId: string): Promise<void>;
  /** Re-queue a daemon-owned task over `tasks.retry`. */
  retry(taskId: string): Promise<void>;
}

/** Read the task array off `tasks.list`, which wraps it beside its counters. */
function readTasks(payload: unknown): readonly RuntimeTask[] {
  if (Array.isArray(payload)) return payload as readonly RuntimeTask[];
  if (payload && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>)['tasks'];
    if (Array.isArray(value)) return value as readonly RuntimeTask[];
  }
  return [];
}

function readTask(payload: unknown): RuntimeTask | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nested = record['task'];
  if (nested && typeof nested === 'object') return nested as RuntimeTask;
  return typeof record['id'] === 'string' ? payload as RuntimeTask : null;
}

export function createTasksClient(deps: {
  readonly local: LocalTaskSource;
  readonly verbs: DaemonVerbCaller;
}): TasksClient {
  const requireDaemon = (taskId: string, action: string): void => {
    const probe = deps.verbs.probe();
    if (!probe.available) {
      throw new Error(`${taskId} is not a task this terminal owns, and ${probe.reason}`);
    }
    void action;
  };

  return {
    list: async (limit = 500) => {
      const localTasks = [...deps.local.list(limit)];
      const owned = new Set(localTasks.map((task) => task.id));
      const local: UnionTask[] = localTasks.map((task) => ({ task, origin: 'local' as const }));

      const probe = deps.verbs.probe();
      if (!probe.available) return { tasks: local, daemonUnavailable: probe.reason };
      try {
        const daemonTasks = readTasks(await deps.verbs.invoke('tasks.list', {}));
        return {
          tasks: [
            ...local,
            ...daemonTasks.filter((task) => !owned.has(task.id)).map((task) => ({ task, origin: 'daemon' as const })),
          ],
          daemonUnavailable: null,
        };
      } catch (error) {
        const reason = summarizeError(error);
        logger.debug('[tasks] the daemon\'s tasks could not be read', { error: reason });
        return { tasks: local, daemonUnavailable: reason };
      }
    },

    get: async (taskId) => {
      const localTask = deps.local.get(taskId);
      if (localTask) return { task: localTask, origin: 'local' };
      const probe = deps.verbs.probe();
      if (!probe.available) return null;
      try {
        const task = readTask(await deps.verbs.invoke('tasks.get', { taskId }));
        return task ? { task, origin: 'daemon' } : null;
      } catch (error) {
        logger.debug('[tasks] the daemon could not answer for this task', { taskId, error: summarizeError(error) });
        return null;
      }
    },

    cancel: async (taskId) => {
      requireDaemon(taskId, 'cancel');
      await deps.verbs.invoke('tasks.cancel', { taskId });
    },

    retry: async (taskId) => {
      requireDaemon(taskId, 'retry');
      await deps.verbs.invoke('tasks.retry', { taskId });
    },
  };
}
