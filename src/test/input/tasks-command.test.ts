import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { RuntimeEventBus } from '../../runtime/events/index.ts';
import { createTaskManager } from '../../runtime/tasks/index.ts';
import { OpsControlPlane } from '../../runtime/ops/control-plane.ts';

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
    const ctx = {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-tasks',
      },
      renderRequest: () => {},
      print: (text: string) => { out.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      runtimeStore: store,
      opsControlPlane: new OpsControlPlane(taskManager, bus, store, 'sess-tasks'),
    };

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
    const ctx = {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-tasks',
      },
      renderRequest: () => {},
      print: (text: string) => { out.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      runtimeStore: store,
      opsControlPlane: plane,
    };

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
    const ctx = {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-task-crud',
      },
      renderRequest: () => {},
      print: (text: string) => { out.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      runtimeStore: store,
      taskManager,
      opsControlPlane: new OpsControlPlane(taskManager, bus, store, 'sess-task-crud'),
    };

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
