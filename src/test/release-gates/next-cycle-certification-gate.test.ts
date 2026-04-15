import { describe, expect, mock, test } from 'bun:test';

import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools/agent/index';
import { buildKnowledgeInjectionPrompt } from '@pellux/goodvibes-sdk/platform/state/index';
import { buildMcpAttackPathReview } from '@pellux/goodvibes-sdk/platform/runtime/mcp/index';
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
  test('knowledge prompt includes reviewed project knowledge with an explainable source trail', () => {
    const knowledgeInjections: Parameters<typeof buildKnowledgeInjectionPrompt>[0] = [{
      id: 'mem-gate-1',
      cls: 'runbook',
      summary: 'Use targeted runtime edits for orchestration store changes',
      reason: 'matched write scope "src/runtime/store"',
      confidence: 95,
      reviewState: 'reviewed',
      trustTier: 'reviewed',
      useAs: 'reference-material',
      retention: 'task-only',
      provenance: {
        source: 'project-memory',
        links: [{ kind: 'file', ref: 'src/runtime/store' }],
      },
      ingestMode: 'keyword-ranked',
    }];
    const record = makeRecord({
      knowledgeInjections: knowledgeInjections as unknown as AgentRecord['knowledgeInjections'],
    });
    const knowledgePrompt = buildKnowledgeInjectionPrompt(knowledgeInjections);

    expect(knowledgePrompt).toContain('Injected Project Knowledge');
    expect(knowledgePrompt).toContain('trust reviewed');
    expect(knowledgePrompt).toContain('retention task-only');
    expect(knowledgeInjections[0]?.summary).toContain('orchestration store');
    expect(knowledgeInjections[0]?.reason).toContain('matched');
  });

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

  test('MCP security review produces programmatic attack-path findings for incoherent servers', () => {
    const review = buildMcpAttackPathReview({
      servers: [{
        name: 'docs',
        role: 'docs',
        trustMode: 'ask-on-risk',
        allowedPaths: [],
        allowedHosts: ['docs.example.com'],
        schemaFreshness: 'quarantined',
        quarantineReason: 'incompatible',
        connected: true,
      }],
      recentDecisions: [{
        serverName: 'docs',
        toolName: 'write_file',
        verdict: 'deny',
        riskLevel: 'critical',
        capability: 'write_fs',
        incoherent: true,
        reason: 'docs server attempted filesystem mutation',
        profileMode: 'ask-on-risk',
        evaluatedAt: Date.now(),
      }],
    });

    expect(review.criticalFindings).toBeGreaterThan(0);
    expect(review.incoherentFindings).toBeGreaterThan(0);
    expect(review.findings[0]?.serverName).toBe('docs');
    expect(review.findings[0]?.reason).toContain('docs');
  });
});
