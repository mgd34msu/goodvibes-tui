import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { RuntimeEventBus } from '../../runtime/events/index.ts';
import { createRuntimeOpsApi } from '../../runtime/runtime-ops-api.ts';
import { createTaskManager } from '../../runtime/tasks/index.ts';
import { OpsControlPlane } from '../../runtime/ops/control-plane.ts';
import { createShellPathService } from '../../runtime/shell-paths.ts';
import { createTasksReadModel } from '../helpers/ui-read-models.ts';
import type { OperatorClient } from '../../runtime/operator-client.ts';

const shellPaths = createShellPathService({
  workingDirectory: '/tmp/goodvibes-test',
  homeDirectory: '/tmp/goodvibes-home',
});

function makeTaskCommandContext(
  out: string[],
  readModels: CommandContext['platform']['readModels'],
  ops: Partial<CommandContext['ops']> = {},
  clients: CommandContext['clients'] = {},
): CommandContext {
  const providerRegistry = {} as never;
  const conversationManager = {} as never;
  const configManager = {} as never;
  return {
    session: {
      conversationManager,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-tasks',
      },
    },
    provider: {
      providerRegistry,
    },
    workspace: {
      shellPaths,
    },
    platform: {
      config: {} as never,
      configManager,
      readModels,
    },
    ops,
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
    },
    clients,
    renderRequest: () => {},
    print: (text: string) => { out.push(text); },
    exit: () => {},
  };
}

function createOperatorTaskClient(
  readModels: CommandContext['platform']['readModels'],
): OperatorClient {
  return {
    sessions: {} as never,
    approvals: {} as never,
    providers: {} as never,
    controlPlane: {} as never,
    events: {} as never,
    shellPaths,
    tasks: {
      snapshot: () => requireTasksReadModel(readModels).getSnapshot(),
      list: (limit = 100) => requireTasksReadModel(readModels).getSnapshot().tasks.slice(0, limit),
      get: (taskId) => requireTasksReadModel(readModels).getSnapshot().tasks.find((task) => task.id === taskId) ?? null,
      running: () => requireTasksReadModel(readModels).getSnapshot().tasks.filter((task) => task.status === 'running'),
    },
  };
}

function requireTasksReadModel(
  readModels: CommandContext['platform']['readModels'],
): NonNullable<CommandContext['platform']['readModels']>['tasks'] {
  const tasks = readModels?.tasks;
  if (!tasks) {
    throw new Error('tasks read model is required for task command tests');
  }
  return tasks;
}

describe('tasks command', () => {
  test('lists, shows, and outputs runtime tasks', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const tasksCommand = registry.get('tasks');
    expect(tasksCommand).toBeDefined();

    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    const taskManager = createTaskManager(store, bus, 'sess-tasks');
    const task = taskManager.createTask({
      kind: 'integration',
      title: 'Publish release evidence',
      description: 'Publish release evidence bundle',
      owner: 'release',
    });
    taskManager.startTask(task.id);
    taskManager.completeTask(task.id, { ok: true, artifactId: 'artifact-1' });

    const out: string[] = [];
    const opsApi = createRuntimeOpsApi({
      tasksReadModel: createTasksReadModel(store),
      taskManager,
      opsControlPlane: new OpsControlPlane(taskManager, bus, store, 'sess-tasks'),
    });
    const readModels = {
      tasks: createTasksReadModel(store),
    } as never;
    const ctx = makeTaskCommandContext(out, readModels, {
    }, {
      operator: createOperatorTaskClient(readModels),
      opsApi,
    });

    await tasksCommand!.handler(['list'], ctx);
    expect(out.join('\n')).toContain('Runtime Tasks');
    expect(out.join('\n')).toContain('Publish release evidence');

    out.length = 0;
    await tasksCommand!.handler(['show', task.id], ctx);
    expect(out.join('\n')).toContain(`Task ${task.id}`);
    expect(out.join('\n')).toContain('kind: integration');

    out.length = 0;
    await tasksCommand!.handler(['output', task.id], ctx);
    expect(out.join('\n')).toContain('artifact-1');
  });

  test('routes task interventions through the ops control plane', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const tasksCommand = registry.get('tasks');
    expect(tasksCommand).toBeDefined();

    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    const taskManager = createTaskManager(store, bus, 'sess-tasks');
    const plane = new OpsControlPlane(taskManager, bus, store, 'sess-tasks');
    const task = taskManager.createTask({
      kind: 'exec',
      title: 'Run verification',
      owner: 'shell',
    });
    taskManager.startTask(task.id);

    const out: string[] = [];
    const opsApi = createRuntimeOpsApi({
      tasksReadModel: createTasksReadModel(store),
      taskManager,
      opsControlPlane: plane,
    });
    const readModels = {
      tasks: createTasksReadModel(store),
    } as never;
    const ctx = makeTaskCommandContext(out, readModels, {
    }, {
      operator: createOperatorTaskClient(readModels),
      opsApi,
    });

    await tasksCommand!.handler(['pause', task.id, 'waiting', 'for', 'approval'], ctx);
    expect(taskManager.getTask(task.id)?.status).toBe('blocked');
    expect(out.join('\n')).toContain(`Paused task ${task.id}.`);

    out.length = 0;
    await tasksCommand!.handler(['resume', task.id], ctx);
    expect(taskManager.getTask(task.id)?.status).toBe('running');
    expect(out.join('\n')).toContain(`Resumed task ${task.id}.`);

    out.length = 0;
    await tasksCommand!.handler(['cancel', task.id], ctx);
    expect(taskManager.getTask(task.id)?.status).toBe('cancelled');
    expect(out.join('\n')).toContain(`Cancelled task ${task.id}.`);
  });

  test('supports explicit task creation, update, completion, and failure flows', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const tasksCommand = registry.get('tasks');
    expect(tasksCommand).toBeDefined();

    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    const taskManager = createTaskManager(store, bus, 'sess-task-crud');

    const out: string[] = [];
    const opsApi = createRuntimeOpsApi({
      tasksReadModel: createTasksReadModel(store),
      taskManager,
      opsControlPlane: new OpsControlPlane(taskManager, bus, store, 'sess-task-crud'),
    });
    const readModels = {
      tasks: createTasksReadModel(store),
    } as never;
    const ctx = makeTaskCommandContext(out, readModels, {
    }, {
      operator: createOperatorTaskClient(readModels),
      opsApi,
    });
    ctx.session.runtime.sessionId = 'sess-task-crud';

    await tasksCommand!.handler(['create', 'integration', 'release-bot', 'Prepare', 'release', 'bundle'], ctx);
    expect(out.join('\n')).toContain('Created task');
    const createdId = out.join('\n').match(/[0-9a-f-]{36}/)?.[0];
    expect(createdId).toBeDefined();
    const createdTask = taskManager.getTask(createdId!);
    expect(createdTask?.title).toBe('Prepare release bundle');

    out.length = 0;
    await tasksCommand!.handler(['update', createdId!, 'description', 'Publish', 'and', 'verify', 'bundle'], ctx);
    expect(out.join('\n')).toContain(`Updated task ${createdId!} field description.`);
    expect(taskManager.getTask(createdId!)?.description).toBe('Publish and verify bundle');

    taskManager.startTask(createdId!);
    out.length = 0;
    await tasksCommand!.handler(['complete', createdId!, 'bundle-ready'], ctx);
    expect(out.join('\n')).toContain(`Completed task ${createdId!}.`);
    expect(taskManager.getTask(createdId!)?.status).toBe('completed');

    const failedTask = taskManager.createTask({
      kind: 'exec',
      title: 'Run broken verification',
      owner: 'shell',
    });
    taskManager.startTask(failedTask.id);
    out.length = 0;
    await tasksCommand!.handler(['fail', failedTask.id, 'lint', 'failed'], ctx);
    expect(out.join('\n')).toContain(`Failed task ${failedTask.id}.`);
    expect(taskManager.getTask(failedTask.id)?.status).toBe('failed');
  });
});
