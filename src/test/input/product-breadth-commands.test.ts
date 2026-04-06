import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { CONFIG_SCHEMA } from '../../config/index.ts';
import type { ConfigKey } from '../../config/index.ts';
import { ForensicsRegistry } from '../../runtime/forensics/registry.ts';
import type { MemoryAddOptions } from '../../state/memory-store.ts';

describe('product breadth commands', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-product-commands-'));
    process.env.HOME = root;
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
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

    out.length = 0;
    await setup!.handler(['doctor'], ctx);
    expect(out.join('\n')).toContain('Startup Doctor');
    expect(out.join('\n')).toContain('[PASS] providers:');

    out.length = 0;
    await setup!.handler(['onboarding'], ctx);
    expect(out.join('\n')).toContain('Onboarding Checklist');
    expect(out.join('\n')).toContain('/hooks scaffold');

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
});
