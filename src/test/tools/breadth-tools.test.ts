import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTaskTool } from '@pellux/goodvibes-sdk/platform/tools';
import { createTeamTool } from '@pellux/goodvibes-sdk/platform/tools';
import { createWorklistTool } from '@pellux/goodvibes-sdk/platform/tools';
import { createPacketTool } from '@pellux/goodvibes-sdk/platform/tools';
import { createQueryTool } from '@pellux/goodvibes-sdk/platform/tools';
import { createRemoteTool } from '@pellux/goodvibes-sdk/platform/tools';
import { controlTool } from '@pellux/goodvibes-sdk/platform/tools';
import { CrossSessionTaskRegistry } from '@pellux/goodvibes-sdk/platform/sessions';
import { trackDisposables } from '../helpers/disposables.ts';
import { RemoteRunnerRegistry } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// CrossSessionTaskRegistry starts an hourly sweep in its constructor;
// dispose() clears it.
const disposables = trackDisposables();

describe('tool breadth additions', () => {
  const originalCwd = process.cwd();
  let root = '';
  // Task-ref ownership is the HOST's session identity, resolved per call — not
  // the model-supplied `sessionId` argument, which now only selects which
  // session's refs a list/show reads. Standing in as the host, this suite owns
  // 'sess-a', so its writes and its reads agree.
  let taskTool = createTaskTool(
    disposables.add(new CrossSessionTaskRegistry(makeProjectTempDir('gv-tool-breadth-init'))),
    { resolveSessionId: () => 'sess-a' },
  );
  const teamTool = createTeamTool({ surfaceRoot: 'tui' });
  const worklistTool = createWorklistTool({ surfaceRoot: 'tui' });

  function taskGraphPath(baseRoot: string): string {
    return join(baseRoot, '.goodvibes', 'tui', 'sessions', 'task-graph.json');
  }

  beforeEach(() => {
    root = makeProjectTempDir('gv-tool-breadth');
    process.chdir(root);
    taskTool = createTaskTool(disposables.add(new CrossSessionTaskRegistry(taskGraphPath(root))), { resolveSessionId: () => 'sess-a' });
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  test('task tool manages durable task refs, dependencies, status, and handoffs', async () => {
    const create = await taskTool.execute({ mode: 'create', sessionId: 'sess-a', taskId: 'task-1', title: 'Implement remote runner pool' });
    expect(create.success).toBe(true);

    const list = await taskTool.execute({ mode: 'list', sessionId: 'sess-a' });
    expect(list.success).toBe(true);
    expect(list.output).toContain('"count":1');

    await taskTool.execute({ mode: 'create', sessionId: 'sess-a', taskId: 'task-2', title: 'Review pool policy' });
    const depend = await taskTool.execute({ mode: 'depend', sessionId: 'sess-a', taskId: 'task-2', dependsOnTaskId: 'task-1', reason: 'review after implementation' });
    expect(depend.success).toBe(true);
    expect(depend.output).toContain('task-1');

    const status = await taskTool.execute({ mode: 'status', sessionId: 'sess-a', taskId: 'task-1', status: 'running' });
    expect(status.success).toBe(true);
    expect(status.output).toContain('"status":"running"');

    const handoff = await taskTool.execute({ mode: 'handoff', sessionId: 'sess-a', taskId: 'task-1', toSessionId: 'sess-b', reason: 'remote certification' });
    expect(handoff.success).toBe(true);

    const handoffs = await taskTool.execute({ mode: 'handoffs' });
    expect(handoffs.success).toBe(true);
    expect(handoffs.output).toContain('"toSessionId":"sess-b"');

    const summaryList = await taskTool.execute({ mode: 'list', sessionId: 'sess-a', view: 'summary' });
    expect(summaryList.success).toBe(true);
    expect(summaryList.output).toContain('"title":"Implement remote runner pool"');
  });

  test('team tool persists team definitions and role lanes', async () => {
    const created = await teamTool.execute({ storageRoot: root, mode: 'create', teamId: 'release-core', name: 'Release Core', summary: 'Owns certification and rollout' });
    expect(created.success).toBe(true);

    const added = await teamTool.execute({ storageRoot: root, mode: 'add-member', teamId: 'release-core', memberId: 'agent-review', role: 'reviewer', lanes: ['wrfc', 'security'] });
    expect(added.success).toBe(true);
    expect(added.output).toContain('agent-review');

    const lanes = await teamTool.execute({ storageRoot: root, mode: 'set-lanes', teamId: 'release-core', memberId: 'agent-review', lanes: ['wrfc', 'release'] });
    expect(lanes.success).toBe(true);
    expect(lanes.output).toContain('release');

    const listed = await teamTool.execute({ storageRoot: root, mode: 'list' });
    expect(listed.success).toBe(true);
    expect(listed.output).toContain('Release Core');

    const summary = await teamTool.execute({ storageRoot: root, mode: 'show', teamId: 'release-core', view: 'summary' });
    expect(summary.success).toBe(true);
    expect(summary.output).toContain('"memberCount":1');

    expect(existsSync(join(root, '.goodvibes', 'tui', 'teams.json'))).toBe(true);
    expect(readFileSync(join(root, '.goodvibes', 'tui', 'teams.json'), 'utf-8')).toContain('release-core');
  });

  test('worklist tool persists checklist items and lifecycle changes', async () => {
    const created = await worklistTool.execute({ storageRoot: root, mode: 'create', worklistId: 'roadmap-2', title: 'Roadmap v2 closure' });
    expect(created.success).toBe(true);

    const added = await worklistTool.execute({
      storageRoot: root,
      mode: 'add-item',
      worklistId: 'roadmap-2',
      itemId: 'item-1',
      text: 'Finish bridge productization',
      owner: 'ops',
      priority: 'high',
    });
    expect(added.success).toBe(true);
    expect(added.output).toContain('Finish bridge productization');

    const completed = await worklistTool.execute({ storageRoot: root, mode: 'complete-item', worklistId: 'roadmap-2', itemId: 'item-1' });
    expect(completed.success).toBe(true);
    expect(completed.output).toContain('"status":"done"');

    const reopened = await worklistTool.execute({ storageRoot: root, mode: 'reopen-item', worklistId: 'roadmap-2', itemId: 'item-1' });
    expect(reopened.success).toBe(true);
    expect(reopened.output).toContain('"status":"open"');

    const listed = await worklistTool.execute({ storageRoot: root, mode: 'list' });
    expect(listed.success).toBe(true);
    expect(listed.output).toContain('roadmap-2');

    const summary = await worklistTool.execute({ storageRoot: root, mode: 'show', worklistId: 'roadmap-2', view: 'summary' });
    expect(summary.success).toBe(true);
    expect(summary.output).toContain('"itemCount":1');
  });

  test('team and worklist tools require explicit storage roots', async () => {
    const teamResult = await teamTool.execute({ mode: 'list' });
    expect(teamResult.success).toBe(false);
    expect(teamResult.error).toContain('storageRoot');

    const worklistResult = await worklistTool.execute({ mode: 'list' });
    expect(worklistResult.success).toBe(false);
    expect(worklistResult.error).toContain('storageRoot');
  });

  test('packet and query tools manage durable operator packets and Q&A', async () => {
    const packetTool = createPacketTool(root);
    const queryTool = createQueryTool(root);

    const packet = await packetTool.execute({
      mode: 'create',
      packetId: 'bridge-rollout',
      title: 'Bridge rollout',
      summary: 'Roll out the self-hosted bridge path.',
      goals: ['runner pools', 'artifact review'],
      constraints: ['no SaaS'],
      risks: ['mis-scoped trust'],
    });
    expect(packet.success).toBe(true);
    expect(packet.output).toContain('bridge-rollout');

    const publish = await packetTool.execute({ mode: 'publish', packetId: 'bridge-rollout' });
    expect(publish.success).toBe(true);
    expect(publish.output).toContain('"status":"published"');

    const query = await queryTool.execute({
      mode: 'ask',
      queryId: 'q-1',
      prompt: 'Should remote pools inherit parent trust?',
      askedBy: 'operator',
      target: 'security-review',
    });
    expect(query.success).toBe(true);

    const answer = await queryTool.execute({
      mode: 'answer',
      queryId: 'q-1',
      answer: 'Yes, but only as an upper capability ceiling.',
    });
    expect(answer.success).toBe(true);
    expect(answer.output).toContain('upper capability ceiling');

    const packetList = await packetTool.execute({ mode: 'list', view: 'summary' });
    expect(packetList.success).toBe(true);
    expect(packetList.output).toContain('"packets"');

    const queryList = await queryTool.execute({ mode: 'list', view: 'summary' });
    expect(queryList.success).toBe(true);
    expect(queryList.output).toContain('"hasAnswer":true');
  });

  test('remote tool manages pools, contracts, artifacts, and review', async () => {
    const remoteRegistry = new RemoteRunnerRegistry({
      getStatus: () => null,
      list: () => [],
    });
    const remoteTool = createRemoteTool(remoteRegistry);
    remoteRegistry.registerContract({
      id: 'runner:remote-1',
      runnerId: 'remote-1',
      label: 'Remote engineer',
      sourceTransport: 'acp',
      trustClass: 'self-hosted-acp',
      template: 'engineer',
      capabilityCeiling: {
        allowedTools: ['read', 'write'],
        capabilityCeilingTools: ['read', 'write'],
        executionProtocol: 'gather-plan-apply',
        reviewMode: 'wrfc',
        communicationLane: 'parent-only',
        orchestrationDepth: 1,
        successCriteria: ['ship clean patch'],
        requiredEvidence: ['diff', 'tests'],
        writeScope: ['src/runtime/**'],
      },
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      transport: {
        state: 'connected',
        connectedAt: Date.now(),
        messageCount: 3,
        errorCount: 0,
      },
    });

    const pool = await remoteTool.execute({ mode: 'create-pool', poolId: 'remote-core', label: 'Remote Core' });
    expect(pool.success).toBe(true);

    const assigned = await remoteTool.execute({ mode: 'assign', poolId: 'remote-core', runnerId: 'remote-1' });
    expect(assigned.success).toBe(true);
    expect(assigned.output).toContain('remote-1');

    const contracts = await remoteTool.execute({ mode: 'contracts' });
    expect(contracts.success).toBe(true);
    expect(contracts.output).toContain('remote-1');

    const summaryPools = await remoteTool.execute({ mode: 'pools', view: 'summary' });
    expect(summaryPools.success).toBe(true);
    expect(summaryPools.output).toContain('"runnerCount":1');
  });

  test('control tool reports packaged product-control breadth', async () => {
    const commands = await controlTool.execute({ mode: 'commands' });
    expect(commands.success).toBe(true);
    expect(commands.output).toContain('marketplace');

    const presets = await controlTool.execute({ mode: 'sandbox-presets' });
    expect(presets.success).toBe(true);
    expect(presets.output).toContain('secure-balanced');
  });

});
