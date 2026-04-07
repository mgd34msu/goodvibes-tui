import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskTool } from '../../tools/task/index.ts';
import { teamTool } from '../../tools/team/index.ts';
import { worklistTool } from '../../tools/worklist/index.ts';
import { briefTool } from '../../tools/brief/index.ts';
import { questionTool } from '../../tools/question/index.ts';
import { remoteTool } from '../../tools/remote-trigger/index.ts';
import { replTool } from '../../tools/repl/index.ts';
import { mcpResourceTool } from '../../tools/mcp-resource/index.ts';
import { controlTool } from '../../tools/control/index.ts';
import { powershellTool } from '../../tools/powershell/index.ts';
import { _resetForTesting as resetSessionOrchestration } from '../../sessions/orchestration/registry.ts';
import { _resetRemoteRunnerRegistryForTesting, getRemoteRunnerRegistry } from '../../runtime/remote/runner-registry.ts';

describe('tool breadth additions', () => {
  const originalCwd = process.cwd();
  let root = '';

  beforeEach(() => {
    resetSessionOrchestration();
    _resetRemoteRunnerRegistryForTesting();
    root = mkdtempSync(join(tmpdir(), 'gv-tool-breadth-'));
    process.chdir(root);
  });

  afterEach(() => {
    resetSessionOrchestration();
    _resetRemoteRunnerRegistryForTesting();
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
  });

  test('team tool persists team definitions and role lanes', async () => {
    const created = await teamTool.execute({ mode: 'create', teamId: 'release-core', name: 'Release Core', summary: 'Owns certification and rollout' });
    expect(created.success).toBe(true);

    const added = await teamTool.execute({ mode: 'add-member', teamId: 'release-core', memberId: 'agent-review', role: 'reviewer', lanes: ['wrfc', 'security'] });
    expect(added.success).toBe(true);
    expect(added.output).toContain('agent-review');

    const lanes = await teamTool.execute({ mode: 'set-lanes', teamId: 'release-core', memberId: 'agent-review', lanes: ['wrfc', 'release'] });
    expect(lanes.success).toBe(true);
    expect(lanes.output).toContain('release');

    const listed = await teamTool.execute({ mode: 'list' });
    expect(listed.success).toBe(true);
    expect(listed.output).toContain('Release Core');

    expect(existsSync(join(root, '.goodvibes', 'tui', 'teams.json'))).toBe(true);
    expect(readFileSync(join(root, '.goodvibes', 'tui', 'teams.json'), 'utf-8')).toContain('release-core');
  });

  test('worklist tool persists checklist items and lifecycle changes', async () => {
    const created = await worklistTool.execute({ mode: 'create', worklistId: 'roadmap-2', title: 'Roadmap v2 closure' });
    expect(created.success).toBe(true);

    const added = await worklistTool.execute({
      mode: 'add-item',
      worklistId: 'roadmap-2',
      itemId: 'item-1',
      text: 'Finish bridge productization',
      owner: 'ops',
      priority: 'high',
    });
    expect(added.success).toBe(true);
    expect(added.output).toContain('Finish bridge productization');

    const completed = await worklistTool.execute({ mode: 'complete-item', worklistId: 'roadmap-2', itemId: 'item-1' });
    expect(completed.success).toBe(true);
    expect(completed.output).toContain('"status":"done"');

    const reopened = await worklistTool.execute({ mode: 'reopen-item', worklistId: 'roadmap-2', itemId: 'item-1' });
    expect(reopened.success).toBe(true);
    expect(reopened.output).toContain('"status":"open"');

    const listed = await worklistTool.execute({ mode: 'list' });
    expect(listed.success).toBe(true);
    expect(listed.output).toContain('roadmap-2');
  });

  test('brief and question tools manage durable operator packets and Q&A', async () => {
    const brief = await briefTool.execute({
      mode: 'create',
      briefId: 'bridge-rollout',
      title: 'Bridge rollout',
      summary: 'Roll out the self-hosted bridge path.',
      goals: ['runner pools', 'artifact review'],
      constraints: ['no SaaS'],
      risks: ['mis-scoped trust'],
    });
    expect(brief.success).toBe(true);
    expect(brief.output).toContain('bridge-rollout');

    const publish = await briefTool.execute({ mode: 'publish', briefId: 'bridge-rollout' });
    expect(publish.success).toBe(true);
    expect(publish.output).toContain('"status":"published"');

    const question = await questionTool.execute({
      mode: 'ask',
      questionId: 'q-1',
      prompt: 'Should remote pools inherit parent trust?',
      askedBy: 'operator',
      target: 'security-review',
    });
    expect(question.success).toBe(true);

    const answer = await questionTool.execute({
      mode: 'answer',
      questionId: 'q-1',
      answer: 'Yes, but only as an upper capability ceiling.',
    });
    expect(answer.success).toBe(true);
    expect(answer.output).toContain('upper capability ceiling');
  });

  test('remote tool manages pools, contracts, artifacts, and review', async () => {
    const registry = getRemoteRunnerRegistry();
    registry.registerContract({
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
  });

  test('repl tool evaluates bounded expressions and records history', async () => {
    const result = await replTool.execute({ mode: 'eval', expression: 'Math.max(a, b)', bindings: { a: 2, b: 5 } });
    expect(result.success).toBe(true);
    expect(result.output).toBe('5');

    const history = await replTool.execute({ mode: 'history' });
    expect(history.success).toBe(true);
    expect(history.output).toContain('Math.max(a, b)');
  });

  test('mcp resource tool reports current MCP posture', async () => {
    const security = await mcpResourceTool.execute({ mode: 'security' });
    expect(security.success).toBe(true);
    expect(security.output).toContain('recentDecisions');

    const auth = await mcpResourceTool.execute({ mode: 'auth' });
    expect(auth.success).toBe(true);
    expect(auth.output).toContain('servers');

    const resources = await mcpResourceTool.execute({ mode: 'resources' });
    expect(resources.success).toBe(true);
    expect(resources.output).toContain('servers');
  });

  test('control tool reports packaged product-control breadth', async () => {
    const commands = await controlTool.execute({ mode: 'commands' });
    expect(commands.success).toBe(true);
    expect(commands.output).toContain('marketplace');

    const presets = await controlTool.execute({ mode: 'sandbox-presets' });
    expect(presets.success).toBe(true);
    expect(presets.output).toContain('secure-balanced');
  });

  test('powershell tool reports availability without requiring pwsh on every host', async () => {
    const availability = await powershellTool.execute({ mode: 'availability' });
    expect(availability.success).toBe(true);
    expect(availability.output).toContain('available');
  });
});
