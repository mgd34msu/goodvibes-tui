import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { AgentMessageBus } from '@pellux/goodvibes-sdk/platform/agents';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { AgentManager } from '@pellux/goodvibes-sdk/platform/tools';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('Agent lifecycle integration', () => {
  function createManager(): AgentManager {
    const root = makeProjectTempDir('gv-agent-lifecycle');
    const configDir = join(root, 'config');
    const configManager = new ConfigManager({
      surfaceRoot: 'tui',
      configDir,
      workingDir: root,
      homeDir: root,
    });
    return new AgentManager({
      configManager,
      messageBus: new AgentMessageBus(),
    });
  }

  test('spawn returns a pending record with a valid ID', () => {
    const manager = createManager();
    const record = manager.spawn({ mode: 'spawn', task: 'Stuck task' });
    expect(record.status).toBe('pending');
    expect(record.id).toMatch(/^agent-[0-9a-f]{8}$/);
    expect(record.task).toBe('Stuck task');
  });

  test('multiple spawned records remain independently addressable', () => {
    const manager = createManager();
    const a = manager.spawn({ mode: 'spawn', task: 'Task A' });
    const b = manager.spawn({ mode: 'spawn', task: 'Task B' });
    const c = manager.spawn({ mode: 'spawn', task: 'Task C' });

    expect(a.id).not.toBe(b.id);
    expect(b.id).not.toBe(c.id);
    expect(manager.getStatus(a.id)?.task).toBe('Task A');
    expect(manager.getStatus(b.id)?.task).toBe('Task B');
    expect(manager.getStatus(c.id)?.task).toBe('Task C');
  });

  test('list reflects spawned agents', () => {
    const manager = createManager();
    manager.spawn({ mode: 'spawn', task: 'List test A' });
    manager.spawn({ mode: 'spawn', task: 'List test B' });

    const agents = manager.list();
    expect(agents).toHaveLength(2);
    expect(agents.every((record) => typeof record.id === 'string')).toBe(true);
    expect(agents.every((record) => typeof record.task === 'string')).toBe(true);
  });

  test('cancel transitions a pending agent to cancelled', () => {
    const manager = createManager();
    const record = manager.spawn({ mode: 'spawn', task: 'Stuck task' });
    expect(manager.cancel(record.id)).toBe(true);
    expect(manager.getStatus(record.id)?.status).toBe('cancelled');
  });

  test('cancel returns false for unknown agents', () => {
    const manager = createManager();
    expect(manager.cancel('agent-nonexistent')).toBe(false);
  });
});
