/**
 * /ops interventions — live proof of the operator control-plane path.
 *
 * This surface shipped dead for three months: OpsControlPlane construction
 * was gated on 'operator-control-plane', an id never registered in any SDK
 * registry, so isEnabled was permanently false, /ops task|agent always
 * errored, and the Ops Control panel never left its not-configured state.
 * The gate now rides the real control-plane gateway capability
 * (controlPlane.gateway, enabled in a stock configuration).
 *
 * These tests treat the whole path as previously unproven:
 *   - the gate derives honestly from controlPlane.gateway (on by default,
 *     off when the key is off);
 *   - the /ops command family performs real interventions through
 *     createRuntimeOpsApi + OpsControlPlane against a REAL task manager and
 *     runtime store (no mocks in the intervention path);
 *   - illegal actions and missing targets surface honest [Ops] errors;
 *   - bootstrap.ts gates on the registered capability id (drift gate so the
 *     permanently-false id can never return).
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { bindFeatureSettingsBridge, deriveFeatureStates } from '@pellux/goodvibes-sdk/platform/runtime/state';
import {
  OpsControlPlane,
  RuntimeEventBus,
  createFeatureFlagManager,
  createRuntimeOpsApi,
  createTaskManager,
} from '@/runtime/index.ts';
import { createRuntimeStore, createDomainDispatch } from '../../runtime/store/index.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { registerOperatorRuntimeCommands } from '../../input/commands/operator-runtime.ts';

const SESSION_ID = 'ops-proof-session';

function makeEnv() {
  const store = createRuntimeStore();
  const bus = new RuntimeEventBus();
  const dispatch = createDomainDispatch(store);
  const taskManager = createTaskManager(store, bus, SESSION_ID);
  const opsControlPlane = new OpsControlPlane(taskManager, bus, store, SESSION_ID);
  const opsApi = createRuntimeOpsApi({
    // Read model: a thin live projection of the real store (reads are not
    // under test here; the intervention path is).
    tasksReadModel: {
      getSnapshot: () => ({
        tasks: [...store.getState().tasks.tasks.values()],
        updatedAt: Date.now(),
      }) as never,
    },
    taskManager,
    opsControlPlane,
  });

  const printed: string[] = [];
  const registry = new CommandRegistry();
  registerOperatorRuntimeCommands(registry);
  const ctx = {
    print: (text: string) => { printed.push(text); },
    clients: { opsApi },
    ops: {},
    platform: {},
    session: {},
  } as unknown as CommandContext;
  const run = async (line: string): Promise<void> => {
    const [name, ...args] = line.split(' ');
    const command = registry.get(name!);
    if (!command) throw new Error(`command not registered: ${name}`);
    await command.handler(args, ctx);
  };

  return { store, bus, dispatch, taskManager, opsControlPlane, opsApi, printed, run };
}

describe('ops gate — control-plane gateway capability', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gv-ops-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  test('a stock configuration enables the gate; controlPlane.gateway=false disables it live', () => {
    const cm = new ConfigManager({ surfaceRoot: 'tui', workingDir: tmpDir, homeDir: tmpDir, configDir: join(tmpDir, '.goodvibes', 'global-tui') });
    const flags = createFeatureFlagManager();
    flags.loadFromConfig({ flags: deriveFeatureStates(cm) });
    bindFeatureSettingsBridge(cm, flags);

    expect(flags.isEnabled('control-plane-gateway')).toBe(true);
    cm.setDynamic('controlPlane.gateway', false);
    expect(flags.isEnabled('control-plane-gateway')).toBe(false);
    cm.setDynamic('controlPlane.gateway', true);
    expect(flags.isEnabled('control-plane-gateway')).toBe(true);

    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('bootstrap gates the ops control plane on the registered capability id, never the unregistered one', () => {
    const source = readFileSync(join(import.meta.dir, '..', '..', 'runtime', 'bootstrap.ts'), 'utf-8');
    expect(source).toContain("isEnabled('control-plane-gateway')");
    // The id that was never registered in any SDK registry (its gate was
    // permanently false) must not come back.
    expect(source.match(/isEnabled\('operator-control-plane'\)/)).toBeNull();
  });
});

describe('/ops task interventions — real task manager, real control plane', () => {
  test('pause blocks a running task, resume returns it to running', async () => {
    const env = makeEnv();
    const task = env.taskManager.createTask({ kind: 'exec', title: 'long run', owner: 'test', cancellable: true });
    env.taskManager.startTask(task.id);
    expect(env.taskManager.getTask(task.id)?.status).toBe('running');

    await env.run(`ops task pause ${task.id} operator pause note`);
    expect(env.taskManager.getTask(task.id)?.status).toBe('blocked');
    expect(env.printed.some((line) => line.includes(`Task ${task.id}: pause dispatched.`))).toBe(true);

    await env.run(`ops task resume ${task.id}`);
    expect(env.taskManager.getTask(task.id)?.status).toBe('running');
    expect(env.printed.some((line) => line.includes(`Task ${task.id}: resume dispatched.`))).toBe(true);
  });

  test('cancel moves a queued task to cancelled and the store agrees', async () => {
    const env = makeEnv();
    const task = env.taskManager.createTask({ kind: 'exec', title: 'doomed', owner: 'test', cancellable: true });

    await env.run(`ops task cancel ${task.id} not needed anymore`);
    expect(env.taskManager.getTask(task.id)?.status).toBe('cancelled');
    expect(env.store.getState().tasks.tasks.get(task.id)?.status).toBe('cancelled');
    expect(env.printed.some((line) => line.includes(`Task ${task.id}: cancel dispatched.`))).toBe(true);
  });

  test('retry revives a failed task', async () => {
    const env = makeEnv();
    const task = env.taskManager.createTask({ kind: 'exec', title: 'flaky', owner: 'test', cancellable: true });
    env.taskManager.startTask(task.id);
    env.taskManager.failTask(task.id, { error: 'boom' });
    expect(env.taskManager.getTask(task.id)?.status).toBe('failed');

    await env.run(`ops task retry ${task.id}`);
    const revived = env.taskManager.getTask(task.id)?.status;
    expect(revived === 'queued' || revived === 'running').toBe(true);
    expect(env.printed.some((line) => line.includes(`Task ${task.id}: retry dispatched.`))).toBe(true);
  });

  test('an illegal action surfaces an honest [Ops] error, not a silent no-op', async () => {
    const env = makeEnv();
    const task = env.taskManager.createTask({ kind: 'exec', title: 'done already', owner: 'test', cancellable: true });
    env.taskManager.startTask(task.id);
    env.taskManager.completeTask(task.id, { summary: 'ok' });

    await env.run(`ops task cancel ${task.id}`);
    expect(env.taskManager.getTask(task.id)?.status).toBe('completed');
    expect(env.printed.some((line) => line.startsWith('[Ops] Error:'))).toBe(true);
  });

  test('a missing task id surfaces an honest [Ops] error', async () => {
    const env = makeEnv();
    await env.run('ops task pause task-that-never-existed');
    expect(env.printed.some((line) => line.startsWith('[Ops] Error:') && line.includes('task-that-never-existed'))).toBe(true);
  });
});

describe('/ops agent interventions', () => {
  test('cancel transitions a live agent record to cancelled', async () => {
    const env = makeEnv();
    env.dispatch.dispatchAgentEvent({
      type: 'AGENT_SPAWNING',
      agentId: 'agent-live-1',
      task: 'demo work',
      timestamp: Date.now(),
    } as never);
    expect(env.store.getState().agents.agents.get('agent-live-1')?.status).toBe('spawning');

    await env.run('ops agent cancel agent-live-1 no longer needed');
    expect(env.store.getState().agents.agents.get('agent-live-1')?.status).toBe('cancelled');
    expect(env.printed.some((line) => line.includes('Agent agent-live-1: cancel dispatched.'))).toBe(true);
  });

  test('a missing agent id surfaces an honest [Ops] error', async () => {
    const env = makeEnv();
    await env.run('ops agent cancel agent-that-never-existed');
    expect(env.printed.some((line) => line.startsWith('[Ops] Error:') && line.includes('agent-that-never-existed'))).toBe(true);
  });
});
