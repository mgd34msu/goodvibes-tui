import { beforeEach, describe, expect, test, mock } from 'bun:test';
import type { AgentManager } from '@pellux/goodvibes-sdk/platform/tools';
import { getTestAgentManager, resetTestRuntimeServices } from '../helpers/runtime-services.ts';

describe('Agent lifecycle integration', () => {
  let manager: AgentManager;

  beforeEach(async () => {
    // Some earlier suites use process-global module mocks for agent surfaces.
    // Restore them here and re-import the concrete implementations.
    mock.restore();

    const { AgentManager } = await import('@pellux/goodvibes-sdk/platform/tools');
    resetTestRuntimeServices();
    manager = getTestAgentManager();
  });

  test('spawn returns a pending record with a valid ID', () => {
    const record = manager.spawn({ mode: 'spawn', task: 'Stuck task' });
    expect(record.status).toBe('pending');
    expect(record.id).toMatch(/^agent-[0-9a-f]{8}$/);
    expect(record.task).toBe('Stuck task');
  });

  test('multiple spawned records remain independently addressable', () => {
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
    manager.spawn({ mode: 'spawn', task: 'List test A' });
    manager.spawn({ mode: 'spawn', task: 'List test B' });

    const agents = manager.list();
    expect(agents).toHaveLength(2);
    expect(agents.every((record) => typeof record.id === 'string')).toBe(true);
    expect(agents.every((record) => typeof record.task === 'string')).toBe(true);
  });

  test('cancel transitions a pending agent to cancelled', () => {
    const record = manager.spawn({ mode: 'spawn', task: 'Stuck task' });
    expect(manager.cancel(record.id)).toBe(true);
    expect(manager.getStatus(record.id)?.status).toBe('cancelled');
  });

  test('cancel returns false for unknown agents', () => {
    expect(manager.cancel('agent-nonexistent')).toBe(false);
  });
});
