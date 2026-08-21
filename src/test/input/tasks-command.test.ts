import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeOpsApi } from '@/runtime/index.ts';
import { createTaskManager } from '@/runtime/index.ts';
import { OpsControlPlane } from '@/runtime/index.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { createFeatureFlagManager, deriveFeatureStates, type FeatureFlagManager } from '@/runtime/index.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { createTasksReadModel } from '../helpers/ui-read-models.ts';
import type { OperatorClient } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

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

  // ---------------------------------------------------------------------------
  // runtime.unifiedTasks, driven to BOTH values through the real gate, via the
  // actual /tasks create command path.
  //
  // This setting used to configure nothing: bootstrap.ts built its
  // opsTaskManager with createTaskManager's 3-arg form (no featureFlags), and
  // isFeatureGateEnabled is permissive when no manager is wired, so omitting
  // it did not disable task tracking when runtime.unifiedTasks was turned
  // off. Unlike the other five classes in this sweep, this key's schema
  // default was ALSO wrong (recorded false while every install always
  // shipped enabled, because of this exact gap), the SDK has corrected the
  // default to true/enabled, and bootstrap.ts now threads featureFlags, the
  // same shape as the other five fixes.
  //
  // The mutation check for this row: remove that argument and the "off" half
  // of the first test below fails, because the manager falls back to
  // permissive and creates the task anyway.
  // ---------------------------------------------------------------------------

  function featureFlagsFor(root: string, unifiedTasks: boolean): FeatureFlagManager {
    const configManager = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'tui') });
    configManager.set('runtime.unifiedTasks', unifiedTasks);
    const featureFlags = createFeatureFlagManager();
    featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
    return featureFlags;
  }

  test('runtime.unifiedTasks false turns off /tasks create, and it refuses', async () => {
    const root = makeProjectTempDir('gv-unified-tasks-gate');
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const tasksCommand = registry.get('tasks');
    expect(tasksCommand).toBeDefined();

    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    // Constructed exactly as runtime/bootstrap.ts constructs it.
    const taskManager = createTaskManager(store, bus, 'sess-tasks-gate-off', featureFlagsFor(root, false));
    const opsApi = createRuntimeOpsApi({
      tasksReadModel: createTasksReadModel(store),
      taskManager,
      opsControlPlane: new OpsControlPlane(taskManager, bus, store, 'sess-tasks-gate-off'),
    });
    const readModels = { tasks: createTasksReadModel(store) } as never;
    const out: string[] = [];
    const ctx = makeTaskCommandContext(out, readModels, {}, {
      operator: createOperatorTaskClient(readModels),
      opsApi,
    });
    ctx.session.runtime.sessionId = 'sess-tasks-gate-off';

    let refusal = '';
    try {
      await tasksCommand!.handler(['create', 'integration', 'release-bot', 'Prepare', 'release', 'bundle'], ctx);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain('runtime.unifiedTasks');
    expect(taskManager.getTasksByKind('integration')).toEqual([]);
  });

  test('runtime.unifiedTasks true allows /tasks create, and is the shipped default', async () => {
    const root = makeProjectTempDir('gv-unified-tasks-gate');
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const tasksCommand = registry.get('tasks');

    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    const taskManager = createTaskManager(store, bus, 'sess-tasks-gate-on', featureFlagsFor(root, true));
    const opsApi = createRuntimeOpsApi({
      tasksReadModel: createTasksReadModel(store),
      taskManager,
      opsControlPlane: new OpsControlPlane(taskManager, bus, store, 'sess-tasks-gate-on'),
    });
    const readModels = { tasks: createTasksReadModel(store) } as never;
    const out: string[] = [];
    const ctx = makeTaskCommandContext(out, readModels, {}, {
      operator: createOperatorTaskClient(readModels),
      opsApi,
    });
    ctx.session.runtime.sessionId = 'sess-tasks-gate-on';

    await tasksCommand!.handler(['create', 'integration', 'release-bot', 'Prepare', 'release', 'bundle'], ctx);
    expect(out.join('\n')).toContain('Created task');

    // The default half: with the key never written, effective behaviour
    // matches true. This is what makes threading featureFlags a fix that
    // changes only whether the switch WORKS, not what an existing install does.
    // A genuinely fresh root (not `root`, which already has runtime.unifiedTasks
    // written under it), ConfigManager's project tier is keyed by
    // workingDir/surfaceRoot regardless of configDir, so reusing `root` here
    // would read back the write above instead of the real default.
    const unsetRoot = makeProjectTempDir('gv-unified-tasks-gate-unset');
    const unsetConfig = new ConfigManager({ surfaceRoot: 'tui', workingDir: unsetRoot, homeDir: unsetRoot, configDir: join(unsetRoot, '.goodvibes', 'unset') });
    expect(unsetConfig.get('runtime.unifiedTasks')).toBe(true);
    const flags = createFeatureFlagManager();
    flags.loadFromConfig({ flags: deriveFeatureStates(unsetConfig) });
    const unsetStore = createRuntimeStore();
    const unsetManager = createTaskManager(unsetStore, new RuntimeEventBus(), 'sess-tasks-gate-unset', flags);
    const unsetTask = unsetManager.createTask({ kind: 'exec', title: 'Unset default check', owner: 'test' });
    expect(unsetTask.status).toBe('queued');
  });
});
