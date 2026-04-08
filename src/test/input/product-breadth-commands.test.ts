import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { CONFIG_SCHEMA } from '../../config/index.ts';
import type { ConfigKey } from '../../config/index.ts';
import { _resetSubscriptionManagerForTesting, getSubscriptionManager } from '../../config/subscriptions.ts';
import {
  _resetSubscriptionBrowserOpenerForTesting,
  _setSubscriptionBrowserOpenerForTesting,
} from '../../input/commands/subscription-runtime.ts';
import { ForensicsRegistry } from '../../runtime/forensics/registry.ts';
import type { MemoryAddOptions } from '../../state/memory-store.ts';
import { _resetRemoteRunnerRegistryForTesting, getRemoteRunnerRegistry } from '../../runtime/remote/runner-registry.ts';
import type { TaskManager } from '../../runtime/tasks/types.ts';
import { resetLocalUserAuthManagerForTesting, setLocalUserAuthManager } from '../../runtime/local-auth.ts';
import { UserAuthManager } from '../../security/user-auth.ts';

describe('product breadth commands', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  const originalQemuImgBin = process.env.QEMU_IMG_BIN;
  const originalFetch = globalThis.fetch;
  let root = '';

  beforeEach(() => {
    _resetRemoteRunnerRegistryForTesting();
    _resetSubscriptionManagerForTesting();
    _resetSubscriptionBrowserOpenerForTesting();
    resetLocalUserAuthManagerForTesting();
    root = mkdtempSync(join(tmpdir(), 'gv-product-commands-'));
    process.env.HOME = root;
    process.chdir(root);
    setLocalUserAuthManager(new UserAuthManager({
      users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin-pass'), roles: ['admin'] }],
    }));
  });

  afterEach(() => {
    _resetRemoteRunnerRegistryForTesting();
    _resetSubscriptionManagerForTesting();
    _resetSubscriptionBrowserOpenerForTesting();
    resetLocalUserAuthManagerForTesting();
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalQemuImgBin === undefined) {
      delete process.env.QEMU_IMG_BIN;
    } else {
      process.env.QEMU_IMG_BIN = originalQemuImgBin;
    }
  });

  function makeContext(out: string[]) {
    const values = new Map<ConfigKey, unknown>();
    for (const entry of CONFIG_SCHEMA) {
      values.set(entry.key, structuredClone(entry.default));
    }
    const memoryRecords: Array<{ id: string; scope: string; cls: string; summary: string }> = [];
    const forensicsRegistry = new ForensicsRegistry();
    forensicsRegistry.push({
      id: 'incident-1',
      traceId: 'trace-1',
      sessionId: 'sess-product',
      generatedAt: Date.now(),
      classification: 'tool_failure',
      summary: 'deploy tool failed',
      taskId: 'task-1',
      turnId: 'turn-1',
      agentId: 'agent-1',
      phaseTimings: [],
      phaseLedger: [],
      causalChain: [{ seq: 1, ts: 1, description: 'tool failed', sourceEventType: 'TASK_FAILED', isRootCause: true }],
      cascadeEvents: [],
      permissionEvidence: [],
      budgetBreaches: [],
      jumpLinks: [],
    });
    return {
      providerRegistry: {
        listModels: () => [{ id: 'model-1' }],
      } as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {
        get: (key: ConfigKey) => values.get(key),
        set: (key: ConfigKey, value: unknown) => { values.set(key, value); },
        setDynamic: (key: ConfigKey, value: unknown) => { values.set(key, value); },
        getAll: () => Object.fromEntries(values),
        getCategory: (category: string) => {
          const entries = [...values.entries()].filter(([key]) => key.startsWith(`${category}.`));
          return Object.fromEntries(entries.map(([key, value]) => [key.slice(category.length + 1), value]));
        },
      } as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-product',
      },
      renderRequest: () => {},
      print: (text: string) => { out.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {
        listRecentSecurityDecisions: () => [],
      } as never,
      runtimeStore: createRuntimeStore(),
      forensicsRegistry,
      memoryRegistry: {
        add: async (opts: MemoryAddOptions) => {
          const record = {
            id: `mem-${memoryRecords.length + 1}`,
            scope: opts.scope ?? 'project',
            cls: opts.cls,
            summary: opts.summary,
          };
          memoryRecords.push(record);
          return record as never;
        },
        reviewQueue: (_limit: number) => [],
        exportBundle: (filter?: { scope?: string }) => ({
          schemaVersion: 'v1',
          exportedAt: Date.now(),
          scope: (filter?.scope as 'session' | 'project' | 'team' | 'all' | undefined) ?? 'all',
          recordCount: memoryRecords.length,
          linkCount: 0,
          records: [],
          links: [],
        }),
        importBundle: async () => ({
          importedRecords: 0,
          skippedRecords: 0,
          importedLinks: 0,
        }),
      } as never,
    };
  }

  test('services command can inspect and test configured services', async () => {
    mkdirSync(join(root, '.goodvibes', 'tui'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'tui', 'services.json'), JSON.stringify({
      github: {
        name: 'github',
        baseUrl: 'https://api.github.com',
        authType: 'bearer',
        tokenKey: 'GITHUB_TOKEN',
      },
    }, null, 2));

    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const command = registry.get('services');
    expect(command).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out) as ReturnType<typeof makeContext> & { openSecurityPanel?: () => void };

    await command!.handler(['inspect', 'github'], ctx);
    expect(out.join('\n')).toContain('Service github');
    expect(out.join('\n')).toContain('authType: bearer');

    out.length = 0;
    await command!.handler(['resolve', 'github'], ctx);
    expect(out.join('\n')).toContain('has no resolvable auth headers');

    out.length = 0;
    await command!.handler(['doctor'], ctx);
    expect(out.join('\n')).toContain('Service Doctor');

    out.length = 0;
    await command!.handler(['auth-review'], ctx);
    expect(out.join('\n')).toContain('Service Auth Review');
    expect(out.join('\n')).toContain('bearer: 1');

    const exported = join(root, 'artifacts', 'services.json');
    out.length = 0;
    await command!.handler(['export', exported], ctx);
    expect(out.join('\n')).toContain('Exported services config');
    expect(existsSync(exported)).toBe(true);
  });

  test('accounts and health commands surface provider route posture and fallback risk', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    getSubscriptionManager().saveSubscription({
      provider: 'openai',
      accessToken: 'header.payload.signature',
      tokenType: 'Bearer',
      expiresAt: Date.now() - 5_000,
      authMode: 'oauth',
      overrideAmbientApiKeys: true,
      createdAt: Date.now() - 10_000,
      updatedAt: Date.now() - 10_000,
    });

    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const accounts = registry.get('accounts');
    const health = registry.get('health');
    expect(accounts).toBeDefined();
    expect(health).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out) as ReturnType<typeof makeContext> & { openSecurityPanel?: () => void };

    await accounts!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('preferred=subscription');
    expect(out.join('\n')).toContain('active=api-key');

    out.length = 0;
    await accounts!.handler(['show', 'openai'], ctx);
    expect(out.join('\n')).toContain('fallbackRoute: api-key');
    expect(out.join('\n')).toContain('route subscription: usable=no');

    out.length = 0;
    await accounts!.handler(['routes', 'openai'], ctx);
    expect(out.join('\n')).toContain('Provider Routes openai');
    expect(out.join('\n')).toContain('preferred: subscription');

    out.length = 0;
    await accounts!.handler(['repair', 'openai'], ctx);
    expect(out.join('\n')).toContain('Provider Account Repair openai');
    expect(out.join('\n')).toContain('fallback:');

    out.length = 0;
    await health!.handler(['accounts'], ctx);
    expect(out.join('\n')).toContain('preferred subscription path');
  });

  test('skills and setup commands surface discovered skills and startup posture', async () => {
    mkdirSync(join(root, '.goodvibes', 'skills', 'deploy-check'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'skills', 'deploy-check', 'SKILL.md'), [
      '---',
      'name: deploy-check',
      'description: Review deploy readiness',
      'depends_on: git,release',
      '---',
      '',
      '@shared/checklist',
    ].join('\n'));

    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const skills = registry.get('skills');
    const setup = registry.get('setup');
    expect(skills).toBeDefined();
    expect(setup).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out) as ReturnType<typeof makeContext> & { openSecurityPanel?: () => void };

    await skills!.handler(['list'], ctx);
    expect(out.join('\n')).toContain('deploy-check');

    out.length = 0;
    await skills!.handler(['show', 'deploy-check'], ctx);
    expect(out.join('\n')).toContain('origin: project-local');
    expect(out.join('\n')).toContain('dependencies: git, release');

    out.length = 0;
    await setup!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Startup Readiness Review');
    expect(out.join('\n')).toContain('skills discovered:');
    expect(out.join('\n')).toContain('sandbox backend:');

    out.length = 0;
    await setup!.handler(['doctor'], ctx);
    expect(out.join('\n')).toContain('Startup Doctor');
    expect(out.join('\n')).toContain('[PASS] providers:');

    out.length = 0;
    await setup!.handler(['onboarding'], ctx);
    expect(out.join('\n')).toContain('Onboarding Checklist');
    expect(out.join('\n')).toContain('/hooks scaffold');
    expect(out.join('\n')).toContain('sandbox:');
    expect(out.join('\n')).toContain('/setup sandbox');
    expect(out.join('\n')).toContain('/sandbox qemu bootstrap .goodvibes/tui/sandbox 20');

    out.length = 0;
    await setup!.handler(['sandbox'], ctx);
    expect(out.join('\n')).toContain('Setup Sandbox Review');
    expect(out.join('\n')).toContain('/sandbox qemu bootstrap .goodvibes/tui/sandbox 20');

    const exportPath = join(root, 'artifacts', 'startup-review.json');
    out.length = 0;
    await setup!.handler(['export', exportPath], ctx);
    expect(out.join('\n')).toContain('Exported startup review');
    expect(readFileSync(exportPath, 'utf-8')).toContain('"providerCount": 1');

    const supportDir = join(root, 'artifacts', 'support-bundle');
    out.length = 0;
    await setup!.handler(['support-bundle', supportDir], ctx);
    expect(out.join('\n')).toContain('Exported support bundle');
    expect(existsSync(join(supportDir, 'startup-review.json'))).toBe(true);
    expect(existsSync(join(supportDir, 'remote-summary.json'))).toBe(true);
    expect(existsSync(join(supportDir, 'qemu-wrapper.template.sh'))).toBe(true);
  });

  test('health and guidance commands surface maintenance posture', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const health = registry.get('health');
    const guidance = registry.get('guidance');
    const intelligence = registry.get('intelligence');
    expect(health).toBeDefined();
    expect(guidance).toBeDefined();
    expect(intelligence).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out);
    (ctx.configManager as { setDynamic: (key: ConfigKey, value: unknown) => void }).setDynamic('behavior.guidanceMode', 'guided');
    ctx.conversationManager = {
      getMessagesForLLM: () => [
        { role: 'user', content: 'x'.repeat(80_000) },
        { role: 'assistant', content: 'done' },
      ],
    } as never;
    ctx.providerRegistry = {
      getCurrentModel: () => ({ id: 'openrouter/free', provider: 'openrouter' }),
      listModels: () => [{ id: 'model-1' }],
    } as never;

    await guidance!.handler(['review'], ctx as never);
    expect(out.join('\n')).toContain('Guidance Review');
    expect(out.join('\n')).toMatch(/Maintenance:/);
    expect(out.join('\n')).toContain('dismiss: /guidance dismiss');

    out.length = 0;
    await health!.handler(['review'], ctx as never);
    expect(out.join('\n')).toContain('Health Review');
    expect(out.join('\n')).toMatch(/Maintenance:/);

    out.length = 0;
    await intelligence!.handler(['review'], ctx as never);
    expect(out.join('\n')).toContain('Intelligence Review');
    expect(out.join('\n')).toContain('/intelligence symbols <file>');

    out.length = 0;
    await intelligence!.handler(['diagnostics'], ctx as never);
    expect(out.join('\n')).toContain('Intelligence Diagnostics');

    out.length = 0;
    await intelligence!.handler(['repair'], ctx as never);
    expect(out.join('\n')).toContain('Intelligence Repair');
    expect(out.join('\n')).toContain('verify: /health intelligence');

    out.length = 0;
    await health!.handler(['intelligence'], ctx as never);
    expect(out.join('\n')).toContain('Health Review: Intelligence');

    out.length = 0;
    await health!.handler(['mcp'], ctx as never);
    expect(out.join('\n')).toContain('Health Review: MCP');

    out.length = 0;
    await health!.handler(['continuity'], ctx as never);
    expect(out.join('\n')).toContain('Health Review: Continuity');

    const intelligenceFile = join(root, 'src', 'intel-fixture.txt');
    mkdirSync(dirname(intelligenceFile), { recursive: true });
    writeFileSync(intelligenceFile, 'plain text fixture\n', 'utf-8');

    out.length = 0;
    await intelligence!.handler(['symbols', intelligenceFile], ctx as never);
    expect(out.join('\n')).toContain('Intelligence Symbols:');

    out.length = 0;
    await intelligence!.handler(['outline', intelligenceFile], ctx as never);
    expect(out.join('\n')).toContain('Intelligence Outline:');

    out.length = 0;
    await intelligence!.handler(['definition', intelligenceFile, '1', '1'], ctx as never);
    expect(out.join('\n')).toContain('Intelligence Definition:');

    out.length = 0;
    await intelligence!.handler(['references', intelligenceFile, '1', '1'], ctx as never);
    expect(out.join('\n')).toContain('Intelligence References:');

    out.length = 0;
    await intelligence!.handler(['hover', intelligenceFile, '1', '1'], ctx as never);
    expect(out.join('\n')).toContain('Intelligence Hover:');

    out.length = 0;
    await health!.handler(['repair', 'intelligence'], ctx as never);
    expect(out.join('\n')).toContain('verify: /health intelligence');
  });

  test('session and tools commands expose transcript structure and compact tool-surface review', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const session = registry.get('session');
    const tools = registry.get('tools');
    expect(session).toBeDefined();
    expect(tools).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out);
    ctx.conversationManager = {
      getTranscriptEventIndex: () => ({
        events: [
          { kind: 'user_input', messageIndex: 0, title: 'User input', detail: 'review auth flow' },
          { kind: 'tool_call', messageIndex: 1, title: 'read', detail: '{\"path\":\"src/main.ts\"}' },
          { kind: 'tool_result', messageIndex: 2, title: 'read', detail: '200 lines loaded' },
          { kind: 'remote_status', messageIndex: 3, title: 'remote status', detail: 'runner attached' },
        ],
        groups: [
          { kind: 'tool_call', title: 'read', messageIndexes: [1, 2], events: [{}, {}] },
          { kind: 'remote_status', title: 'remote status', messageIndexes: [3], events: [{}] },
        ],
      }),
    } as never;
    ctx.toolRegistry = {
      list: () => [],
    } as never;

    await session!.handler(['events', 'tool_call'], ctx as never);
    expect(out.join('\n')).toContain('Transcript Events: tool_call');
    expect(out.join('\n')).toContain('read');

    out.length = 0;
    await session!.handler(['groups'], ctx as never);
    expect(out.join('\n')).toContain('Transcript Groups');

    out.length = 0;
    await session!.handler(['hotspots'], ctx as never);
    expect(out.join('\n')).toContain('Transcript Hotspots');
    expect(out.join('\n')).toContain('remote_status');

    out.length = 0;
    await tools!.handler(['review'], ctx as never);
    expect(out.join('\n')).toContain('Tool Surface Review');
    expect(out.join('\n')).toContain('Native file tools stay compact by default');
  });

  test('experience commands expose remote setup/env, tunnel/bootstrap, runner pools, approval workspace, memory review, and voice review', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const remoteSetup = registry.get('remote-setup');
    const remoteEnv = registry.get('remote-env');
    const tunnel = registry.get('tunnel');
    const bootstrap = registry.get('bootstrap');
    const runnerPool = registry.get('runner-pool');
    const memoryReview = registry.get('memory-review');
    const approval = registry.get('approval');
    const voice = registry.get('voice');
    expect(remoteSetup).toBeDefined();
    expect(remoteEnv).toBeDefined();
    expect(tunnel).toBeDefined();
    expect(bootstrap).toBeDefined();
    expect(runnerPool).toBeDefined();
    expect(memoryReview).toBeDefined();
    expect(approval).toBeDefined();
    expect(voice).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out) as ReturnType<typeof makeContext> & { executeCommand?: (name: string, args: string[]) => Promise<boolean> };
    ctx.executeCommand = async (name, args) => {
      const delegated = registry.get(name);
      expect(delegated).toBeDefined();
      await delegated!.handler(args, ctx);
      return true;
    };

    await remoteSetup!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Remote Setup Review');

    out.length = 0;
    await remoteEnv!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Remote Environment');

    out.length = 0;
    await tunnel!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Remote Tunnel Review');

    const bootstrapPath = join(root, 'artifacts', 'bootstrap.json');
    out.length = 0;
    await bootstrap!.handler(['export', bootstrapPath], ctx);
    expect(out.join('\n')).toContain('Exported remote bootstrap bundle');

    out.length = 0;
    await runnerPool!.handler(['list'], ctx);
    expect(out.join('\n')).toContain('No remote runner pools defined yet.');

    out.length = 0;
    await memoryReview!.handler(['queue', '5'], ctx);
    expect(out.join('\n')).toContain('Knowledge review queue is empty');

    out.length = 0;
    await approval!.handler(['matrix'], ctx);
    expect(out.join('\n')).toContain('Approval Matrix');

    out.length = 0;
    await approval!.handler(['review', 'sandbox'], ctx);
    expect(out.join('\n')).toContain('Approval Review: sandbox');
    expect(out.join('\n')).toContain('sandbox');

    out.length = 0;
    await voice!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Voice Review');
  });

  test('memory product commands expose sync, handoff, and scoped session/team flows', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const memorySync = registry.get('memory-sync');
    const handoff = registry.get('handoff');
    const sessionMemory = registry.get('session-memory');
    const teamMemory = registry.get('team-memory');
    expect(memorySync).toBeDefined();
    expect(handoff).toBeDefined();
    expect(sessionMemory).toBeDefined();
    expect(teamMemory).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out) as ReturnType<typeof makeContext> & { executeCommand?: (name: string, args: string[]) => Promise<boolean> };
    ctx.executeCommand = async (name, args) => {
      const delegated = registry.get(name);
      expect(delegated).toBeDefined();
      await delegated!.handler(args, ctx);
      return true;
    };

    const exportPath = join(root, 'artifacts', 'memory.json');
    await memorySync!.handler(['export', exportPath, 'project'], ctx);
    expect(out.join('\n')).toContain('Exported');

    out.length = 0;
    const handoffPath = join(root, 'artifacts', 'handoff.json');
    await handoff!.handler(['export', handoffPath, 'team'], ctx);
    expect(out.join('\n')).toContain('handoff bundle');

    out.length = 0;
    await sessionMemory!.handler(['queue', '3'], ctx);
    expect(out.join('\n')).toContain('Review queue');

    out.length = 0;
    const teamPath = join(root, 'artifacts', 'team-handoff.json');
    await teamMemory!.handler(['export', teamPath], ctx);
    expect(out.join('\n')).toContain('handoff bundle');
  });

  test('security command prints review and attack-path summaries', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const security = registry.get('security');
    expect(security).toBeDefined();

    const out: string[] = [];
    const ctx: ReturnType<typeof makeContext> & { openSecurityPanel?: () => void } = makeContext(out);
    ctx.runtimeStore!.setState((state) => ({
      ...state,
      mcp: {
        ...state.mcp,
        servers: new Map([
          ['docs', {
            name: 'docs',
            displayName: 'Docs',
            status: 'connected',
            transport: 'stdio',
            toolCount: 1,
            toolNames: ['docs__search'],
            callCount: 0,
            errorCount: 0,
            reconnectAttempts: 0,
            role: 'docs',
            trustMode: 'constrained',
            allowedPaths: [],
            allowedHosts: [],
            schemaFreshness: 'fresh',
          }],
          ['weird', {
            name: 'weird',
            displayName: 'Weird',
            status: 'connected',
            transport: 'stdio',
            toolCount: 1,
            toolNames: ['weird__search_docs'],
            callCount: 0,
            errorCount: 0,
            reconnectAttempts: 0,
            role: 'docs',
            trustMode: 'allow-all',
            allowedPaths: ['/home/user/.ssh'],
            allowedHosts: ['*'],
            schemaFreshness: 'quarantined',
            quarantineReason: 'operator_flagged',
            quarantineDetail: 'Tool requested exec path',
          }],
        ]),
      },
    }));
    ctx.mcpRegistry = {
      listRecentSecurityDecisions: () => [{
        serverName: 'weird',
        toolName: 'search_docs',
        capability: 'write_fs',
        incoherent: true,
        riskLevel: 'high',
        verdict: 'deny',
        reason: 'docs server attempted write access',
        profileMode: 'allow-all',
        evaluatedAt: Date.now(),
      }],
    } as never;

    await security!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Security Review');
    expect(out.join('\n')).toContain('mcp attack-path findings');

    out.length = 0;
    await security!.handler(['attack-paths'], ctx);
    expect(out.join('\n')).toContain('MCP Attack-Path Review');
  });

  test('plugin command exposes directory and review surfaces', async () => {
    mkdirSync(join(root, '.goodvibes', 'tui', 'ecosystem'), { recursive: true });
    mkdirSync(join(root, 'catalog', 'plugins', 'deploy-audit'), { recursive: true });
    writeFileSync(join(root, 'catalog', 'plugins', 'deploy-audit', 'manifest.json'), JSON.stringify({
      name: 'deploy-audit',
      version: '1.0.0',
      description: 'Reviews deploy surfaces before release',
    }, null, 2));
    writeFileSync(join(root, 'catalog', 'plugins', 'deploy-audit', 'index.ts'), 'export function init() {}\n');
    writeFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'plugins.json'), JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'deploy-audit',
          kind: 'plugin',
          name: 'Deploy Audit',
          summary: 'Reviews deploy surfaces before release',
          source: './catalog/plugins/deploy-audit',
          tags: ['security', 'release'],
          installHint: 'Clone into .goodvibes/tui/plugins/deploy-audit and reload.',
        },
      ],
    }, null, 2));

    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const plugin = registry.get('plugin');
    expect(plugin).toBeDefined();

    const out: string[] = [];
    const ctx: ReturnType<typeof makeContext> & { openSecurityPanel?: () => void } = makeContext(out);

    await plugin!.handler(['dirs'], ctx);
    expect(out.join('\n')).toContain('Plugin Search Directories');

    out.length = 0;
    await plugin!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Plugin Security Review');

    out.length = 0;
    await plugin!.handler(['browse'], ctx);
    expect(out.join('\n')).toContain('Curated Plugin Catalog');
    expect(out.join('\n')).toContain('deploy-audit');

    out.length = 0;
    await plugin!.handler(['install-hint', 'deploy-audit'], ctx);
    expect(out.join('\n')).toContain('Plugin Install Guidance');

    out.length = 0;
    await plugin!.handler(['publish-local', 'ops-helper', './catalog/plugins/deploy-audit', 'Operator', 'deploy', 'helper'], ctx);
    expect(out.join('\n')).toContain('Published curated plugin ops-helper');
    expect(readFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'plugins.json'), 'utf-8')).toContain('"ops-helper"');

    out.length = 0;
    await plugin!.handler(['catalog-review', 'deploy-audit'], ctx);
    expect(out.join('\n')).toContain('Plugin Catalog Review');
    expect(out.join('\n')).toContain('sourceKind: local-path');

    out.length = 0;
    await plugin!.handler(['install', 'deploy-audit', 'project'], ctx);
    expect(out.join('\n')).toContain('Installed curated plugin');
    expect(existsSync(join(root, '.goodvibes', 'plugins', 'deploy-audit', 'manifest.json'))).toBe(true);

    out.length = 0;
    await plugin!.handler(['installed'], ctx);
    expect(out.join('\n')).toContain('Installed Curated Plugins');

    out.length = 0;
    await plugin!.handler(['update', 'deploy-audit', 'project'], ctx);
    expect(out.join('\n')).toContain('Updated curated plugin');

    out.length = 0;
    await plugin!.handler(['uninstall', 'deploy-audit', 'project'], ctx);
    expect(out.join('\n')).toContain('Uninstalled curated plugin');

    out.length = 0;
    await plugin!.handler(['unpublish', 'ops-helper'], ctx);
    expect(out.join('\n')).toContain('Removed curated plugin ops-helper');
  });

  test('skills command exposes curated catalog guidance', async () => {
    mkdirSync(join(root, '.goodvibes', 'tui', 'ecosystem'), { recursive: true });
    mkdirSync(join(root, 'catalog', 'skills', 'release-gate'), { recursive: true });
    writeFileSync(join(root, 'catalog', 'skills', 'release-gate', 'SKILL.md'), [
      '---',
      'name: release-gate',
      'description: Runs release certification and deploy checks',
      'depends_on: release,ops',
      '---',
      '',
      '@shared/checklist',
    ].join('\n'));
    writeFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'skills.json'), JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'release-gate',
          kind: 'skill',
          name: 'Release Gate',
          summary: 'Runs release certification and deploy checks',
          source: './catalog/skills/release-gate',
          tags: ['release', 'ops'],
          installHint: 'Place under .goodvibes/skills/release-gate/SKILL.md.',
        },
      ],
    }, null, 2));

    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const skills = registry.get('skills');
    expect(skills).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out);

    await skills!.handler(['browse'], ctx);
    expect(out.join('\n')).toContain('Curated Skill Catalog');
    expect(out.join('\n')).toContain('release-gate');

    out.length = 0;
    await skills!.handler(['install-hint', 'release-gate'], ctx);
    expect(out.join('\n')).toContain('Skill Install Guidance');

    out.length = 0;
    await skills!.handler(['publish-local', 'ops-playbook', './catalog/skills/release-gate', 'Ops', 'release', 'playbook'], ctx);
    expect(out.join('\n')).toContain('Published curated skill ops-playbook');
    expect(readFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'skills.json'), 'utf-8')).toContain('"ops-playbook"');

    out.length = 0;
    await skills!.handler(['catalog-review', 'release-gate'], ctx);
    expect(out.join('\n')).toContain('Skill Catalog Review');
    expect(out.join('\n')).toContain('sourceKind: local-path');

    out.length = 0;
    await skills!.handler(['install', 'release-gate', 'project'], ctx);
    expect(out.join('\n')).toContain('Installed curated skill');
    expect(existsSync(join(root, '.goodvibes', 'skills', 'release-gate', 'SKILL.md'))).toBe(true);

    out.length = 0;
    await skills!.handler(['installed'], ctx);
    expect(out.join('\n')).toContain('Installed Curated Skills');

    out.length = 0;
    await skills!.handler(['update', 'release-gate', 'project'], ctx);
    expect(out.join('\n')).toContain('Updated curated skill');

    out.length = 0;
    await skills!.handler(['uninstall', 'release-gate', 'project'], ctx);
    expect(out.join('\n')).toContain('Uninstalled curated skill');

    out.length = 0;
    await skills!.handler(['unpublish', 'ops-playbook'], ctx);
    expect(out.join('\n')).toContain('Removed curated skill ops-playbook');
  });

  test('config bundle exports and imports portable operator bundles', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const command = registry.get('config');
    expect(command).toBeDefined();

    const values = new Map<ConfigKey, unknown>();
    for (const entry of CONFIG_SCHEMA) {
      values.set(entry.key, structuredClone(entry.default));
    }
    values.set('provider.model', 'model-1');
    values.set('behavior.autoApprove', true);

    mkdirSync(join(root, '.goodvibes', 'tui', 'ecosystem'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'tui', 'services.json'), JSON.stringify({
      github: {
        name: 'github',
        baseUrl: 'https://api.github.com',
        authType: 'bearer',
        tokenKey: 'GITHUB_TOKEN',
      },
    }, null, 2));
    writeFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'plugins.json'), JSON.stringify({
      version: 1,
      entries: [{ id: 'deploy-audit', kind: 'plugin', name: 'Deploy Audit', summary: 'Review deploys', source: 'repo', tags: [] }],
    }, null, 2));

    const out: string[] = [];
    const ctx = makeContext(out);
    ctx.configManager = {
      get: (key: ConfigKey) => values.get(key),
      getAll: () => ({}),
      setDynamic: (key: ConfigKey, value: unknown) => { values.set(key, value); },
    } as never;

    const bundlePath = join(root, 'artifacts', 'operator-bundle.json');
    await command!.handler(['bundle', 'export', bundlePath], ctx);
    expect(out.join('\n')).toContain('Config bundle exported');
    const bundleText = readFileSync(bundlePath, 'utf-8');
    expect(bundleText).toContain('"provider.model": "model-1"');
    expect(bundleText).toContain('"services"');

    values.set('provider.model', 'changed-model');
    out.length = 0;
    await command!.handler(['bundle', 'inspect', bundlePath], ctx);
    expect(out.join('\n')).toContain('Config Bundle Review');
    expect(out.join('\n')).toContain('curated plugins: 1');

    out.length = 0;
    await command!.handler(['bundle', 'import', bundlePath], ctx);
    expect(out.join('\n')).toContain('Config bundle imported');
    expect(values.get('provider.model')).toBe('model-1');
  });

  test('setup transfer and links expose self-hosted platform-service flows', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const setup = registry.get('setup');
    expect(setup).toBeDefined();

    const out: string[] = [];
    const ctx: ReturnType<typeof makeContext> & { openSecurityPanel?: () => void } = makeContext(out);
    const transferPath = join(root, 'artifacts', 'setup-transfer.json');

    await setup!.handler(['transfer', 'export', transferPath], ctx);
    expect(out.join('\n')).toContain('Exported setup transfer bundle');
    expect(existsSync(transferPath)).toBe(true);

    out.length = 0;
    await setup!.handler(['transfer', 'inspect', transferPath], ctx);
    expect(out.join('\n')).toContain('Setup Transfer Review');

    out.length = 0;
    await setup!.handler(['link', 'security', 'incident-1'], ctx);
    expect(out.join('\n')).toContain('goodvibes://open/security');

    out.length = 0;
    ctx.openSecurityPanel = () => { out.push('opened-security-panel'); };
    await setup!.handler(['open-link', 'goodvibes://open/security?target=incident-1'], ctx);
    expect(out.join('\n')).toContain('opened-security-panel');
    expect(out.join('\n')).toContain('Opened setup link for security');
  });

  test('incident command can summarize, export, and capture bundles', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const incident = registry.get('incident');
    expect(incident).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out);
    const incidentPath = join(root, 'artifacts', 'incident.json');

    await incident!.handler(['show', 'latest'], ctx);
    expect(out.join('\n')).toContain('Incident incident-1');
    expect(out.join('\n')).toContain('root cause');

    out.length = 0;
    await incident!.handler(['export', 'latest', incidentPath], ctx);
    expect(out.join('\n')).toContain('Exported incident bundle');
    expect(existsSync(incidentPath)).toBe(true);

    out.length = 0;
    await incident!.handler(['capture', 'latest'], ctx);
    expect(out.join('\n')).toContain('Captured incident incident-1 into durable memory');
  });

  test('trust command exports review posture and portable trust bundles', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const trust = registry.get('trust');
    expect(trust).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out);
    ctx.runtimeStore!.setState((state) => ({
      ...state,
      mcp: {
        ...state.mcp,
        servers: new Map([
          ['docs', {
            name: 'docs',
            displayName: 'Docs',
            status: 'connected',
            transport: 'stdio',
            toolCount: 1,
            toolNames: ['docs__search'],
            callCount: 0,
            errorCount: 0,
            reconnectAttempts: 0,
            role: 'docs',
            trustMode: 'constrained',
            allowedPaths: [],
            allowedHosts: [],
            schemaFreshness: 'fresh',
          }],
        ]),
      },
    }));

    await trust!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Trust Review');
    expect(out.join('\n')).toContain('permission mode:');

    const bundlePath = join(root, 'artifacts', 'trust-bundle.json');
    out.length = 0;
    await trust!.handler(['bundle', 'export', bundlePath], ctx);
    expect(out.join('\n')).toContain('Trust bundle exported');
    expect(existsSync(bundlePath)).toBe(true);

    out.length = 0;
    await trust!.handler(['bundle', 'inspect', bundlePath], ctx);
    expect(out.join('\n')).toContain('Trust Bundle Review');
  });

  test('marketplace command exposes combined ecosystem flows', async () => {
    mkdirSync(join(root, '.goodvibes', 'tui', 'ecosystem'), { recursive: true });
    mkdirSync(join(root, 'catalog', 'plugins', 'deploy-audit'), { recursive: true });
    mkdirSync(join(root, 'catalog', 'skills', 'release-gate'), { recursive: true });
    mkdirSync(join(root, 'catalog', 'hooks', 'guard-pack'), { recursive: true });
    mkdirSync(join(root, 'catalog', 'policies', 'strict-policy'), { recursive: true });
    writeFileSync(join(root, 'catalog', 'plugins', 'deploy-audit', 'manifest.json'), JSON.stringify({
      name: 'deploy-audit',
      version: '1.0.0',
      description: 'Reviews deploy surfaces before release',
    }, null, 2));
    writeFileSync(join(root, 'catalog', 'plugins', 'deploy-audit', 'index.ts'), 'export function init() {}\n');
    writeFileSync(join(root, 'catalog', 'skills', 'release-gate', 'SKILL.md'), [
      '---',
      'name: release-gate',
      'description: Runs release certification and deploy checks',
      '---',
      '',
      '@shared/checklist',
    ].join('\n'));
    writeFileSync(join(root, 'catalog', 'hooks', 'guard-pack', 'hooks.json'), JSON.stringify({
      hooks: { 'Pre:tool:*': [{ name: 'guard-edit', match: 'Pre:tool:*', type: 'command', command: 'echo guard' }] },
      chains: [],
    }, null, 2));
    writeFileSync(join(root, 'catalog', 'policies', 'strict-policy', 'policy.json'), JSON.stringify({
      bundleId: 'strict-policy',
      rules: [{ id: 'deny-exec', action: 'deny', match: { tool: 'exec' } }],
    }, null, 2));
    writeFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'plugins.json'), JSON.stringify({
      version: 1,
      entries: [{
        id: 'deploy-audit',
        kind: 'plugin',
        name: 'Deploy Audit',
        summary: 'Reviews deploy surfaces before release',
        version: '1.0.0',
        author: 'GoodVibes',
        source: './catalog/plugins/deploy-audit',
        tags: ['security'],
        provenance: 'curated-local',
        compatibility: { minAppVersion: '0.14.0' },
      }],
    }, null, 2));
    writeFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'skills.json'), JSON.stringify({
      version: 1,
      entries: [{
        id: 'release-gate',
        kind: 'skill',
        name: 'Release Gate',
        summary: 'Runs release certification and deploy checks',
        source: './catalog/skills/release-gate',
        tags: ['release'],
      }],
    }, null, 2));
    writeFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'hook-packs.json'), JSON.stringify({
      version: 1,
      entries: [{
        id: 'guard-pack',
        kind: 'hook-pack',
        name: 'Guard Pack',
        summary: 'Shared hook guards for risky tool paths',
        source: './catalog/hooks/guard-pack',
        tags: ['hooks', 'security'],
      }],
    }, null, 2));
    writeFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'policy-packs.json'), JSON.stringify({
      version: 1,
      entries: [{
        id: 'strict-policy',
        kind: 'policy-pack',
        name: 'Strict Policy',
        summary: 'Operator-reviewed restrictive policy pack',
        source: './catalog/policies/strict-policy',
        tags: ['policy', 'security'],
      }],
    }, null, 2));

    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const marketplace = registry.get('marketplace');
    expect(marketplace).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out);

    await marketplace!.handler(['overview'], ctx);
    expect(out.join('\n')).toContain('Marketplace Overview');
    expect(out.join('\n')).toContain('curated plugins: 1');

    out.length = 0;
    await marketplace!.handler(['recommend'], ctx);
    expect(out.join('\n')).toContain('Marketplace Recommendations');

    out.length = 0;
    await marketplace!.handler(['browse'], ctx);
    expect(out.join('\n')).toContain('Marketplace Browse');
    expect(out.join('\n')).toContain('deploy-audit');
    expect(out.join('\n')).toContain('release-gate');
    expect(out.join('\n')).toContain('guard-pack');
    expect(out.join('\n')).toContain('strict-policy');

    out.length = 0;
    await marketplace!.handler(['review', 'plugin', 'deploy-audit'], ctx);
    expect(out.join('\n')).toContain('Marketplace Review: Deploy Audit');
    expect(out.join('\n')).toContain('compatibility:');

    out.length = 0;
    await marketplace!.handler(['provenance', 'plugin', 'deploy-audit'], ctx);
    expect(out.join('\n')).toContain('Marketplace Provenance: Deploy Audit');
    expect(out.join('\n')).toContain('curated-local');

    out.length = 0;
    await marketplace!.handler(['install-hint', 'skill', 'release-gate'], ctx);
    expect(out.join('\n')).toContain('Marketplace Install Guidance: Release Gate');

    out.length = 0;
    await marketplace!.handler(['install', 'hook-pack', 'guard-pack', 'project'], ctx);
    expect(out.join('\n')).toContain('Installed curated hook-pack guard-pack');

    out.length = 0;
    await marketplace!.handler(['install', 'policy-pack', 'strict-policy', 'project'], ctx);
    expect(out.join('\n')).toContain('Installed curated policy-pack strict-policy');

    out.length = 0;
    await marketplace!.handler(['install', 'plugin', 'deploy-audit', 'project'], ctx);
    expect(out.join('\n')).toContain('Installed curated plugin deploy-audit');
    const installedPluginPath = join(root, '.goodvibes', 'plugins', 'deploy-audit', 'index.ts');
    expect(readFileSync(installedPluginPath, 'utf-8')).toContain('init');

    out.length = 0;
    await marketplace!.handler(['installed'], ctx);
    expect(out.join('\n')).toContain('Marketplace Installs');
    expect(out.join('\n')).toContain('deploy-audit');
    expect(out.join('\n')).toContain('guard-pack');
    expect(out.join('\n')).toContain('strict-policy');

    out.length = 0;
    await marketplace!.handler(['receipt', 'plugin', 'deploy-audit', 'project'], ctx);
    expect(out.join('\n')).toContain('Marketplace Receipt: Deploy Audit');
    expect(out.join('\n')).toContain('fingerprint:');

    writeFileSync(join(root, 'catalog', 'plugins', 'deploy-audit', 'index.ts'), 'export function init() { return "updated"; }\n');
    out.length = 0;
    await marketplace!.handler(['update', 'plugin', 'deploy-audit', 'project'], ctx);
    expect(out.join('\n')).toContain('Updated curated plugin deploy-audit');
    expect(readFileSync(installedPluginPath, 'utf-8')).toContain('updated');

    out.length = 0;
    await marketplace!.handler(['history', 'plugin', 'deploy-audit', 'project'], ctx);
    expect(out.join('\n')).toContain('Marketplace Rollback History: plugin deploy-audit');
    expect(out.join('\n')).toContain('update');

    out.length = 0;
    await marketplace!.handler(['rollback', 'plugin', 'deploy-audit', 'project'], ctx);
    expect(out.join('\n')).toContain('Rolled back curated plugin deploy-audit');
    expect(readFileSync(installedPluginPath, 'utf-8')).toContain('export function init() {}');

    const bundlePath = join(root, 'artifacts', 'marketplace-bundle.json');
    out.length = 0;
    await marketplace!.handler(['bundle', 'export', bundlePath, 'project'], ctx);
    expect(out.join('\n')).toContain('Marketplace bundle exported');
    expect(existsSync(bundlePath)).toBe(true);

    out.length = 0;
    await marketplace!.handler(['bundle', 'inspect', bundlePath], ctx);
    expect(out.join('\n')).toContain('Marketplace Bundle Review');

    out.length = 0;
    await marketplace!.handler(['bundle', 'import', bundlePath, 'user'], ctx);
    expect(out.join('\n')).toContain('Marketplace bundle imported');

    out.length = 0;
    await marketplace!.handler(['uninstall', 'plugin', 'deploy-audit', 'project'], ctx);
    expect(out.join('\n')).toContain('Uninstalled curated plugin deploy-audit');
  });

  test('bridge command exposes bridge pools, contracts, and artifact review', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const bridge = registry.get('bridge');
    expect(bridge).toBeDefined();

    const remote = getRemoteRunnerRegistry();
    remote.createPool({ id: 'ops-pool', label: 'Ops Pool' });
    remote.registerContract({
      id: 'runner:agent-remote',
      runnerId: 'agent-remote',
      poolId: 'ops-pool',
      taskId: 'task-remote',
      label: 'Ops Runner',
      sourceTransport: 'acp',
      trustClass: 'self-hosted-acp',
      template: 'general',
      capabilityCeiling: {
        allowedTools: ['read', 'edit'],
        capabilityCeilingTools: ['read', 'edit'],
        executionProtocol: 'gather-plan-apply',
        reviewMode: 'wrfc',
        communicationLane: 'parent-only',
        orchestrationDepth: 2,
        successCriteria: ['clean result'],
        requiredEvidence: ['summary'],
        writeScope: ['src/**'],
      },
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      transport: {
        state: 'connected',
        connectedAt: Date.now(),
        messageCount: 2,
        errorCount: 0,
      },
    });
    const importedArtifactPath = join(root, 'artifacts', 'remote-artifact.json');
    mkdirSync(dirname(importedArtifactPath), { recursive: true });
    writeFileSync(importedArtifactPath, JSON.stringify({
      id: 'artifact:agent-remote:1',
      runnerId: 'agent-remote',
      createdAt: Date.now(),
      runnerContract: remote.getContract('agent-remote'),
      task: {
        task: 'Review release surfaces',
        status: 'completed',
        startedAt: Date.now() - 1000,
        completedAt: Date.now(),
        summary: 'Completed remote review',
      },
      evidence: {
        toolCallCount: 3,
        messageCount: 2,
        errorCount: 0,
        transportState: 'connected',
        hasKnowledgeInjections: false,
      },
      knowledgeInjections: [],
    }, null, 2));

    const out: string[] = [];
    const ctx = makeContext(out);

    await bridge!.handler(['status'], ctx);
    expect(out.join('\n')).toContain('Bridge Status');

    out.length = 0;
    await bridge!.handler(['pools'], ctx);
    expect(out.join('\n')).toContain('Bridge Pools');
    expect(out.join('\n')).toContain('ops-pool');

    out.length = 0;
    await bridge!.handler(['runner', 'agent-remote'], ctx);
    expect(out.join('\n')).toContain('Bridge Runner agent-remote');

    out.length = 0;
    await bridge!.handler(['import', importedArtifactPath], ctx);
    expect(out.join('\n')).toContain('Imported remote bridge artifact');

    out.length = 0;
    await bridge!.handler(['review', 'artifact:agent-remote:1'], ctx);
    expect(out.join('\n')).toContain('Remote Artifact artifact:agent-remote:1');

    const exportedPath = join(root, 'artifacts', 'bridge-export.json');
    out.length = 0;
    await bridge!.handler(['export', 'artifact:agent-remote:1', exportedPath], ctx);
    expect(out.join('\n')).toContain('Exported remote bridge artifact');
    expect(existsSync(exportedPath)).toBe(true);
  });

  test('release command exposes certification review and release bundles', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const release = registry.get('release');
    expect(release).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out);

    await release!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Release Review');
    expect(out.join('\n')).toContain('eval suites:');

    out.length = 0;
    await release!.handler(['checklist'], ctx);
    expect(out.join('\n')).toContain('Release Checklist');
    expect(out.join('\n')).toContain('/eval gate <suite>');

    const bundlePath = join(root, 'artifacts', 'release-bundle.json');
    out.length = 0;
    await release!.handler(['bundle', 'export', bundlePath], ctx);
    expect(out.join('\n')).toContain('Release bundle exported');
    expect(existsSync(bundlePath)).toBe(true);

    out.length = 0;
    await release!.handler(['bundle', 'inspect', bundlePath], ctx);
    expect(out.join('\n')).toContain('Release Bundle Review');
  });

  test('profilesync command exports and imports portable profile bundles', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const profilesync = registry.get('profilesync');
    const config = registry.get('config');
    expect(profilesync).toBeDefined();
    expect(config).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out);

    await config!.handler(['profile', 'save', 'release'], ctx);
    expect(out.join('\n')).toContain('Profile saved: release');

    const bundlePath = join(root, 'artifacts', 'profiles.json');
    out.length = 0;
    await profilesync!.handler(['export', bundlePath], ctx);
    expect(out.join('\n')).toContain('Profile sync bundle exported');
    expect(existsSync(bundlePath)).toBe(true);

    out.length = 0;
    await profilesync!.handler(['inspect', bundlePath], ctx);
    expect(out.join('\n')).toContain('Profile Sync Bundle Review');

    out.length = 0;
    await profilesync!.handler(['import', bundlePath, 'team'], ctx);
    expect(out.join('\n')).toContain('Profile sync bundle imported');

    out.length = 0;
    await profilesync!.handler(['list'], ctx);
    expect(out.join('\n')).toContain('team-release');
  });

  test('managed command exports, inspects, and applies managed settings bundles', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const managed = registry.get('managed');
    const config = registry.get('config');
    const settingsSync = registry.get('settingssync');
    expect(managed).toBeDefined();
    expect(config).toBeDefined();
    expect(settingsSync).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out);

    await config!.handler(['provider.model', 'model-1'], ctx);
    out.length = 0;
    await config!.handler(['profile', 'save', 'ops'], ctx);
    expect(out.join('\n')).toContain('Profile saved: ops');

    const bundlePath = join(root, 'artifacts', 'managed.json');
    out.length = 0;
    await managed!.handler(['export', 'ops', bundlePath], ctx);
    expect(out.join('\n')).toContain('Managed settings bundle exported');

    out.length = 0;
    await managed!.handler(['inspect', bundlePath], ctx);
    expect(out.join('\n')).toContain('Managed Settings Review');
    expect(out.join('\n')).toContain('changes:');

    await config!.handler(['provider.model', 'changed-model'], ctx);
    out.length = 0;
    await managed!.handler(['apply', bundlePath], ctx);
    expect(out.join('\n')).toContain('Managed settings bundle applied');
    expect(ctx.runtime.model).toBe('model-1');

    const rollbackToken = out.join('\n').match(/rollback ([A-Za-z0-9-]+)/)?.[1];
    expect(rollbackToken).toBeDefined();

    out.length = 0;
    await managed!.handler(['rollback', rollbackToken!], ctx);
    expect(out.join('\n')).toContain('Managed rollback');

    const syncPath = join(root, 'artifacts', 'settings-sync.json');
    out.length = 0;
    await settingsSync!.handler(['export', syncPath], ctx);
    expect(out.join('\n')).toContain('Settings sync bundle exported');

    out.length = 0;
    await settingsSync!.handler(['inspect', syncPath], ctx);
    expect(out.join('\n')).toContain('Settings Sync Bundle');

    out.length = 0;
    await settingsSync!.handler(['show', 'provider.model'], ctx);
    expect(out.join('\n')).toContain('Resolved Setting Review');
    expect(out.join('\n')).toContain('key: provider.model');

    await config!.handler(['provider.model', 'sync-model'], ctx);
    out.length = 0;
    await settingsSync!.handler(['pull', syncPath], ctx);
    expect(out.join('\n')).toContain('Settings sync bundle pulled');

    out.length = 0;
    await managed!.handler(['stage', bundlePath], ctx);
    expect(out.join('\n')).toContain('Managed settings bundle staged');

    out.length = 0;
    await managed!.handler(['staged'], ctx);
    expect(out.join('\n')).toContain('Staged Managed Bundle Review');
  });

  test('config profile load restores saved provider settings', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const config = registry.get('config');
    expect(config).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out);

    await config!.handler(['provider.model', 'model-1'], ctx);
    out.length = 0;
    await config!.handler(['profile', 'save', 'restore-me'], ctx);
    expect(out.join('\n')).toContain('Profile saved: restore-me');

    await config!.handler(['provider.model', 'changed-model'], ctx);
    expect(ctx.runtime.model).toBe('changed-model');

    out.length = 0;
    await config!.handler(['profile', 'load', 'restore-me'], ctx);
    expect(out.join('\n')).toContain('Profile loaded: restore-me');
    expect(ctx.runtime.model).toBe('model-1');
  });

  test('session command surfaces saved return-context posture in list and info output', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const session = registry.get('session');
    expect(session).toBeDefined();

    const out: string[] = [];
    const ctx: any = makeContext(out);
    ctx.conversationManager.title = 'Resume Me';
    ctx.runtime.sessionId = 'sess-demo';
    ctx.conversationManager.toJSON = () => ({
      messages: [{ role: 'user', content: 'hello' }],
      title: 'Resume Me',
      returnContext: {
        summary: 'returning to blocked work',
        lines: ['Pending approvals spotted: 2', 'Remote runners: runner-a', 'Worktree paths: /tmp/demo-worktree', 'Open panels: remote, approval'],
        pendingApprovals: 2,
        activeTasks: 1,
        blockedTasks: 1,
        remoteContracts: 1,
        remoteRunners: ['runner-a'],
        worktreeCount: 1,
        worktreePaths: ['/tmp/demo-worktree'],
        openPanels: ['remote', 'approval'],
      },
    }) as never;

    await session!.handler(['save', 'resume-demo'], ctx);
    expect(out.join('\n')).toContain('Session saved:');

    out.length = 0;
    await session!.handler(['list'], ctx);
    expect(out.join('\n')).toContain('posture:');
    expect(out.join('\n')).toContain('approvals=2');

    out.length = 0;
    await session!.handler(['info', 'resume-demo'], ctx);
    expect(out.join('\n')).toContain('Pending approvals spotted: 2');
    expect(out.join('\n')).toContain('Remote runners: runner-a');
    expect(out.join('\n')).toContain('Worktree paths: /tmp/demo-worktree');
    expect(out.join('\n')).toContain('Open panels: remote, approval');
  });

  test('install command exports and inspects install bundles', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const install = registry.get('install');
    expect(install).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out);

    await install!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Install Review');

    const bundlePath = join(root, 'artifacts', 'install.json');
    out.length = 0;
    await install!.handler(['bundle', 'export', bundlePath], ctx);
    expect(out.join('\n')).toContain('Install bundle exported');
    expect(existsSync(bundlePath)).toBe(true);

    out.length = 0;
    await install!.handler(['bundle', 'inspect', bundlePath], ctx);
    expect(out.join('\n')).toContain('Install Bundle Review');
  });

  test('update command reviews channel posture and exports update bundles', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const update = registry.get('update');
    expect(update).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out);

    await update!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Update Review');
    expect(out.join('\n')).toContain('channel:');

    out.length = 0;
    await update!.handler(['channel', 'preview'], ctx);
    expect(out.join('\n')).toContain('Update channel set to preview.');

    const bundlePath = join(root, 'artifacts', 'update.json');
    out.length = 0;
    await update!.handler(['bundle', 'export', bundlePath], ctx);
    expect(out.join('\n')).toContain('Update bundle exported');

    out.length = 0;
    await update!.handler(['bundle', 'inspect', bundlePath], ctx);
    expect(out.join('\n')).toContain('Update Bundle Review');
  });

  test('auth command exports review bundles and exchanges session tokens with local services', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const auth = registry.get('auth');
    expect(auth).toBeDefined();
    getSubscriptionManager().logout('openai');
    getSubscriptionManager().logout('anthropic');
    getSubscriptionManager().savePending({
      provider: 'openai',
      state: 'pending-state',
      verifier: 'pending-verifier',
      redirectUri: 'http://localhost:1455/auth/callback',
      createdAt: Date.now(),
    });

    const out: string[] = [];
    const ctx = makeContext(out);

    await auth!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Auth Review');
    expect(out.join('\n')).toContain('pending subscriptions: 1 (openai)');

    out.length = 0;
    await auth!.handler(['show', 'openai'], ctx);
    expect(out.join('\n')).toContain('Auth Provider openai');
    expect(out.join('\n')).toContain('callbackMode: local');
    expect(out.join('\n')).toContain('pendingLogin: yes');

    const bundlePath = join(root, 'artifacts', 'auth.json');
    out.length = 0;
    await auth!.handler(['bundle', 'export', bundlePath], ctx);
    expect(out.join('\n')).toContain('Auth review bundle exported');

    out.length = 0;
    await auth!.handler(['bundle', 'inspect', bundlePath], ctx);
    expect(out.join('\n')).toContain('Auth Review Bundle');
    expect(out.join('\n')).toContain('active subscriptions: 0');

    const { DaemonServer } = await import('../../daemon/server.ts');
    const { UserAuthManager } = await import('../../security/user-auth.ts');
    const daemon = new DaemonServer({
      port: 39451,
      host: '127.0.0.1',
      userAuth: new UserAuthManager({
        users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
      }),
    });
    daemon.enable({ daemon: true });
    await daemon.start();
    try {
      out.length = 0;
      await auth!.handler(['login', 'daemon', 'http://127.0.0.1:39451', 'admin', 'admin', 'DAEMON_SESSION'], ctx);
      expect(out.join('\n')).toContain('Stored daemon session token');
    } finally {
      await daemon.stop();
    }
  });

  test('login and logout commands provide a packaged auth front door', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const login = registry.get('login');
    const logout = registry.get('logout');
    expect(login).toBeDefined();
    expect(logout).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out) as ReturnType<typeof makeContext> & Pick<CommandContext, 'executeCommand'>;
    ctx.executeCommand = async (name: string, args: string[]) => registry.execute(name, args, ctx as never);
    _setSubscriptionBrowserOpenerForTesting(async () => true);

    await login!.handler(['provider', 'openai', 'start', '--manual'], ctx);
    expect(out.join('\n')).toContain('Subscription OAuth Start: openai');
    expect(out.join('\n')).toContain('source: builtin');
    expect(out.join('\n')).toContain('browser: opened');

    out.length = 0;
    globalThis.fetch = ((async () => ({
      ok: true,
      json: async () => ({ access_token: 'oauth-openai-token', refresh_token: 'oauth-openai-refresh', token_type: 'Bearer', expires_in: 3600 }),
    })) as unknown) as typeof fetch;
    await login!.handler(['provider', 'openai', 'finish', 'oauth-code-456'], ctx);
    expect(out.join('\n')).toContain('Stored subscription session for openai.');

    out.length = 0;
    await logout!.handler(['provider', 'openai'], ctx);
    expect(out.join('\n')).toContain('Logged out of openai.');
  });

  test('sandbox command probes host posture and exports bundles', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const sandbox = registry.get('sandbox');
    expect(sandbox).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out);

    await sandbox!.handler(['probe'], ctx);
    expect(out.join('\n')).toContain('Sandbox Probe');

    const bundlePath = join(root, 'artifacts', 'sandbox.json');
    out.length = 0;
    await sandbox!.handler(['bundle', 'export', bundlePath], ctx);
    expect(out.join('\n')).toContain('Sandbox bundle exported');

    out.length = 0;
    await sandbox!.handler(['bundle', 'inspect', bundlePath], ctx);
    expect(out.join('\n')).toContain('Sandbox Bundle Review');

    out.length = 0;
    await sandbox!.handler(['session', 'start', 'eval-py', 'Python', 'isolation'], ctx);
    expect(out.join('\n')).toContain('Started sandbox session');
    expect(out.join('\n')).toContain('startup=');

    out.length = 0;
    await sandbox!.handler(['session', 'list'], ctx);
    expect(out.join('\n')).toContain('Sandbox Sessions');
    expect(out.join('\n')).toContain('eval-py');

    const sessionIdMatch = out.join('\n').match(/sandbox_[a-z0-9_]+/i);
    expect(sessionIdMatch).not.toBeNull();

    out.length = 0;
    await sandbox!.handler(['session', 'inspect', sessionIdMatch![0]], ctx);
    expect(out.join('\n')).toContain(`Sandbox session ${sessionIdMatch![0]}`);
    expect(out.join('\n')).toContain('profile: eval-py');

    out.length = 0;
    await sandbox!.handler(['session', 'run', sessionIdMatch![0], 'bash', '-lc', 'printf session-run-ok'], ctx);
    expect(out.join('\n')).toContain('Sandbox session run');
    expect(out.join('\n')).toContain('session-run-ok');

    const wrapperPath = join(root, 'artifacts', 'qemu-wrapper.sh');
    out.length = 0;
    await sandbox!.handler(['scaffold-qemu-wrapper', wrapperPath], ctx);
    expect(out.join('\n')).toContain('Scaffolded QEMU wrapper');

    out.length = 0;
    await sandbox!.handler(['guest-test', 'eval-js'], ctx);
    expect(out.join('\n')).toContain('Sandbox guest test requires sandbox.qemuGuestHost');

    const initDir = join(root, 'artifacts', 'qemu-init');
    out.length = 0;
    await sandbox!.handler(['init-qemu', initDir], ctx);
    expect(out.join('\n')).toContain('Initialized QEMU sandbox bundle');
    expect(existsSync(join(initDir, 'qemu-wrapper.sh'))).toBe(true);
    expect(existsSync(join(initDir, 'guest-bundle.json'))).toBe(true);
    expect(existsSync(join(initDir, 'README.txt'))).toBe(true);

    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    const qemuImgPath = join(binDir, 'qemu-img');
    writeFileSync(qemuImgPath, '#!/usr/bin/env bash\nset -euo pipefail\n: "${4:?missing image path}"\nmkdir -p "$(dirname "$4")"\n: > "$4"\n', 'utf-8');
    chmodSync(qemuImgPath, 0o755);
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
    process.env.QEMU_IMG_BIN = qemuImgPath;

    out.length = 0;
    await sandbox!.handler(['qemu', 'bootstrap', join(root, 'artifacts', 'qemu-bootstrap'), '1'], ctx);
    expect(out.join('\n')).toContain('Bootstrapped QEMU sandbox');
    expect(out.join('\n')).toContain('applied: backend=qemu');

    out.length = 0;
    await sandbox!.handler(['set-qemu-guest-host', '127.0.0.1'], ctx);
    await sandbox!.handler(['set-qemu-guest-port', '2222'], ctx);
    await sandbox!.handler(['set-qemu-guest-user', 'goodvibes'], ctx);
    await sandbox!.handler(['set-qemu-workspace', '/workspace'], ctx);
    await sandbox!.handler(['set-qemu-session-mode', 'launch-per-command'], ctx);
    expect(out.join('\n')).toContain('Sandbox QEMU guest host set to 127.0.0.1.');
    expect(out.join('\n')).toContain('Sandbox QEMU guest workspace set to /workspace.');
    expect(out.join('\n')).toContain('Sandbox QEMU session mode set to launch-per-command.');
  });

  test('subscription command manages oauth-backed provider sessions and logout', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const subscription = registry.get('subscription');
    expect(subscription).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out);
    _setSubscriptionBrowserOpenerForTesting(async () => true);

    await subscription!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('No provider subscriptions stored yet');

    out.length = 0;
    await subscription!.handler(['login', 'openai', 'start', '--manual'], ctx);
    expect(out.join('\n')).toContain('Subscription OAuth Start: openai');
    expect(out.join('\n')).toContain('source: builtin');
    expect(out.join('\n')).toContain('browser: opened');
    expect(out.join('\n')).toContain('authorizationUrl:');

    globalThis.fetch = ((async () => ({
      ok: true,
      json: async () => ({ access_token: 'oauth-openai-token', refresh_token: 'oauth-openai-refresh', token_type: 'Bearer', expires_in: 3600 }),
    })) as unknown) as typeof fetch;

    out.length = 0;
    await subscription!.handler(['login', 'openai', 'finish', 'oauth-code-123'], ctx);
    expect(out.join('\n')).toContain('Stored subscription session for openai');
    expect(out.join('\n')).toContain('stored for subscription-backed flows only');

    out.length = 0;
    await subscription!.handler(['inspect', 'openai'], ctx);
    expect(out.join('\n')).toContain('Subscription openai');
    expect(out.join('\n')).toContain('freshness: expiring');
    expect(out.join('\n')).toContain('callbackMode: local');

    out.length = 0;
    await subscription!.handler(['logout', 'openai'], ctx);
    expect(out.join('\n')).toContain('Logged out of openai');
  });

  test('sandbox command reviews and updates isolation posture', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const sandbox = registry.get('sandbox');
    expect(sandbox).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out);

    await sandbox!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Sandbox Review');
    expect(out.join('\n')).toContain('repl isolation');

    out.length = 0;
    await sandbox!.handler(['recommend'], ctx);
    expect(out.join('\n')).toContain('Sandbox Recommendation');

    out.length = 0;
    await sandbox!.handler(['profiles'], ctx);
    expect(out.join('\n')).toContain('Sandbox Profiles');

    out.length = 0;
    await sandbox!.handler(['set-mcp', 'per-server-vm'], ctx);
    expect(out.join('\n')).toContain('Sandbox MCP isolation set to per-server-vm');

    out.length = 0;
    await sandbox!.handler(['set-repl', 'shared-vm'], ctx);
    expect(out.join('\n')).toContain('Sandbox REPL isolation set to shared-vm');
  });

  test('storage and deeplink commands expose platform-service breadth', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const storage = registry.get('storage');
    const helpers = registry.get('helpers');
    const deeplink = registry.get('deeplink');
    expect(storage).toBeDefined();
    expect(helpers).toBeDefined();
    expect(deeplink).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out);

    await storage!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Secure Storage Review');
    expect(out.join('\n')).toContain('policy:');

    out.length = 0;
    await helpers!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Integration Helper Review');
    expect(out.join('\n')).toContain('GET /api/session');
    expect(out.join('\n')).toContain('GET /api/settings');

    out.length = 0;
    const storageBundle = join(root, 'artifacts', 'storage-bundle.json');
    await storage!.handler(['bundle', 'export', storageBundle], ctx);
    expect(out.join('\n')).toContain('Secure storage bundle exported');
    expect(existsSync(storageBundle)).toBe(true);

    out.length = 0;
    await deeplink!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Deep Link Review');
    expect(out.join('\n')).toContain('goodvibes://open/marketplace');

    out.length = 0;
    const deeplinkBundle = join(root, 'artifacts', 'deeplink-bundle.json');
    await deeplink!.handler(['bundle', 'export', deeplinkBundle], ctx);
    expect(out.join('\n')).toContain('Deep link bundle exported');
    expect(existsSync(deeplinkBundle)).toBe(true);
  });

  test('teamwork command exposes packaged modes, recipes, and task creation', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const teamwork = registry.get('teamwork');
    expect(teamwork).toBeDefined();

    const out: string[] = [];
    const created: Array<{ kind: string; owner: string; title: string; description?: string }> = [];
    const ctx = makeContext(out) as ReturnType<typeof makeContext> & { taskManager?: TaskManager };
    ctx.taskManager = {
      createTask(input: { kind: string; owner: string; title: string; description?: string }) {
        created.push(input);
        return { id: `task-${created.length}` };
      },
    } as never;

    await teamwork!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Teamwork Review');
    expect(out.join('\n')).toContain('modes:');

    out.length = 0;
    await teamwork!.handler(['modes'], ctx);
    expect(out.join('\n')).toContain('Teamwork Modes');
    expect(out.join('\n')).toContain('remote-engineer');
    expect(out.join('\n')).toContain('dream');

    out.length = 0;
    await teamwork!.handler(['recipes'], ctx);
    expect(out.join('\n')).toContain('Teamwork Recipes');
    expect(out.join('\n')).toContain('remote-certification');
    expect(out.join('\n')).toContain('dream-then-certify');

    out.length = 0;
    await teamwork!.handler(['create-mode', 'remote-engineer', 'Remote', 'bridge', 'certification'], ctx);
    expect(out.join('\n')).toContain('Created teamwork task');
    expect(created[0]?.kind).toBe('acp');
    expect(created[0]?.owner).toBe('remote-engineer');

    mkdirSync(join(root, '.goodvibes', 'agents'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'agents', 'doc-specialist.md'), [
      '---',
      'name: doc-specialist',
      'description: Documentation specialist for operator handoff notes',
      'tools: [read, write, analyze]',
      '---',
      '',
      'You write precise operator-facing docs.',
    ].join('\n'));

    out.length = 0;
    await teamwork!.handler(['archetypes'], ctx);
    expect(out.join('\n')).toContain('doc-specialist');
    expect(out.join('\n')).toContain('implement');

    out.length = 0;
    await teamwork!.handler(['validate'], ctx);
    expect(out.join('\n')).toContain('Teamwork Archetype Validation');

    out.length = 0;
    await teamwork!.handler(['archetype', 'doc-specialist'], ctx);
    expect(out.join('\n')).toContain('Teamwork Archetype doc-specialist');
    expect(out.join('\n')).toContain('source: custom');

    out.length = 0;
    await teamwork!.handler(['create-archetype', 'doc-specialist', 'Document', 'handoff'], ctx);
    expect(out.join('\n')).toContain('Created teamwork task');
    expect(created[1]?.kind).toBe('agent');
    expect(created[1]?.owner).toBe('custom:doc-specialist');
  });

  test('health command exposes unified setup, service, sandbox, and provider surfaces', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const health = registry.get('health');
    const remote = registry.get('remote');
    const worktree = registry.get('worktree');
    expect(health).toBeDefined();
    expect(remote).toBeDefined();
    expect(worktree).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out);

    await health!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Health Review');
    expect(out.join('\n')).toContain('Next steps:');

    out.length = 0;
    await health!.handler(['services'], ctx);
    expect(out.join('\n')).toContain('Health Review: Services');

    out.length = 0;
    await health!.handler(['sandbox'], ctx);
    expect(out.join('\n')).toContain('Health Review: Sandbox');

    out.length = 0;
    await health!.handler(['auth'], ctx);
    expect(out.join('\n')).toContain('Health Review: Local Auth');

    out.length = 0;
    await health!.handler(['settings'], ctx);
    expect(out.join('\n')).toContain('Health Review: Settings');

    out.length = 0;
    await registry.get('settingssync')!.handler(['conflicts'], ctx);
    expect(out.join('\n')).toContain('Settings Sync Conflicts');

    const syncBundlePath = join(root, 'artifacts', 'settings-sync.json');
    out.length = 0;
    await registry.get('settingssync')!.handler(['push', syncBundlePath], ctx);
    expect(existsSync(syncBundlePath)).toBe(true);

    await registry.get('config')!.handler(['provider.model', 'local-conflict-model'], ctx);
    out.length = 0;
    await registry.get('settingssync')!.handler(['pull', syncBundlePath], ctx);
    expect(out.join('\n')).toContain('conflicts');

    out.length = 0;
    await registry.get('settingssync')!.handler(['resolve', 'provider.model', 'local'], ctx);
    expect(out.join('\n')).toContain('Resolved synced conflict for provider.model using the local value.');

    out.length = 0;
    await registry.get('settingssync')!.handler(['failures'], ctx);
    expect(out.join('\n')).toContain('Settings Sync Failures');

    out.length = 0;
    await registry.get('managed')!.handler(['rollback-history'], ctx);
    expect(out.join('\n')).toContain('Managed Rollback History');

    out.length = 0;
    await health!.handler(['remote'], ctx);
    expect(out.join('\n')).toContain('Health Review: Remote');

    out.length = 0;
    await health!.handler(['worktrees'], ctx);
    expect(out.join('\n')).toContain('Health Review: Worktrees');

    out.length = 0;
    await health!.handler(['repair', 'remote'], ctx);
    expect(out.join('\n')).toContain('Health Repair');
    expect(out.join('\n')).toContain('/remote supervisor');

    out.length = 0;
    await health!.handler(['repair', 'accounts'], ctx);
    expect(out.join('\n')).toContain('/accounts review');

    out.length = 0;
    await health!.handler(['repair', 'sandbox'], ctx);
    expect(out.join('\n')).toContain('/sandbox review');

    out.length = 0;
    await remote!.handler(['recover'], ctx);
    expect(out.join('\n')).toContain('No remote supervisor sessions are currently tracked.');

    out.length = 0;
    await worktree!.handler(['attach', '/tmp/demo-worktree', 'session', 'demo-session'], ctx);
    expect(out.join('\n')).toContain('Attached /tmp/demo-worktree to session demo-session.');

    out.length = 0;
    await worktree!.handler(['inspect', '/tmp/demo-worktree'], ctx);
    expect(out.join('\n')).toContain('Worktree Inspect');
    expect(out.join('\n')).toContain('/worktree session demo-session');

    out.length = 0;
    await worktree!.handler(['session', 'demo-session'], ctx);
    expect(out.join('\n')).toContain('Worktree Attachment Review: session demo-session');

    out.length = 0;
    await worktree!.handler(['recover', 'session', 'demo-session'], ctx);
    expect(out.join('\n')).toContain('Worktree Recovery: session demo-session');
  });

  test('auth command exposes local admin management surface', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const auth = registry.get('auth');
    const mcp = registry.get('mcp');
    expect(auth).toBeDefined();
    expect(mcp).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out);

    await auth!.handler(['local', 'review'], ctx);
    expect(out.join('\n')).toContain('Local Auth Review');
    expect(out.join('\n')).toContain('bootstrap file');

    out.length = 0;
    await auth!.handler(['repair', 'openai'], ctx);
    expect(out.join('\n')).toContain('Auth Repair openai');

    out.length = 0;
    await mcp!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('MCP Review');

    out.length = 0;
    await mcp!.handler(['auth-review'], ctx);
    expect(out.join('\n')).toContain('MCP Auth Review');

    out.length = 0;
    await mcp!.handler(['repair'], ctx);
    expect(out.join('\n')).toContain('MCP Repair');
  });
});
