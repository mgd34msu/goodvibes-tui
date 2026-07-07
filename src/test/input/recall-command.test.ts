import { beforeEach, describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { recallCommand } from '../../input/commands/memory.ts';
import { MemoryRegistry } from '@pellux/goodvibes-sdk/platform/state';
import type { MemoryAddOptions, MemoryBundle } from '@pellux/goodvibes-sdk/platform/state';
import { createMemoryApi } from '@pellux/goodvibes-sdk/platform/knowledge';
import { MemorySpineClient, createLocalMemoryAccess, type LocalMemoryStore } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import { ForensicsRegistry } from '@/runtime/index.ts';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeRegistry(): MemoryRegistry {
  const links: Array<{ fromId: string; toId: string; relation: string; createdAt: number }> = [];
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
    search: (filter?: { scope?: string; cls?: string; query?: string }) => {
      return records.filter((record) => (
        (!filter?.scope || record.scope === filter.scope)
        && (!filter?.cls || record.cls === filter.cls)
        && (!filter?.query || `${record.summary} ${record.detail ?? ''}`.toLowerCase().includes(filter.query.toLowerCase()))
      )) as never;
    },
    // Used by the memory-spine local access path (createLocalMemoryAccess) —
    // a plain literal-scan envelope over the same filtered records `search()`
    // returns, since this fake has no real recall-honesty machinery.
    honestSearch: (filter?: { scope?: string; cls?: string; query?: string }) => {
      const matched = records.filter((record) => (
        (!filter?.scope || record.scope === filter.scope)
        && (!filter?.cls || record.cls === filter.cls)
        && (!filter?.query || `${record.summary} ${record.detail ?? ''}`.toLowerCase().includes(filter.query.toLowerCase()))
      ));
      return {
        records: matched,
        mode: 'literal',
        requestedSemantic: false,
        indexUnavailableReason: null,
        caveat: null,
        recallFiltered: false,
        excludedFlaggedCount: 0,
        excludedBelowFloorCount: 0,
        totalBeforeRecallFilter: matched.length,
      } as never;
    },
    searchSemantic: () => [] as never,
    vectorStats: () => ({
      backend: 'sqlite-vec',
      enabled: true,
      available: true,
      dimensions: 1536,
      indexedRecords: records.length,
      path: ':memory:',
    }),
    rebuildVectors: () => ({
      backend: 'sqlite-vec',
      enabled: true,
      available: true,
      dimensions: 1536,
      indexedRecords: records.length,
      path: ':memory:',
    }),
    rebuildVectorsAsync: async () => ({
      backend: 'sqlite-vec',
      enabled: true,
      available: true,
      dimensions: 1536,
      indexedRecords: records.length,
      path: ':memory:',
    }),
    doctor: async () => ({
      vector: {
        backend: 'sqlite-vec',
        enabled: true,
        available: true,
        dimensions: 1536,
        indexedRecords: records.length,
        path: ':memory:',
      },
      embeddings: {
        configured: true,
        activeProviderId: 'hashed-local',
        defaultProviderId: 'hashed-local',
        registeredProviders: [],
        warnings: [],
      },
      checkedAt: Date.now(),
    }) as never,
    reviewQueue: (limit = 10) => records.slice(0, limit) as never,
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
    get: (id: string) => records.find((entry) => entry.id === id) as never,
    link: async (fromId: string, toId: string, relation: string) => {
      const from = records.find((entry) => entry.id === fromId);
      const to = records.find((entry) => entry.id === toId);
      if (!from || !to) return null;
      const link = { fromId, toId, relation, createdAt: Date.now() };
      links.push(link);
      return link as never;
    },
    linksFor: (id: string) => links.filter((link) => link.fromId === id || link.toId === id) as never,
    delete: (id: string) => {
      const index = records.findIndex((entry) => entry.id === id);
      if (index === -1) return false;
      records.splice(index, 1);
      return true;
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
    importBundle: async (bundle: MemoryBundle) => {
      for (const record of bundle.records as Array<typeof records[number]>) {
        if (!records.some((entry) => entry.id === record.id)) {
          records.push({ ...record });
        }
      }
      return {
        importedRecords: bundle.records.length,
        skippedRecords: 0,
        importedLinks: bundle.links.length,
      } as never;
    },
    getAll: () => records as never,
  } as unknown as MemoryRegistry;
}

function makeRecallCommandContext(
  printed: string[],
  options: {
    memoryRegistry: MemoryRegistry;
    forensicsRegistry: ForensicsRegistry;
    policyRuntimeState?: PolicyRuntimeState;
    mcpRegistry?: CommandContext['extensions']['mcpRegistry'];
    shellPaths?: CommandContext['workspace']['shellPaths'];
  },
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
        sessionId: 'session-1',
      },
    },
    provider: {
      providerRegistry,
    },
    workspace: {
      shellPaths: options.shellPaths,
    },
    platform: {
      config: {} as never,
      configManager,
    },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: options.mcpRegistry ?? ({} as never),
      memoryRegistry: options.memoryRegistry,
      forensicsRegistry: options.forensicsRegistry,
      policyRuntimeState: options.policyRuntimeState,
    },
    clients: {
      knowledgeApi: {
        memory: createMemoryApi(options.memoryRegistry),
      } as never,
      // /recall's browse/link/queue/export/import (and add/get/remove/review)
      // now route through the memory spine, not knowledgeApi.memory — see
      // recall-query.ts's getMemorySpine. Local mode (no transport activated)
      // routes straight to this fake registry, same data the assertions below
      // already read back through it.
      memorySpine: new MemorySpineClient({
        local: createLocalMemoryAccess(options.memoryRegistry as unknown as LocalMemoryStore),
      }),
    },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  };
}

describe('recallCommand', () => {
  let printed: string[];
  let forensicsRegistry: ForensicsRegistry;
  let policyRuntimeState: PolicyRuntimeState;

  beforeEach(() => {
    printed = [];
    policyRuntimeState = new PolicyRuntimeState();
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

  test('captures the latest incident into memory', async () => {
    await recallCommand.handler(['capture', 'incident', 'latest'], makeRecallCommandContext(printed, {
      memoryRegistry: makeRegistry(),
      forensicsRegistry,
    }));

    expect(printed.some((line) => line.includes('Captured incident incident-1 into memory'))).toBe(true);
  });

  test('captures the latest policy preflight review into memory', async () => {
    policyRuntimeState.recordPreflightReview({
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

    await recallCommand.handler(['capture', 'policy'], makeRecallCommandContext(printed, {
      memoryRegistry: makeRegistry(),
      forensicsRegistry,
      policyRuntimeState,
      mcpRegistry: { listServerSecurity: () => [] } as never,
    }));

    expect(printed.some((line) => line.includes('Captured policy preflight into memory'))).toBe(true);
  });

  test('captures MCP security posture into memory', async () => {
    await recallCommand.handler(['capture', 'mcp', 'ops'], makeRecallCommandContext(printed, {
      memoryRegistry: makeRegistry(),
      forensicsRegistry,
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
    }));

    expect(printed.some((line) => line.includes('Captured MCP server ops into memory'))).toBe(true);
  });

  test('promotes a record to team scope and exports a handoff bundle', async () => {
    const registry = makeRegistry();
    await registry.add({ cls: 'decision', summary: 'Share this', scope: 'project' });

    await recallCommand.handler(['promote', 'mem-1', 'team'], makeRecallCommandContext(printed, {
      memoryRegistry: registry,
      forensicsRegistry,
    }));

    expect(printed.some((line) => line.includes('Promoted mem-1 to team scope'))).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'gv-memory-handoff-'));
    const bundlePath = join(dir, 'team-handoff.json');
    const shellPaths = createShellPathService({
      workingDirectory: dir,
      homeDirectory: dir,
    });
    printed.length = 0;
    await recallCommand.handler(['handoff-export', bundlePath, '--scope', 'team'], makeRecallCommandContext(printed, {
      memoryRegistry: registry,
      forensicsRegistry,
      shellPaths,
    }));

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
    await recallCommand.handler(['explain', 'deploy', 'the', 'release'], makeRecallCommandContext(printed, {
      memoryRegistry: registry,
      forensicsRegistry,
    }));

    expect(printed.join('\n')).toContain('Injected Project Knowledge');
    expect(printed.join('\n')).toContain('matched task token "deploy"');

    printed.length = 0;
    await recallCommand.handler(['stale', 'mem-1', 'operator', 'revalidation', 'needed'], makeRecallCommandContext(printed, {
      memoryRegistry: registry,
      forensicsRegistry,
    }));

    expect(printed.some((line) => line.includes('Reviewed mem-1: stale'))).toBe(true);
  });

  // ── DEBT-5 item 3: report-vs-modal front door ─────────────────────────────
  describe('front door (bare opens the memory-modal; report preserves the old usage output)', () => {
    test('bare /recall opens the memory-modal, prints nothing', async () => {
      const opened: string[] = [];
      const ctx = { ...makeRecallCommandContext(printed, { memoryRegistry: makeRegistry(), forensicsRegistry }), openModal: (name: string) => opened.push(name) };
      await recallCommand.handler([], ctx);
      expect(opened).toEqual(['memory-modal']);
      expect(printed).toEqual([]);
    });

    test('/recall report prints the subcommand usage text (scriptability preserved) and does not open the modal', async () => {
      const opened: string[] = [];
      const ctx = { ...makeRecallCommandContext(printed, { memoryRegistry: makeRegistry(), forensicsRegistry }), openModal: (name: string) => opened.push(name) };
      await recallCommand.handler(['report'], ctx);
      expect(opened).toEqual([]);
      expect(printed.length).toBe(1);
      expect(printed[0]).toContain('Usage: /recall <subcommand>');
      expect(printed[0]).toContain('add <class> <summary>');
    });

    test('an unrecognized subcommand still shows the usage text (unchanged lenient fallback)', async () => {
      const opened: string[] = [];
      const ctx = { ...makeRecallCommandContext(printed, { memoryRegistry: makeRegistry(), forensicsRegistry }), openModal: (name: string) => opened.push(name) };
      await recallCommand.handler(['not-a-real-subcommand'], ctx);
      expect(opened).toEqual([]);
      expect(printed[0]).toContain('Usage: /recall <subcommand>');
    });

    test('a real subcommand (list) still dispatches normally, not affected by the front-door change', async () => {
      const opened: string[] = [];
      const ctx = { ...makeRecallCommandContext(printed, { memoryRegistry: makeRegistry(), forensicsRegistry }), openModal: (name: string) => opened.push(name) };
      await recallCommand.handler(['list'], ctx);
      expect(opened).toEqual([]);
    });
  });
});
