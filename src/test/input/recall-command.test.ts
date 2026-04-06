import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { recallCommand } from '../../input/commands/memory.ts';
import { MemoryRegistry } from '../../state/memory-store.ts';
import type { MemoryAddOptions } from '../../state/memory-store.ts';
import { _setKnowledgeRegistryForTesting } from '../../state/knowledge-injection.ts';
import { ForensicsRegistry } from '../../runtime/forensics/registry.ts';
import { getPolicyRuntimeState, resetPolicyRuntimeStateForTests } from '../../runtime/permissions/policy-runtime.ts';
import { pluginManager } from '../../plugins/manager.ts';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeRegistry(): MemoryRegistry {
  const records: Array<{
    id: string;
    scope: string;
    cls: string;
    summary: string;
    detail?: string;
    tags: string[];
    provenance: Array<{ kind: string; ref: string }>;
    createdAt: number;
    updatedAt: number;
  }> = [];
  return {
    add: async (opts: MemoryAddOptions) => {
      const record = {
        id: `mem-${records.length + 1}`,
        scope: opts.scope ?? 'project',
        cls: opts.cls,
        summary: opts.summary,
        detail: opts.detail,
        tags: opts.tags ?? [],
        provenance: opts.provenance ?? [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        reviewState: opts.review?.state ?? 'fresh',
        confidence: opts.review?.confidence ?? 60,
        staleReason: opts.review?.staleReason,
      };
      records.push(record);
      return record as never;
    },
    update: (id: string, patch: { scope?: string; summary?: string; detail?: string; tags?: string[] }) => {
      const record = records.find((entry) => entry.id === id);
      if (!record) return null;
      if (patch.scope !== undefined) record.scope = patch.scope;
      if (patch.summary !== undefined) record.summary = patch.summary;
      if (patch.detail !== undefined) record.detail = patch.detail;
      if (patch.tags !== undefined) record.tags = patch.tags;
      record.updatedAt = Date.now();
      return record as never;
    },
    review: (id: string, patch: { state?: string; confidence?: number; staleReason?: string }) => {
      const record = records.find((entry) => entry.id === id);
      if (!record) return null;
      if (patch.state !== undefined) (record as { reviewState?: string }).reviewState = patch.state;
      if (patch.confidence !== undefined) (record as { confidence?: number }).confidence = patch.confidence;
      if (patch.staleReason !== undefined) (record as { staleReason?: string }).staleReason = patch.staleReason;
      record.updatedAt = Date.now();
      return record as never;
    },
    exportBundle: (filter?: { scope?: string }) => {
      const selected = filter?.scope ? records.filter((record) => record.scope === filter.scope) : records;
      return {
        schemaVersion: 'v1',
        exportedAt: Date.now(),
        scope: (filter?.scope ?? 'all') as 'all',
        recordCount: selected.length,
        linkCount: 0,
        records: selected as never,
        links: [],
      } as never;
    },
    getAll: () => records as never,
  } as unknown as MemoryRegistry;
}

describe('recallCommand', () => {
  let printed: string[];
  let forensicsRegistry: ForensicsRegistry;

  beforeEach(() => {
    printed = [];
    resetPolicyRuntimeStateForTests();
    _setKnowledgeRegistryForTesting(undefined);
    forensicsRegistry = new ForensicsRegistry();
    forensicsRegistry.push({
      id: 'incident-1',
      traceId: 'trace-1',
      sessionId: 'session-1',
      generatedAt: Date.now(),
      classification: 'permission_denied',
      summary: 'permission denied write access',
      turnId: 'turn-1',
      taskId: 'task-1',
      phaseTimings: [],
      phaseLedger: [],
      causalChain: [],
      cascadeEvents: [],
      permissionEvidence: [],
      budgetBreaches: [],
      jumpLinks: [],
    });
  });

  afterEach(() => {
    _setKnowledgeRegistryForTesting(undefined);
  });

  test('captures the latest incident into memory', async () => {
    await recallCommand.handler(['capture', 'incident', 'latest'], {
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
        sessionId: 'session-1',
      },
      renderRequest: () => {},
      print: (text: string) => { printed.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      memoryRegistry: makeRegistry(),
      forensicsRegistry,
    });

    expect(printed.some((line) => line.includes('Captured incident incident-1 into memory'))).toBe(true);
  });

  test('captures the latest policy preflight review into memory', async () => {
    getPolicyRuntimeState().recordPreflightReview({
      generatedAt: new Date().toISOString(),
      status: 'warn',
      summary: '1 warning detected in the current policy posture.',
      issueCount: 1,
      issues: [
        {
          severity: 'warn',
          source: 'mcp',
          serverName: 'ops',
          message: 'Ops MCP server remains quarantined pending operator review.',
        },
      ],
    });

    await recallCommand.handler(['capture', 'policy'], {
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
        sessionId: 'session-1',
      },
      renderRequest: () => {},
      print: (text: string) => { printed.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: { listServerSecurity: () => [] } as never,
      memoryRegistry: makeRegistry(),
      forensicsRegistry,
    });

    expect(printed.some((line) => line.includes('Captured policy preflight into memory'))).toBe(true);
  });

  test('captures MCP security posture into memory', async () => {
    await recallCommand.handler(['capture', 'mcp', 'ops'], {
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
        sessionId: 'session-1',
      },
      renderRequest: () => {},
      print: (text: string) => { printed.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {
        listServerSecurity: () => [{
          name: 'ops',
          role: 'ops',
          trustMode: 'allow-all',
          connected: false,
          allowedPaths: ['/srv'],
          allowedHosts: ['deploy.example.com'],
          schemaFreshness: 'quarantined',
          quarantineReason: 'operator_flagged',
          quarantineDetail: 'unexpected deploy surface',
        }],
      } as never,
      memoryRegistry: makeRegistry(),
      forensicsRegistry,
    });

    expect(printed.some((line) => line.includes('Captured MCP server ops into memory'))).toBe(true);
  });

  test('promotes a record to team scope and exports a handoff bundle', async () => {
    const registry = makeRegistry();
    await registry.add({ cls: 'decision', summary: 'Share this', scope: 'project' });

    await recallCommand.handler(['promote', 'mem-1', 'team'], {
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
        sessionId: 'session-1',
      },
      renderRequest: () => {},
      print: (text: string) => { printed.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      memoryRegistry: registry,
      forensicsRegistry,
    });

    expect(printed.some((line) => line.includes('Promoted mem-1 to team scope'))).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'gv-memory-handoff-'));
    const bundlePath = join(dir, 'team-handoff.json');
    printed.length = 0;
    await recallCommand.handler(['handoff-export', bundlePath, '--scope', 'team'], {
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
        sessionId: 'session-1',
      },
      renderRequest: () => {},
      print: (text: string) => { printed.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      memoryRegistry: registry,
      forensicsRegistry,
    });

    expect(printed.some((line) => line.includes('Exported team handoff bundle'))).toBe(true);
    expect(existsSync(bundlePath)).toBe(true);
    expect(readFileSync(bundlePath, 'utf-8')).toContain('"scope": "team"');
  });

  test('explains reviewed knowledge injection for a task and supports stale shortcuts', async () => {
    const registry = makeRegistry();
    await registry.add({
      cls: 'runbook',
      summary: 'Deploy tasks should quarantine risky MCP schemas first.',
      tags: ['deploy', 'mcp'],
      review: { state: 'reviewed', confidence: 92 },
    });
    _setKnowledgeRegistryForTesting(registry);

    await recallCommand.handler(['explain', 'deploy', 'the', 'release'], {
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
        sessionId: 'session-1',
      },
      renderRequest: () => {},
      print: (text: string) => { printed.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      memoryRegistry: registry,
      forensicsRegistry,
    });

    expect(printed.join('\n')).toContain('Injected Project Knowledge');
    expect(printed.join('\n')).toContain('matched task token "deploy"');

    printed.length = 0;
    await recallCommand.handler(['stale', 'mem-1', 'operator', 'revalidation', 'needed'], {
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
        sessionId: 'session-1',
      },
      renderRequest: () => {},
      print: (text: string) => { printed.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      memoryRegistry: registry,
      forensicsRegistry,
    });

    expect(printed.some((line) => line.includes('Reviewed mem-1: stale'))).toBe(true);
  });
});
