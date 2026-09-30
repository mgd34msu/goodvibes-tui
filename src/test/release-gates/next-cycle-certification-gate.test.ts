import { describe, expect, mock, test } from 'bun:test';

import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';
import { buildKnowledgeInjectionPrompt } from '@pellux/goodvibes-sdk/platform/state';
import { buildMcpAttackPathReview } from '@/runtime/index.ts';
import { handleRemoteCancelCommand } from '../../input/commands/remote-runtime.ts';

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'agent-gate-01',
    task: 'Update orchestration store behavior for graph nodes',
    template: 'engineer',
    tools: ['read', 'edit'],
    status: 'pending',
    startedAt: Date.now(),
    orchestrationDepth: 0,
    toolCallCount: 0,
    executionProtocol: 'gather-plan-apply',
    reviewMode: 'wrfc',
    communicationLane: 'direct',
    writeScope: ['src/runtime/store'],
    ...overrides,
  };
}

describe('next cycle certification gate', () => {

  test('remote operator control uses a scoped command path and cancels the target agent only', () => {
    const remoteRecord = { id: 'agent-remote-01' };
    const otherRecord = { id: 'agent-local-02' };
    const printed: string[] = [];
    const cancel = mock((agentId: string) => agentId === remoteRecord.id);
    handleRemoteCancelCommand(
      remoteRecord.id,
      [{ agentId: remoteRecord.id }],
      {
        print: (text: string) => { printed.push(text); },
      },
      { cancel },
      undefined,
    );

    expect(cancel).toHaveBeenCalledWith(remoteRecord.id);
    expect(cancel).not.toHaveBeenCalledWith(otherRecord.id);
    expect(printed.join('\n')).toContain(`Cancelled remote agent ${remoteRecord.id}`);
  });

});
