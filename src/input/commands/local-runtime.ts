import { dirname, join, resolve } from 'path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { writeFile, unlink, readFile } from 'node:fs/promises';
import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';
import type { ContentPart } from '../../providers/interface.ts';
import type { ConfigKey } from '../../config/index.ts';
import { CONFIG_SCHEMA } from '../../config/index.ts';
import { fetchModelContextWindows } from '../../discovery/scanner.ts';
import type { CustomProviderConfig } from '../../providers/custom-loader.ts';
import { resolveAndValidatePath } from '../../utils/path-safety.ts';
import { getBookmarkManager } from '../../bookmarks/manager.ts';
import { getSecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '../../config/service-registry.ts';
import { getPanelManager } from '../../panels/panel-manager.ts';
import { discoverSkills } from '../../panels/skills-panel.ts';
import { getTokenAuditor } from '../../security/token-audit.ts';
import { buildMcpAttackPathReview } from '../../runtime/mcp/index.ts';
import { pinModel, unpinModel, isModelPinned, getPinned } from '../../providers/favorites.ts';
import { getHookWorkbench, listHookPointContracts } from '../../hooks/index.ts';
import { AgentManager } from '../../tools/agent/index.ts';
import { AGENT_TEMPLATES } from '../../tools/agent/manager.ts';
import { exportRemoteArtifactForAgent, getRemoteRunnerRegistry, importRemoteArtifact } from '../../runtime/remote/index.ts';
import type { RuntimeTask, TaskLifecycleState } from '../../runtime/store/domains/tasks.ts';
import { pluginManager } from '../../plugins/manager.ts';
import { getPluginDirectories } from '../../plugins/loader.ts';
import { getPolicyRuntimeState } from '../../runtime/permissions/policy-runtime.ts';
import {
  installEcosystemCatalogEntry,
  listInstalledEcosystemEntries,
  loadEcosystemCatalog,
  removeEcosystemCatalogEntry,
  reviewEcosystemCatalogEntry,
  searchEcosystemCatalog,
  updateInstalledEcosystemEntry,
  upsertEcosystemCatalogEntry,
  uninstallEcosystemCatalogEntry,
} from '../../runtime/ecosystem/catalog.ts';
import { getDefaultAcpAgentCommand } from '../../acp/manager.ts';
import { buildKnowledgeInjectionPrompt, selectKnowledgeForTask } from '../../state/knowledge-injection.ts';
import { buildIncidentMemoryAddOptions } from '../../state/memory-ingest.ts';

let serviceRegistry: ServiceRegistry | undefined;
function getServiceRegistry(): ServiceRegistry {
  if (!serviceRegistry) serviceRegistry = new ServiceRegistry();
  return serviceRegistry;
}

function toggleBlocks(typeFilter: string, collapsed: boolean, ctx: CommandContext): void {
  const VALID_TYPES = ['all', 'thinking', 'tool', 'code'] as const;
  if (!VALID_TYPES.includes(typeFilter as typeof VALID_TYPES[number])) {
    ctx.print(`Unknown type: ${typeFilter}\nValid types: ${VALID_TYPES.join(', ')}`);
    return;
  }
  const blockRegistry = ctx.conversationManager.getBlockRegistry();
  if (!blockRegistry || blockRegistry.length === 0) {
    ctx.print('No blocks found.');
    return;
  }
  let count = 0;
  for (let i = 0; i < blockRegistry.length; i++) {
    const block = blockRegistry[i];
    const matchesType = typeFilter === 'all'
      || (typeFilter === 'tool' && block.type === 'tool')
      || (typeFilter === 'code' && block.type === 'code')
      || (typeFilter === 'thinking' && block.type === 'thinking');
    if (!matchesType) continue;
    const isCurrentlyCollapsed = ctx.conversationManager.isCollapsed(i);
    if (collapsed ? !isCurrentlyCollapsed : isCurrentlyCollapsed) {
      ctx.conversationManager.toggleCollapseAtLine(block.startLine);
      count++;
    }
  }
  ctx.print(`${collapsed ? 'Collapsed' : 'Expanded'} ${count} block${count !== 1 ? 's' : ''}${typeFilter !== 'all' ? ` (${typeFilter})` : ''}.`);
  ctx.renderRequest();
}

function sortRuntimeTasks(tasks: RuntimeTask[]): RuntimeTask[] {
  const statusOrder: TaskLifecycleState[] = ['running', 'queued', 'blocked', 'failed', 'completed', 'cancelled'];
  const ranking = new Map(statusOrder.map((status, index) => [status, index] as const));
  return [...tasks].sort((a, b) => {
    const rankDelta = (ranking.get(a.status) ?? 99) - (ranking.get(b.status) ?? 99);
    if (rankDelta !== 0) return rankDelta;
    const aWhen = a.startedAt ?? a.queuedAt;
    const bWhen = b.startedAt ?? b.queuedAt;
    return bWhen - aWhen;
  });
}

function summarizeTaskResult(task: RuntimeTask): string {
  const payload = (
    typeof task.result === 'string'
      ? task.result
      : task.error
        ?? (task.result !== undefined ? JSON.stringify(task.result) : task.description)
        ?? task.title
  );
  const normalized = String(payload).replace(/\s+/g, ' ').trim();
  return normalized.length <= 140 ? normalized : `${normalized.slice(0, 137)}...`;
}

interface SetupReviewSnapshot {
  readonly sessionId: string;
  readonly providerCount: number;
  readonly serviceCount: number;
  readonly serviceIssues: string[];
  readonly skillCount: number;
  readonly pluginCount: number;
  readonly quarantinedPluginCount: number;
  readonly pluginDirectories: string[];
  readonly managedHookCount: number;
  readonly managedHookChainCount: number;
  readonly mcpServerCount: number;
  readonly quarantinedMcpCount: number;
  readonly elevatedMcpCount: number;
  readonly remoteRunnerCount: number;
  readonly issues: Array<{ severity: 'pass' | 'warn' | 'fail'; area: string; message: string }>;
  readonly services: string[];
}

interface SetupTransferBundle {
  readonly schemaVersion: 'v1';
  readonly exportedAt: number;
  readonly startupReview: SetupReviewSnapshot;
  readonly config: Record<string, unknown>;
  readonly services?: Record<string, unknown>;
  readonly ecosystem?: {
    readonly plugins?: Record<string, unknown>;
    readonly skills?: Record<string, unknown>;
  };
}

type RemoteConnectionLike = { agentId: string };
type RemoteCancelContext = Pick<CommandContext, 'print' | 'acpManager'>;
type RemoteCancelAgentManager = Pick<AgentManager, 'cancel'>;

export function handleRemoteCancelCommand(
  agentId: string | undefined,
  activeConnections: RemoteConnectionLike[],
  ctx: RemoteCancelContext,
  agentManager: RemoteCancelAgentManager = AgentManager.getInstance(),
): void {
  if (!agentId) {
    ctx.print('Usage: /remote cancel <agentId>');
    return;
  }
  const connection = activeConnections.find((entry) => entry.agentId === agentId);
  if (!connection) {
    ctx.print(`Unknown remote connection: ${agentId}`);
    return;
  }
  const localAgentCancelled = agentManager.cancel(agentId);
  if (localAgentCancelled) {
    ctx.print(`Cancelled remote agent ${agentId}.`);
    return;
  }
  if (!ctx.acpManager) {
    ctx.print(`Remote agent ${agentId} could not be cancelled in this runtime.`);
    return;
  }
  void ctx.acpManager.cancel(agentId);
  ctx.print(`Cancellation requested for remote runner ${agentId}.`);
}

function inspectSetupTransferBundle(bundle: SetupTransferBundle): string {
  const ecosystemPluginCount = bundle.ecosystem?.plugins && Array.isArray((bundle.ecosystem.plugins as { entries?: unknown[] }).entries)
    ? ((bundle.ecosystem.plugins as { entries: unknown[] }).entries.length)
    : 0;
  const ecosystemSkillCount = bundle.ecosystem?.skills && Array.isArray((bundle.ecosystem.skills as { entries?: unknown[] }).entries)
    ? ((bundle.ecosystem.skills as { entries: unknown[] }).entries.length)
    : 0;
  return [
    'Setup Transfer Review',
    `  schemaVersion: ${bundle.schemaVersion}`,
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  session: ${bundle.startupReview.sessionId}`,
    `  services: ${bundle.startupReview.serviceCount}`,
    `  plugins: ${bundle.startupReview.pluginCount}`,
    `  skills: ${bundle.startupReview.skillCount}`,
    `  remote runners: ${bundle.startupReview.remoteRunnerCount}`,
    `  config keys: ${Object.keys(bundle.config ?? {}).length}`,
    `  curated plugins: ${ecosystemPluginCount}`,
    `  curated skills: ${ecosystemSkillCount}`,
  ].join('\n');
}

function buildSetupTransferBundle(ctx: CommandContext, snapshot: SetupReviewSnapshot): SetupTransferBundle {
  const config: Record<string, unknown> = {};
  for (const entry of CONFIG_SCHEMA) {
    try {
      config[entry.key] = structuredClone(ctx.configManager.get(entry.key as ConfigKey));
    } catch {
      // Ignore unreadable config values in transfer bundles.
    }
  }
  const services = existsSync(join(process.cwd(), '.goodvibes', 'tui', 'services.json'))
    ? JSON.parse(readFileSync(join(process.cwd(), '.goodvibes', 'tui', 'services.json'), 'utf-8')) as Record<string, unknown>
    : undefined;
  const plugins = existsSync(join(process.cwd(), '.goodvibes', 'tui', 'ecosystem', 'plugins.json'))
    ? JSON.parse(readFileSync(join(process.cwd(), '.goodvibes', 'tui', 'ecosystem', 'plugins.json'), 'utf-8')) as Record<string, unknown>
    : undefined;
  const skills = existsSync(join(process.cwd(), '.goodvibes', 'tui', 'ecosystem', 'skills.json'))
    ? JSON.parse(readFileSync(join(process.cwd(), '.goodvibes', 'tui', 'ecosystem', 'skills.json'), 'utf-8')) as Record<string, unknown>
    : undefined;

  return {
    schemaVersion: 'v1',
    exportedAt: Date.now(),
    startupReview: snapshot,
    config,
    services,
    ecosystem: {
      plugins,
      skills,
    },
  };
}

function createSetupLink(surface: string, target?: string): string {
  const encodedTarget = target ? `?target=${encodeURIComponent(target)}` : '';
  return `goodvibes://open/${encodeURIComponent(surface)}${encodedTarget}`;
}

function parseSetupLink(value: string): { surface: string; target?: string } | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'goodvibes:') return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (parsed.hostname !== 'open' || segments.length !== 1) return null;
    return {
      surface: decodeURIComponent(segments[0]!),
      target: parsed.searchParams.get('target') ?? undefined,
    };
  } catch {
    return null;
  }
}

async function buildSetupReviewSnapshot(ctx: CommandContext): Promise<SetupReviewSnapshot> {
  const services = Object.keys(getServiceRegistry().getAll()).sort((a, b) => a.localeCompare(b));
  const serviceIssues: string[] = [];
  for (const name of services) {
    const inspection = await getServiceRegistry().inspect(name);
    if (!inspection?.hasPrimaryCredential) {
      serviceIssues.push(`${name}: missing primary credential`);
    }
  }

  const skills = discoverSkills();
  const plugins = pluginManager.list();
  const workbench = getHookWorkbench();
  workbench.loadManagedConfig();
  const runtimeState = ctx.runtimeStore?.getState();
  const mcpServers = [...(runtimeState?.mcp.servers.values() ?? [])];
  const pluginDirectories = getPluginDirectories();
  const providerCount = ctx.providerRegistry.listModels().length;
  const remoteRunnerCount = getRemoteRunnerRegistry().listContracts().length;
  const quarantinedPluginCount = plugins.filter((plugin) => plugin.quarantined).length;
  const quarantinedMcpCount = mcpServers.filter((server) => server.schemaFreshness === 'quarantined').length;
  const elevatedMcpCount = mcpServers.filter((server) => server.trustMode === 'allow-all').length;
  const managedHookCount = workbench.listManagedHooks().length;
  const managedHookChainCount = workbench.listManagedChains().length;

  const issues: SetupReviewSnapshot['issues'] = [
    {
      severity: providerCount > 0 ? 'pass' : 'fail',
      area: 'providers',
      message: providerCount > 0 ? `${providerCount} model(s) available` : 'no models available',
    },
    {
      severity: services.length === 0 ? 'warn' : serviceIssues.length === 0 ? 'pass' : 'warn',
      area: 'services',
      message: services.length === 0
        ? 'no services configured'
        : serviceIssues.length === 0
          ? `${services.length} service(s) configured with credentials`
          : `${serviceIssues.length} service configuration issue(s)`,
    },
    {
      severity: quarantinedPluginCount === 0 ? 'pass' : 'warn',
      area: 'plugins',
      message: quarantinedPluginCount === 0
        ? `${plugins.length} plugin(s) discovered`
        : `${quarantinedPluginCount} plugin(s) quarantined`,
    },
    {
      severity: quarantinedMcpCount === 0 && elevatedMcpCount === 0 ? 'pass' : 'warn',
      area: 'mcp',
      message: quarantinedMcpCount > 0 || elevatedMcpCount > 0
        ? `${quarantinedMcpCount} quarantined, ${elevatedMcpCount} elevated`
        : `${mcpServers.length} server(s) known`,
    },
    {
      severity: managedHookCount > 0 || managedHookChainCount > 0 ? 'pass' : 'warn',
      area: 'hooks',
      message: `${managedHookCount} managed hook(s), ${managedHookChainCount} chain(s)`,
    },
    {
      severity: remoteRunnerCount > 0 ? 'pass' : 'warn',
      area: 'remote',
      message: remoteRunnerCount > 0 ? `${remoteRunnerCount} remote runner contract(s)` : 'no remote runner contracts registered',
    },
  ];

  return {
    sessionId: ctx.runtime.sessionId,
    providerCount,
    serviceCount: services.length,
    serviceIssues,
    skillCount: skills.length,
    pluginCount: plugins.length,
    quarantinedPluginCount,
    pluginDirectories,
    managedHookCount,
    managedHookChainCount,
    mcpServerCount: mcpServers.length,
    quarantinedMcpCount,
    elevatedMcpCount,
    remoteRunnerCount,
    issues,
    services,
  };
}

export function registerLocalRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'incident',
    aliases: [],
    description: 'Open, export, and capture incident review bundles',
    usage: '[open | latest | show <id|latest> | export <id|latest> <path> | capture <id|latest>]',
    async handler(args, ctx) {
      const subcommand = (args[0] ?? 'open').toLowerCase();
      const registry = ctx.forensicsRegistry;
      if (subcommand === 'open') {
        if (ctx.openIncidentPanel) {
          ctx.openIncidentPanel();
          return;
        }
        ctx.print('Incident panel is not available in this runtime.');
        return;
      }
      if (!registry) {
        ctx.print('Forensics registry is not available in this runtime.');
        return;
      }
      const requestedId = args[1];
      const report = !requestedId || requestedId === 'latest'
        ? registry.latest()
        : registry.getById(requestedId);
      if (subcommand === 'latest' || subcommand === 'show') {
        if (!report) {
          ctx.print('No incident bundle is available.');
          return;
        }
        const bundle = registry.buildBundle(report.id);
        if (!bundle) {
          ctx.print(`Failed to build incident bundle for ${report.id}.`);
          return;
        }
        ctx.print([
          `Incident ${report.id}`,
          `  classification: ${report.classification}`,
          `  summary: ${report.summary}`,
          `  root cause: ${bundle.evidence.rootCause ?? 'n/a'}`,
          `  denied permissions: ${bundle.evidence.deniedPermissionCount}`,
          `  budget breaches: ${bundle.evidence.budgetBreachCount}`,
          `  replay mismatches: ${bundle.replay.mismatchCount}`,
        ].join('\n'));
        return;
      }
      if (subcommand === 'export') {
        const pathArg = args[2];
        if (!requestedId || !pathArg) {
          ctx.print('Usage: /incident export <id|latest> <path>');
          return;
        }
        if (!report) {
          ctx.print(`Incident not found: ${requestedId}`);
          return;
        }
        const bundleJson = registry.exportBundleAsJson(report.id);
        if (!bundleJson) {
          ctx.print(`Failed to export incident bundle for ${report.id}.`);
          return;
        }
        const targetPath = resolve(process.cwd(), pathArg);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, `${bundleJson}\n`, 'utf-8');
        ctx.print(`Exported incident bundle ${report.id} to ${targetPath}`);
        return;
      }
      if (subcommand === 'capture') {
        if (!ctx.memoryRegistry) {
          ctx.print('Memory registry is not available for incident capture.');
          return;
        }
        if (!report) {
          ctx.print(`Incident not found: ${requestedId ?? 'latest'}`);
          return;
        }
        const bundle = registry.buildBundle(report.id);
        if (!bundle) {
          ctx.print(`Failed to build incident bundle for ${report.id}.`);
          return;
        }
        const record = await ctx.memoryRegistry.add(buildIncidentMemoryAddOptions(bundle));
        ctx.print(`Captured incident ${report.id} into durable memory as ${record.id}`);
        return;
      }
      ctx.print('Usage: /incident [open | latest | show <id|latest> | export <id|latest> <path> | capture <id|latest>]');
    },
  });

  registry.register({
    name: 'incident-review',
    aliases: [],
    description: 'Alias for /incident open',
    usage: '',
    handler(_args, ctx) {
      if (ctx.openIncidentPanel) {
        ctx.openIncidentPanel();
        return;
      }
      ctx.print('Incident panel is not available in this runtime.');
    },
  });

  registry.register({
    name: 'cockpit',
    aliases: [],
    description: 'Open the unified operator cockpit',
    usage: '',
    handler(_args, ctx) {
      if (ctx.openCockpitPanel) {
        ctx.openCockpitPanel();
        return;
      }
      ctx.print('Cockpit panel is not available in this runtime.');
    },
  });

  registry.register({
    name: 'orchestration',
    aliases: ['orch'],
    description: 'Inspect orchestration graphs and cancel active graphs or subtrees',
    usage: '[show [graphId] | cancel graph <graphId> | cancel subtree <agentId>]',
    handler(args, ctx) {
      const store = ctx.runtimeStore;
      if (args.length === 0) {
        if (ctx.openOrchestrationPanel) {
          ctx.openOrchestrationPanel();
          return;
        }
        if (!store) {
          ctx.print('Orchestration panel is not available in this runtime.');
          return;
        }
      }

      if (!store) {
        ctx.print('Runtime store is not available for orchestration commands.');
        return;
      }

      const graphs = [...store.getState().orchestration.graphs.values()].sort((a, b) => b.createdAt - a.createdAt);
      const subcommand = args[0]?.toLowerCase() ?? 'show';

      if (subcommand === 'show') {
        const graphId = args[1];
        const graph = graphId ? graphs.find((entry) => entry.id === graphId) : graphs[0];
        if (!graph) {
          ctx.print(graphId ? `Unknown orchestration graph: ${graphId}` : 'No orchestration graphs recorded yet.');
          return;
        }
        const lines = [
          `Graph ${graph.id}`,
          `  title: ${graph.title}`,
          `  status: ${graph.status}`,
          `  mode: ${graph.mode}`,
          `  nodes: ${graph.nodeOrder.length}`,
        ];
        if (graph.lastRecursionGuard) {
          lines.push(`  last guard: depth ${graph.lastRecursionGuard.depth}, active ${graph.lastRecursionGuard.activeAgents}, ${graph.lastRecursionGuard.reason}`);
        }
        for (const nodeId of graph.nodeOrder.slice(0, 12)) {
          const node = graph.nodes.get(nodeId);
          if (!node) continue;
          lines.push(`  - ${node.id} ${node.role} ${node.status} ${node.title}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (subcommand === 'cancel') {
        const mode = args[1]?.toLowerCase();
        const target = args[2];
        const manager = AgentManager.getInstance();
        if (!mode || !target) {
          ctx.print('Usage: /orchestration cancel graph <graphId> | /orchestration cancel subtree <agentId>');
          return;
        }
        if (mode === 'graph') {
          const cancelled = manager.cancelGraph(target);
          ctx.print(cancelled.length > 0
            ? `Cancelled ${cancelled.length} agent${cancelled.length !== 1 ? 's' : ''} in graph ${target}.`
            : `No cancellable agents found in graph ${target}.`);
          return;
        }
        if (mode === 'subtree') {
          const cancelled = manager.cancelSubtree(target);
          ctx.print(cancelled.length > 0
            ? `Cancelled ${cancelled.length} agent${cancelled.length !== 1 ? 's' : ''} in subtree rooted at ${target}.`
            : `No cancellable agents found in subtree rooted at ${target}.`);
          return;
        }
        ctx.print(`Unknown orchestration cancel target: ${mode}`);
        return;
      }

      ctx.print(`Unknown orchestration subcommand: ${subcommand}`);
    },
  });

  registry.register({
    name: 'hooks',
    aliases: [],
    description: 'Inspect, author, simulate, and reload managed hook workflows',
    usage: '[contracts [filter] | reload | scaffold <name> <match> <type> | chain <name> <event1,event2,...> | remove <name> | enable <name> | disable <name> | simulate <eventPath> | export [path]]',
    argsHint: '[subcommand]',
    async handler(args, ctx) {
      const workbench = getHookWorkbench();
      if (args.length === 0 && ctx.openHooksPanel) {
        ctx.openHooksPanel();
        return;
      }

      const subcommand = (args[0] ?? 'contracts').toLowerCase();
      if (subcommand === 'reload') {
        await workbench.loadAndApplyManagedHooks();
        ctx.print(`Reloaded managed hooks from ${workbench.getHooksFilePath()}`);
        return;
      }
      if (subcommand === 'scaffold') {
        const [name, match, type] = args.slice(1);
        if (!name || !match || !type) {
          ctx.print('Usage: /hooks scaffold <name> <match> <command|prompt|agent|http|ts>');
          return;
        }
        if (!['command', 'prompt', 'agent', 'http', 'ts'].includes(type)) {
          ctx.print(`Unknown hook type: ${type}`);
          return;
        }
        workbench.loadManagedConfig();
        const hook = workbench.scaffoldHook(name, match, type as Parameters<typeof workbench.scaffoldHook>[2]);
        await workbench.saveManagedConfig();
        await workbench.loadAndApplyManagedHooks();
        ctx.print(`Scaffolded managed hook ${hook.name} at ${match} in ${workbench.getHooksFilePath()}`);
        return;
      }
      if (subcommand === 'chain') {
        const name = args[1];
        const matches = args[2]?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
        if (!name || matches.length === 0) {
          ctx.print('Usage: /hooks chain <name> <event1,event2,...>');
          return;
        }
        workbench.loadManagedConfig();
        const chain = workbench.scaffoldChain(name, matches);
        await workbench.saveManagedConfig();
        await workbench.loadAndApplyManagedHooks();
        ctx.print(`Scaffolded managed hook chain ${chain.name} with ${chain.steps.length} step(s).`);
        return;
      }
      if (subcommand === 'remove') {
        const name = args[1];
        if (!name) {
          ctx.print('Usage: /hooks remove <name>');
          return;
        }
        workbench.loadManagedConfig();
        const removed = workbench.removeManagedEntry(name);
        if (!removed) {
          ctx.print(`No managed hook or chain named ${name}.`);
          return;
        }
        await workbench.saveManagedConfig();
        await workbench.loadAndApplyManagedHooks();
        ctx.print(`Removed managed hook workflow entry ${name}.`);
        return;
      }
      if (subcommand === 'enable' || subcommand === 'disable') {
        const name = args[1];
        if (!name) {
          ctx.print(`Usage: /hooks ${subcommand} <name>`);
          return;
        }
        workbench.loadManagedConfig();
        const changed = workbench.toggleManagedHook(name, subcommand === 'enable');
        if (!changed) {
          ctx.print(`No managed hook named ${name}.`);
          return;
        }
        await workbench.saveManagedConfig();
        await workbench.loadAndApplyManagedHooks();
        ctx.print(`${subcommand === 'enable' ? 'Enabled' : 'Disabled'} managed hook ${name}.`);
        return;
      }
      if (subcommand === 'simulate') {
        const eventPath = args[1];
        if (!eventPath) {
          ctx.print('Usage: /hooks simulate <eventPath>');
          return;
        }
        workbench.loadManagedConfig();
        const result = workbench.simulate(eventPath);
        ctx.print([
          `Hook simulation for ${result.eventPath}`,
          `  matched hooks: ${result.matchedHooks.length}`,
          ...result.matchedHooks.map((entry) => `    ${entry.name}  ${entry.pattern}  ${entry.type}`),
          `  matched chains: ${result.matchedChains.length}`,
          ...result.matchedChains.map((entry) => `    ${entry.name}  stepMatches=${entry.stepMatches}`),
        ].join('\n'));
        return;
      }
      if (subcommand === 'export') {
        workbench.loadManagedConfig();
        const path = await workbench.exportManagedConfig(args[1] ?? workbench.getHooksFilePath());
        ctx.print(`Exported managed hooks to ${path}`);
        return;
      }

      const filter = (subcommand === 'contracts' ? args.slice(1) : args).join(' ').trim().toLowerCase();
      const contracts = listHookPointContracts().filter((contract) => (
        filter.length === 0
        || contract.pattern.toLowerCase().includes(filter)
        || contract.description.toLowerCase().includes(filter)
      ));

      if (contracts.length === 0) {
        ctx.print(filter.length === 0 ? 'No hook contracts registered.' : `No hook contracts matched "${filter}".`);
        return;
      }

      const lines: string[] = [`Hook Contracts (${contracts.length}):`];
      for (const contract of contracts) {
        lines.push(`  ${contract.pattern}`);
        lines.push(`    authority=${contract.authority} mode=${contract.executionMode} deny=${contract.canDeny ? 'yes' : 'no'} mutate=${contract.canMutateInput ? 'yes' : 'no'} inject=${contract.canInjectContext ? 'yes' : 'no'} timeout=${contract.timeoutMs}ms policy=${contract.failurePolicy}`);
        lines.push(`    ${contract.description}`);
      }
      const managedHooks = workbench.listManagedHooks();
      const managedChains = workbench.listManagedChains();
      lines.push('');
      lines.push(`Managed hooks file: ${workbench.getHooksFilePath()}`);
      lines.push(`Managed entries: hooks=${managedHooks.length} chains=${managedChains.length}`);
      ctx.print(lines.join('\n'));
    },
  });

  registry.register({
    name: 'communication',
    aliases: ['comms'],
    description: 'Inspect structured agent communication routes and recent activity',
    usage: '',
    handler(_args, ctx) {
      if (ctx.openCommunicationPanel) {
        ctx.openCommunicationPanel();
        return;
      }
      ctx.print('Communication panel is not available in this runtime.');
    },
  });

  registry.register({
    name: 'security',
    aliases: [],
    description: 'Inspect security posture, attack paths, and review state',
    usage: '[review | attack-paths | tokens]',
    handler(args, ctx) {
      if (args.length === 0) {
        if (ctx.openSecurityPanel) {
          ctx.openSecurityPanel();
          return;
        }
        ctx.print('Security panel is not available in this runtime.');
        return;
      }

      const subcommand = args[0]?.toLowerCase() ?? 'review';
      const audit = getTokenAuditor().auditAll(Date.now());
      const store = ctx.runtimeStore;
      const policySnapshot = getPolicyRuntimeState().getSnapshot();
      const mcpServers = [...(store?.getState().mcp.servers.values() ?? [])];
      const attackPaths = buildMcpAttackPathReview({
        servers: mcpServers.map((server) => ({
          name: server.name,
          role: server.role,
          trustMode: server.trustMode,
          allowedPaths: server.allowedPaths,
          allowedHosts: server.allowedHosts,
          schemaFreshness: server.schemaFreshness,
          quarantineReason: server.quarantineReason,
          quarantineDetail: server.quarantineDetail,
          connected: server.status === 'connected' || server.status === 'degraded',
        })),
        recentDecisions: ctx.mcpRegistry.listRecentSecurityDecisions(12),
      });

      if (subcommand === 'tokens') {
        if (audit.results.length === 0) {
          ctx.print('No registered API tokens are currently under audit.');
          return;
        }
        ctx.print([
          `Token Audit (${audit.results.length})`,
          ...audit.results.map((result) => (
            `  ${result.label}  policy=${result.scope.policyId}  scope=${result.scope.outcome}  rotation=${result.rotation.outcome}  blocked=${result.blocked ? 'yes' : 'no'}`
          )),
        ].join('\n'));
        return;
      }

      if (subcommand === 'attack-paths') {
        if (attackPaths.findings.length === 0) {
          ctx.print('No MCP attack-path findings are currently active.');
          return;
        }
        ctx.print([
          `MCP Attack-Path Review`,
          `  summary: ${attackPaths.summary}`,
          ...attackPaths.findings.slice(0, 12).map((finding) => (
            `  ${finding.severity.toUpperCase()} ${finding.serverName}  ${finding.route}\n    ${finding.reason}`
          )),
        ].join('\n'));
        return;
      }

      const plugins = pluginManager.list();
      ctx.print([
        'Security Review',
        `  tokens: ${audit.results.length}`,
        `  blocked tokens: ${audit.blocked.length}`,
        `  scope violations: ${audit.scopeViolations.length}`,
        `  rotation overdue: ${audit.rotationOverdue.length}`,
        `  rotation warnings: ${audit.rotationWarnings.length}`,
        `  policy lint findings: ${policySnapshot.lintFindings.length}`,
        `  policy preflight: ${policySnapshot.lastPreflightReview?.status ?? 'n/a'}`,
        `  mcp servers: ${mcpServers.length}`,
        `  mcp quarantined: ${mcpServers.filter((server) => server.schemaFreshness === 'quarantined').length}`,
        `  mcp elevated: ${mcpServers.filter((server) => server.trustMode === 'allow-all').length}`,
        `  mcp attack-path findings: ${attackPaths.findings.length}`,
        `  quarantined plugins: ${plugins.filter((plugin) => plugin.quarantined).length}`,
        `  untrusted plugins: ${plugins.filter((plugin) => plugin.trustTier === 'untrusted').length}`,
      ].join('\n'));
    },
  });

  registry.register({
    name: 'knowledge',
    aliases: ['know'],
    description: 'Inspect durable project knowledge, risks, runbooks, and architecture notes',
    usage: '[open | queue [limit] | explain <task...> [--scope <path> ...]]',
    handler(args, ctx) {
      const subcommand = (args[0] ?? 'open').toLowerCase();
      if (subcommand === 'open') {
        if (ctx.openKnowledgePanel) {
          ctx.openKnowledgePanel();
          return;
        }
        ctx.print('Knowledge panel is not available in this runtime.');
        return;
      }
      if (!ctx.memoryRegistry) {
        ctx.print('Knowledge controls are not available in this runtime.');
        return;
      }
      if (subcommand === 'queue') {
        const limit = Math.max(1, parseInt(args[1] ?? '10', 10) || 10);
        const queue = ctx.memoryRegistry.reviewQueue(limit);
        if (queue.length === 0) {
          ctx.print('Knowledge review queue is empty.');
          return;
        }
        ctx.print([
          `Knowledge Review Queue (${queue.length})`,
          ...queue.map((record) => `  ${record.id}  [${record.scope}/${record.cls}] ${record.reviewState} ${record.confidence}%  ${record.summary}`),
        ].join('\n'));
        return;
      }
      if (subcommand === 'explain') {
        const scopeIdx = args.indexOf('--scope');
        const scopeValues = scopeIdx !== -1
          ? args.slice(scopeIdx + 1).filter((token) => !token.startsWith('--'))
          : [];
        const taskTokens = args.slice(1).filter((token, index) => {
          if (token === '--scope') return false;
          if (scopeIdx !== -1 && index + 1 > scopeIdx) return false;
          return true;
        });
        const task = taskTokens.join(' ').trim();
        if (!task) {
          ctx.print('Usage: /knowledge explain <task...> [--scope <path> ...]');
          return;
        }
        const injections = selectKnowledgeForTask(task, scopeValues);
        const prompt = buildKnowledgeInjectionPrompt(injections);
        ctx.print(prompt ?? 'No reviewed project knowledge matched that task.');
        return;
      }
      if (ctx.openKnowledgePanel) {
        ctx.openKnowledgePanel();
        return;
      }
      ctx.print('Knowledge panel is not available in this runtime.');
    },
  });

  registry.register({
    name: 'remote',
    aliases: [],
    description: 'Inspect, dispatch, and review self-hosted remote runners and artifacts',
    usage: '[list | show [agentId] | setup | env [export <path>] | pool <list|show|create|assign|unassign> ... | dispatch [template] <description> | dispatch-pool <pool> [template] <description> | contract [agentId] | cancel <agentId> | export <agentId> [path] | artifact list | artifact show <id> | artifact export <id> [path] | review <id> | rerun-local <id> | import <path>]',
    async handler(args, ctx) {
      if (args.length === 0) {
        if (ctx.openRemotePanel) {
          ctx.openRemotePanel();
          return;
        }
        ctx.print('Remote panel is not available in this runtime.');
        return;
      }

      const store = ctx.runtimeStore;
      if (!store) {
        ctx.print('Runtime store is not available for remote commands.');
        return;
      }

      const activeConnections = store.getState().acp.activeConnectionIds
        .map((id) => store.getState().acp.connections.get(id))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
      const remoteRegistry = getRemoteRunnerRegistry();
      remoteRegistry.ensureContractsFromStore(store);
      const subcommand = args[0]?.toLowerCase() ?? 'show';

      if (subcommand === 'setup') {
        const command = getDefaultAcpAgentCommand();
        const danger = ctx.configManager.getCategory('danger');
        ctx.print([
          'Remote Setup Review',
          `  acp agent command: ${command.join(' ')}`,
          `  daemon enabled: ${danger.daemon ? 'yes' : 'no'}`,
          `  http listener enabled: ${danger.httpListener ? 'yes' : 'no'}`,
          `  remote runner contracts: ${remoteRegistry.listContracts().length}`,
          `  active acp connections: ${activeConnections.length}`,
          '',
          '  guidance:',
          '    - set ACP_AGENT_CMD to override the spawned remote agent command',
          `    - use /remote env to export a reusable shell snippet`,
          `    - enable danger.daemon / danger.httpListener only when you actually need those remote surfaces`,
        ].join('\n'));
        return;
      }

      if (subcommand === 'env') {
        const command = getDefaultAcpAgentCommand();
        const shellSnippet = [
          `export ACP_AGENT_CMD='${command.join(' ')}'`,
          `export GOODVIBES_REMOTE_SESSION='${ctx.runtime.sessionId}'`,
        ].join('\n');
        if (args[1]?.toLowerCase() === 'export') {
          const pathArg = args[2];
          if (!pathArg) {
            ctx.print('Usage: /remote env export <path>');
            return;
          }
          const targetPath = resolve(process.cwd(), pathArg);
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, `${shellSnippet}\n`, 'utf-8');
          ctx.print(`Exported remote environment snippet to ${targetPath}`);
          return;
        }
        ctx.print(['Remote Environment', shellSnippet].join('\n'));
        return;
      }

      if (subcommand === 'list') {
        const contracts = remoteRegistry.listContracts();
        const pools = remoteRegistry.listPools();
        const artifacts = remoteRegistry.listArtifacts();
        const lines = [
          `Remote Control Surface`,
          `  active connections: ${activeConnections.length}`,
          `  runner contracts: ${contracts.length}`,
          `  runner pools: ${pools.length}`,
          `  review artifacts: ${artifacts.length}`,
        ];
        if (activeConnections.length > 0) {
          lines.push('  connections:');
          for (const connection of activeConnections.slice(0, 12)) {
            lines.push(`    ${connection.agentId}  ${connection.transportState}  msgs=${connection.messageCount} errs=${connection.errorCount}  ${connection.label}`);
          }
        }
        if (contracts.length > 0) {
          lines.push('  contracts:');
          for (const contract of contracts.slice(0, 12)) {
            lines.push(`    ${contract.runnerId}  ${contract.template}  ${contract.transport.state}  ${contract.capabilityCeiling.executionProtocol}/${contract.capabilityCeiling.reviewMode}`);
          }
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (subcommand === 'pool') {
        const mode = args[1]?.toLowerCase() ?? 'list';
        if (mode === 'list') {
          const pools = remoteRegistry.listPools();
          if (pools.length === 0) {
            ctx.print('No remote runner pools defined yet.');
            return;
          }
          ctx.print([
            `Remote Runner Pools (${pools.length})`,
            ...pools.map((pool) => `  ${pool.id}  ${pool.runnerIds.length} runners  trust=${pool.trustClass}  template=${pool.preferredTemplate ?? '(none)'}`),
          ].join('\n'));
          return;
        }
        if (mode === 'show') {
          const poolId = args[2];
          if (!poolId) {
            ctx.print('Usage: /remote pool show <poolId>');
            return;
          }
          const pool = remoteRegistry.getPool(poolId);
          if (!pool) {
            ctx.print(`Unknown remote runner pool: ${poolId}`);
            return;
          }
          ctx.print([
            `Remote Runner Pool ${pool.id}`,
            `  label: ${pool.label}`,
            `  trustClass: ${pool.trustClass}`,
            `  preferredTemplate: ${pool.preferredTemplate ?? '(none)'}`,
            `  maxRunners: ${pool.maxRunners ?? '(unbounded)'}`,
            `  runners: ${pool.runnerIds.join(', ') || '(none)'}`,
            `  description: ${pool.description ?? '(none)'}`,
          ].join('\n'));
          return;
        }
        if (mode === 'create') {
          const poolId = args[2];
          if (!poolId) {
            ctx.print('Usage: /remote pool create <poolId> [label]');
            return;
          }
          const label = args.slice(3).join(' ').trim() || poolId;
          const pool = remoteRegistry.createPool({ id: poolId, label });
          ctx.print(`Created remote runner pool ${pool.id} (${pool.label}).`);
          return;
        }
        if (mode === 'assign') {
          const poolId = args[2];
          const runnerId = args[3];
          if (!poolId || !runnerId) {
            ctx.print('Usage: /remote pool assign <poolId> <runnerId>');
            return;
          }
          const pool = remoteRegistry.assignRunnerToPool(poolId, runnerId);
          if (!pool) {
            ctx.print(`Could not assign ${runnerId} to pool ${poolId}.`);
            return;
          }
          ctx.print(`Assigned remote runner ${runnerId} to pool ${poolId}.`);
          return;
        }
        if (mode === 'unassign') {
          const poolId = args[2];
          const runnerId = args[3];
          if (!poolId || !runnerId) {
            ctx.print('Usage: /remote pool unassign <poolId> <runnerId>');
            return;
          }
          const pool = remoteRegistry.removeRunnerFromPool(poolId, runnerId);
          if (!pool) {
            ctx.print(`Unknown remote runner pool: ${poolId}`);
            return;
          }
          ctx.print(`Removed remote runner ${runnerId} from pool ${poolId}.`);
          return;
        }
        ctx.print('Usage: /remote pool <list|show|create|assign|unassign> ...');
        return;
      }

      if (subcommand === 'show') {
        const agentId = args[1];
        const connection = agentId
          ? activeConnections.find((entry) => entry.agentId === agentId)
          : activeConnections[0];
        if (!connection) {
          ctx.print(agentId ? `Unknown remote connection: ${agentId}` : 'No active remote connections.');
          return;
        }
        const contract = remoteRegistry.upsertContractForAgent(connection.agentId, store);
        ctx.print([
          `Remote connection ${connection.agentId}`,
          `  label: ${connection.label}`,
          `  transport: ${connection.transportState}`,
          `  completing: ${connection.completing ? 'yes' : 'no'}`,
          `  connectedAt: ${connection.connectedAt ? new Date(connection.connectedAt).toISOString() : 'n/a'}`,
          `  messageCount: ${connection.messageCount}`,
          `  errorCount: ${connection.errorCount}`,
          `  taskId: ${connection.taskId ?? 'n/a'}`,
          `  lastError: ${connection.lastError ?? 'n/a'}`,
          `  contract: ${contract?.id ?? 'n/a'}`,
          `  pool: ${contract?.poolId ?? 'n/a'}`,
          `  executionProtocol: ${contract?.capabilityCeiling.executionProtocol ?? 'n/a'}`,
          `  reviewMode: ${contract?.capabilityCeiling.reviewMode ?? 'n/a'}`,
          `  communicationLane: ${contract?.capabilityCeiling.communicationLane ?? 'n/a'}`,
        ].join('\n'));
        return;
      }

      if (subcommand === 'dispatch') {
        if (!ctx.acpManager) {
          ctx.print('ACP manager is not available for remote dispatch in this runtime.');
          return;
        }
        let template = 'general';
        let descriptionArgs = args.slice(1);
        if (descriptionArgs.length > 0 && descriptionArgs[0] in AGENT_TEMPLATES) {
          template = descriptionArgs[0]!;
          descriptionArgs = descriptionArgs.slice(1);
        }
        const description = descriptionArgs.join(' ').trim();
        if (description.length === 0) {
          ctx.print('Usage: /remote dispatch [template] <description>');
          return;
        }
        const templateDef = AGENT_TEMPLATES[template] ?? AGENT_TEMPLATES.general;
        const runnerId = await ctx.acpManager.spawn({
          description,
          context: `Self-hosted remote runner dispatched from session ${ctx.runtime.sessionId}. Follow ${template} discipline and return concise evidence.`,
          tools: [...templateDef.defaultTools],
        });
        const now = Date.now();
        remoteRegistry.registerContract({
          id: `runner:${runnerId}`,
          runnerId,
          label: `${template} remote runner`,
          sourceTransport: 'acp',
          trustClass: 'self-hosted-acp',
          template,
          capabilityCeiling: Object.freeze({
            allowedTools: [...templateDef.defaultTools],
            capabilityCeilingTools: [...templateDef.defaultTools],
            executionProtocol: 'gather-plan-apply',
            reviewMode: 'none',
            communicationLane: 'direct',
            orchestrationDepth: 0,
            successCriteria: [],
            requiredEvidence: [],
            writeScope: [],
          }),
          createdAt: now,
          lastUpdatedAt: now,
          transport: Object.freeze({
            state: 'initializing',
            messageCount: 0,
            errorCount: 0,
          }),
        });
        ctx.print([
          `Dispatched remote runner ${runnerId}`,
          `  template: ${template}`,
          `  tools: ${templateDef.defaultTools.join(', ')}`,
          `  description: ${description}`,
        ].join('\n'));
        return;
      }

      if (subcommand === 'dispatch-pool') {
        if (!ctx.acpManager) {
          ctx.print('ACP manager is not available for remote dispatch in this runtime.');
          return;
        }
        const poolId = args[1];
        if (!poolId) {
          ctx.print('Usage: /remote dispatch-pool <pool> [template] <description>');
          return;
        }
        const pool = remoteRegistry.getPool(poolId);
        if (!pool) {
          ctx.print(`Unknown remote runner pool: ${poolId}`);
          return;
        }
        let template = pool.preferredTemplate ?? 'general';
        let descriptionArgs = args.slice(2);
        if (descriptionArgs.length > 0 && descriptionArgs[0] in AGENT_TEMPLATES) {
          template = descriptionArgs[0]!;
          descriptionArgs = descriptionArgs.slice(1);
        }
        const description = descriptionArgs.join(' ').trim();
        if (description.length === 0) {
          ctx.print('Usage: /remote dispatch-pool <pool> [template] <description>');
          return;
        }
        const templateDef = AGENT_TEMPLATES[template] ?? AGENT_TEMPLATES.general;
        const runnerId = await ctx.acpManager.spawn({
          description,
          context: `Self-hosted remote runner dispatched from session ${ctx.runtime.sessionId} via pool ${poolId}. Follow ${template} discipline and return concise evidence.`,
          tools: [...templateDef.defaultTools],
        });
        const now = Date.now();
        remoteRegistry.registerContract({
          id: `runner:${runnerId}`,
          runnerId,
          poolId,
          label: `${template} remote runner`,
          sourceTransport: 'acp',
          trustClass: pool.trustClass === 'mixed' ? 'self-hosted-acp' : pool.trustClass,
          template,
          capabilityCeiling: Object.freeze({
            allowedTools: [...templateDef.defaultTools],
            capabilityCeilingTools: [...templateDef.defaultTools],
            executionProtocol: 'gather-plan-apply',
            reviewMode: 'none',
            communicationLane: 'direct',
            orchestrationDepth: 0,
            successCriteria: [],
            requiredEvidence: [],
            writeScope: [],
          }),
          createdAt: now,
          lastUpdatedAt: now,
          transport: Object.freeze({
            state: 'initializing',
            messageCount: 0,
            errorCount: 0,
          }),
        });
        remoteRegistry.assignRunnerToPool(poolId, runnerId);
        ctx.print([
          `Dispatched remote runner ${runnerId} via pool ${poolId}`,
          `  template: ${template}`,
          `  tools: ${templateDef.defaultTools.join(', ')}`,
          `  description: ${description}`,
        ].join('\n'));
        return;
      }

      if (subcommand === 'contract') {
        const agentId = args[1] ?? activeConnections[0]?.agentId;
        if (!agentId) {
          ctx.print('No remote runner contracts are available yet.');
          return;
        }
        const contract = remoteRegistry.upsertContractForAgent(agentId, store);
        if (!contract) {
          ctx.print(`Unknown remote runner: ${agentId}`);
          return;
        }
        ctx.print([
          `Remote runner contract ${contract.id}`,
          `  runnerId: ${contract.runnerId}`,
          `  label: ${contract.label}`,
          `  pool: ${contract.poolId ?? '(none)'}`,
          `  trustClass: ${contract.trustClass}`,
          `  template: ${contract.template}`,
          `  transport: ${contract.transport.state}`,
          `  tools: ${contract.capabilityCeiling.allowedTools.join(', ') || '(none)'}`,
          `  ceiling: ${contract.capabilityCeiling.capabilityCeilingTools.join(', ') || '(none)'}`,
          `  protocol: ${contract.capabilityCeiling.executionProtocol}`,
          `  reviewMode: ${contract.capabilityCeiling.reviewMode}`,
          `  communicationLane: ${contract.capabilityCeiling.communicationLane}`,
          `  writeScope: ${contract.capabilityCeiling.writeScope.join(', ') || '(none)'}`,
        ].join('\n'));
        return;
      }

      if (subcommand === 'cancel') {
        handleRemoteCancelCommand(args[1], activeConnections, ctx);
        return;
      }

      if (subcommand === 'export') {
        const agentId = args[1];
        if (!agentId) {
          ctx.print('Usage: /remote export <agentId> [path]');
          return;
        }
        const exported = await exportRemoteArtifactForAgent(agentId, store, args[2])
          ?? await (async () => {
            const artifact = remoteRegistry.captureArtifactForRunner(agentId, store);
            if (!artifact) return null;
            return remoteRegistry.exportArtifact(artifact.id, args[2]);
          })();
        if (!exported) {
          ctx.print(`Remote artifact export failed for ${agentId}.`);
          return;
        }
        ctx.print(`Exported remote review artifact ${exported.artifact.id} to ${exported.path}`);
        return;
      }

      if (subcommand === 'artifact') {
        const mode = args[1]?.toLowerCase() ?? 'list';
        if (mode === 'list') {
          const artifacts = remoteRegistry.listArtifacts();
          if (artifacts.length === 0) {
            ctx.print('No remote review artifacts captured yet.');
            return;
          }
          ctx.print([
            `Remote Review Artifacts (${artifacts.length})`,
            ...artifacts.slice(0, 12).map((artifact) => (
              `  ${artifact.id}  ${artifact.runnerId}  ${artifact.task.status}  ${artifact.task.summary}`
            )),
          ].join('\n'));
          return;
        }
        if (mode === 'show') {
          const artifactId = args[2];
          if (!artifactId) {
            ctx.print('Usage: /remote artifact show <artifactId>');
            return;
          }
          const summary = remoteRegistry.buildReviewSummary(artifactId);
          ctx.print(summary ?? `Unknown remote artifact: ${artifactId}`);
          return;
        }
        if (mode === 'export') {
          const artifactId = args[2];
          if (!artifactId) {
            ctx.print('Usage: /remote artifact export <artifactId> [path]');
            return;
          }
          const exported = await remoteRegistry.exportArtifact(artifactId, args[3]);
          if (!exported) {
            ctx.print(`Unknown remote artifact: ${artifactId}`);
            return;
          }
          ctx.print(`Exported remote review artifact ${exported.artifact.id} to ${exported.path}`);
          return;
        }
        ctx.print(`Unknown remote artifact subcommand: ${mode}`);
        return;
      }

      if (subcommand === 'review') {
        const artifactId = args[1];
        if (!artifactId) {
          ctx.print('Usage: /remote review <artifactId>');
          return;
        }
        const summary = remoteRegistry.buildReviewSummary(artifactId);
        ctx.print(summary ?? `Unknown remote artifact: ${artifactId}`);
        return;
      }

      if (subcommand === 'rerun-local') {
        const artifactId = args[1];
        if (!artifactId) {
          ctx.print('Usage: /remote rerun-local <artifactId>');
          return;
        }
        const artifact = remoteRegistry.getArtifact(artifactId);
        if (!artifact) {
          ctx.print(`Unknown remote artifact: ${artifactId}`);
          return;
        }
        const template = artifact.runnerContract.template in AGENT_TEMPLATES
          ? artifact.runnerContract.template
          : 'general';
        const agent = AgentManager.getInstance().spawn({
          mode: 'spawn',
          task: artifact.task.task,
          template,
          tools: [...artifact.runnerContract.capabilityCeiling.allowedTools],
          successCriteria: [...artifact.runnerContract.capabilityCeiling.successCriteria],
          requiredEvidence: [...artifact.runnerContract.capabilityCeiling.requiredEvidence],
          writeScope: [...artifact.runnerContract.capabilityCeiling.writeScope],
          executionProtocol: artifact.runnerContract.capabilityCeiling.executionProtocol,
          reviewMode: artifact.runnerContract.capabilityCeiling.reviewMode,
          communicationLane: artifact.runnerContract.capabilityCeiling.communicationLane,
        });
        ctx.print(`Spawned local rerun agent ${agent.id} from remote artifact ${artifactId}.`);
        return;
      }

      if (subcommand === 'import') {
        const path = args[1];
        if (!path) {
          ctx.print('Usage: /remote import <path>');
          return;
        }
        const artifact = await importRemoteArtifact(path);
        ctx.print(`Imported remote review artifact ${artifact.id} for runner ${artifact.runnerId}.`);
        return;
      }

      ctx.print(`Unknown remote subcommand: ${subcommand}`);
    },
  });

  registry.register({
    name: 'tools',
    aliases: ['t'],
    description: 'List available tools',
    handler(_args, ctx) {
      const tools = ctx.toolRegistry.list();
      if (ctx.openSelection) {
        const items: SelectionItem[] = tools.map(t => ({
          id: t.definition.name,
          label: t.definition.name,
          detail: typeof t.definition.description === 'string' ? t.definition.description.slice(0, 50) : '',
        }));
        ctx.openSelection('Available Tools', items, { allowSearch: true }, (result) => {
          if (!result) return;
          const tool = tools.find(t2 => t2.definition.name === result.item.id);
          if (tool) ctx.print(`Tool: ${tool.definition.name}\n  ${tool.definition.description ?? ''}`);
        });
        return;
      }
      ctx.print(['Available tools:', ...tools.map(t => `  • ${t.definition.name}`)].join('\n'));
    },
  });

  registry.register({
    name: 'provider',
    aliases: ['p'],
    description: 'Switch provider or manage custom providers (add/remove)',
    usage: '[add <name> <baseURL> [apiKey] | remove <name> | <provider-name>]',
    argsHint: '[add|remove|name]',
    async handler(args, ctx) {
      const isValidProviderName = (name: string): boolean => /^[a-zA-Z0-9_-]+$/.test(name);
      if (args[0] === 'add') {
        const addArgs = args.slice(1);
        if (addArgs.length < 2) {
          ctx.print('Usage: /provider add <name> <baseURL> [apiKey]\nExample: /provider add my-server http://192.168.0.85:8001/v1');
          return;
        }
        const [name, baseURL, apiKey] = addArgs;
        if (!isValidProviderName(name)) {
          ctx.print('Error: Provider name must contain only letters, numbers, hyphens, and underscores.');
          return;
        }
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(baseURL);
        } catch {
          ctx.print(`Error: '${baseURL}' is not a valid URL. Example: http://192.168.0.85:8001/v1`);
          return;
        }
        const providersDir = join(homedir(), '.goodvibes', 'tui', 'providers');
        const providerFile = join(providersDir, `${name}.json`);
        if (existsSync(providerFile)) {
          ctx.print(`Error: Provider '${name}' already exists at ${providerFile}\nRemove it first with: /provider remove ${name}`);
          return;
        }

        ctx.print(`Probing ${baseURL}/models ...`);
        let discoveredModelIds: string[] = [];
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
          const res = await fetch(`${baseURL}/models`, { signal: controller.signal, headers });
          clearTimeout(timeoutId);
          if (res.ok) {
            const body = await res.json() as unknown;
            if (body && typeof body === 'object' && 'data' in body && Array.isArray((body as Record<string, unknown>).data)) {
              discoveredModelIds = ((body as { data: unknown[] }).data)
                .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null && 'id' in m)
                .map(m => String(m.id))
                .filter(Boolean);
            }
          }
        } catch {
          ctx.print(`Could not reach ${baseURL}/models — creating provider with a minimal starter config.`);
        }

        let contextWindows: Record<string, number> = {};
        if (discoveredModelIds.length > 0) {
          if (parsedUrl.protocol === 'http:') {
            try {
              contextWindows = await fetchModelContextWindows(parsedUrl.hostname, parseInt(parsedUrl.port) || 80, 'unknown', discoveredModelIds);
            } catch {}
          } else {
            ctx.print('Note: Context window detection is only supported for http:// URLs. Using defaults.');
          }
        }
        const defaultModel = `${name}-model`;
        const models: CustomProviderConfig['models'] = discoveredModelIds.length === 0
          ? [{
              id: defaultModel,
              displayName: defaultModel,
              contextWindow: 8192,
              capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
            }]
          : discoveredModelIds.map(id => ({
              id,
              displayName: id,
              contextWindow: contextWindows[id] ?? 8192,
              capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
            }));
        const config: CustomProviderConfig = {
          name,
          displayName: name,
          type: 'openai-compat',
          baseURL,
          ...(apiKey ? { apiKey } : {}),
          models,
        };
        try {
          mkdirSync(providersDir, { recursive: true });
          await writeFile(providerFile, JSON.stringify(config, null, 2), 'utf-8');
        } catch (e) {
          ctx.print(`Error writing provider file: ${(e as Error).message}`);
          return;
        }
        ctx.print(`Provider '${name}' added with ${models.length} model(s):\n${discoveredModelIds.length > 0 ? discoveredModelIds.map(id => `  • ${id} (${(contextWindows[id] ?? 8192).toLocaleString()} ctx)`).join('\n') : `  • ${defaultModel} (starter entry)`}\nThe file watcher will auto-register it shortly.`);
        return;
      }

      if (args[0] === 'remove' || args[0] === 'rm') {
        const name = args[1];
        if (!name) {
          ctx.print('Usage: /provider remove <name>');
          return;
        }
        if (!isValidProviderName(name)) {
          ctx.print('Error: Provider name must contain only letters, numbers, hyphens, and underscores.');
          return;
        }
        const providerFile = join(homedir(), '.goodvibes', 'tui', 'providers', `${name}.json`);
        if (!existsSync(providerFile)) {
          ctx.print(`Error: No custom provider '${name}' found at ${providerFile}`);
          return;
        }
        try {
          await unlink(providerFile);
          ctx.print(`Provider '${name}' removed. The file watcher will deregister it shortly.`);
        } catch (e) {
          ctx.print(`Error removing provider file: ${(e as Error).message}`);
        }
        return;
      }

      if (args.length === 0) {
        if (ctx.openProviderPicker) {
          ctx.openProviderPicker();
          return;
        }
        const providers = ['openai', 'anthropic', 'gemini', 'inceptionlabs'];
        ctx.print(['Available providers:', ...providers.map(p => `  ${p === ctx.runtime.provider ? '▶' : ' '} ${p}`)].join('\n'));
        return;
      }

      const providerName = args[0];
      const match = ctx.providerRegistry.getSelectableModels().find(m => m.provider === providerName);
      if (!match) {
        ctx.print(`Unknown provider: ${providerName}. Available: openai, anthropic, gemini, inceptionlabs`);
        return;
      }
      try {
        ctx.providerRegistry.setCurrentModel(match.id);
        ctx.runtime.model = match.id;
        ctx.runtime.provider = providerName;
        ctx.configManager.set('provider.provider', providerName);
        ctx.configManager.set('provider.model', match.id);
        ctx.print(`Switched to provider: ${providerName} (model: ${match.id})`);
      } catch (e) {
        ctx.print(`Error: ${(e as Error).message}`);
      }
    },
  });

  registry.register({
    name: 'permissions',
    aliases: ['perms'],
    description: 'Show or set permission mode and per-tool settings',
    usage: '[allow-all|prompt|custom] | [tool <name> allow|prompt|deny]',
    argsHint: '[allow-all|prompt|custom]',
    handler(args, ctx) {
      const cm = ctx.configManager;
      const VALID_MODES = ['allow-all', 'prompt', 'custom'] as const;
      const VALID_ACTIONS = ['allow', 'prompt', 'deny'] as const;
      const VALID_TOOLS = ['read', 'write', 'edit', 'exec', 'find', 'fetch', 'analyze', 'inspect', 'agent', 'state', 'workflow', 'registry', 'delegate', 'mcp'] as const;
      type PermTool = typeof VALID_TOOLS[number];
      if (args.length === 0) {
        if (ctx.openSelection) {
          const cycleActions = new Map([['enter', 'toggle' as const]]);
          const items: SelectionItem[] = VALID_TOOLS.map(tool => ({
            id: tool,
            label: tool,
            detail: cm.get(`permissions.tools.${tool}` as Parameters<typeof cm.get>[0]) as string,
            category: 'tools',
            actions: '[Enter] cycle allow/prompt/deny',
          }));
          items.unshift({
            id: '__mode__',
            label: 'permission mode',
            detail: cm.get('permissions.mode') as string,
            category: 'global',
            actions: '[Enter] cycle allow-all/prompt/custom',
          });
          ctx.openSelection('Permissions', items, { allowSearch: true, customActions: cycleActions }, (result) => {
            if (!result) return;
            if (result.item.id === '__mode__') {
              const currentMode = cm.get('permissions.mode') as string;
              const nextMode = VALID_MODES[(VALID_MODES.indexOf(currentMode as typeof VALID_MODES[number]) + 1) % VALID_MODES.length];
              cm.setDynamic('permissions.mode', nextMode);
              result.item.detail = nextMode;
            } else {
              const toolKey = `permissions.tools.${result.item.id}` as Parameters<typeof cm.get>[0];
              const currentAction = cm.get(toolKey) as string;
              const nextAction = VALID_ACTIONS[(VALID_ACTIONS.indexOf(currentAction as typeof VALID_ACTIONS[number]) + 1) % VALID_ACTIONS.length];
              cm.setDynamic(toolKey, nextAction);
              result.item.detail = nextAction;
            }
            ctx.renderRequest();
          });
          return;
        }
        const lines = [`Permission mode: ${cm.get('permissions.mode')}`, '  Tool settings:'];
        for (const tool of VALID_TOOLS) lines.push(`    ${tool.padEnd(16)} ${cm.get(`permissions.tools.${tool}` as Parameters<typeof cm.get>[0])}`);
        lines.push('', '  Modes: prompt (default), allow-all, custom', '  Usage: /permissions <mode> | /permissions tool <name> allow|prompt|deny');
        ctx.print(lines.join('\n'));
        return;
      }
      if (args[0] === 'tool') {
        const toolName = args[1];
        const action = args[2];
        if (!toolName || !action) {
          ctx.print('Usage: /permissions tool <name> allow|prompt|deny');
          return;
        }
        if (!VALID_TOOLS.includes(toolName as PermTool)) {
          ctx.print(`Unknown tool: ${toolName}\nValid tools: ${VALID_TOOLS.join(', ')}`);
          return;
        }
        if (!VALID_ACTIONS.includes(action as typeof VALID_ACTIONS[number])) {
          ctx.print(`Invalid action: ${action}\nValid actions: allow, prompt, deny`);
          return;
        }
        try {
          cm.setDynamic(`permissions.tools.${toolName}` as Parameters<typeof cm.set>[0], action);
          ctx.print(`Permission for ${toolName} set to: ${action}`);
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
        return;
      }
      if (!VALID_MODES.includes(args[0] as typeof VALID_MODES[number])) {
        ctx.print(`Invalid mode: ${args[0]}\nValid modes: ${VALID_MODES.join(', ')}`);
        return;
      }
      try {
        cm.setDynamic('permissions.mode', args[0]);
        ctx.print(`Permission mode set to: ${args[0]}`);
      } catch (e) {
        ctx.print(`Error: ${(e as Error).message}`);
      }
    },
  });

  registry.register({ name: 'expand', description: 'Expand blocks by type', usage: '[all|thinking|tool|code]', argsHint: '[all|thinking|tool|code]', handler(args, ctx) { toggleBlocks(args[0] || 'all', false, ctx); } });
  registry.register({ name: 'collapse', description: 'Collapse blocks by type', usage: '[all|thinking|tool|code]', argsHint: '[all|thinking|tool|code]', handler(args, ctx) { toggleBlocks(args[0] || 'all', true, ctx); } });

  registry.register({
    name: 'bookmarks',
    aliases: ['bm'],
    description: 'List bookmarked blocks',
    handler(_args, ctx) {
      if (ctx.openBookmarkModal) {
        ctx.openBookmarkModal();
        return;
      }
      const bm = getBookmarkManager();
      const entries = bm.list();
      if (ctx.openSelection) {
        const deleteAction = new Map([['d', 'delete' as const]]);
        const items: SelectionItem[] = entries.length === 0
          ? [{ id: '_empty', label: 'No bookmarks', detail: 'Use Ctrl+B to bookmark' }]
          : entries.map(entry => ({ id: entry.key, label: entry.label, detail: new Date(entry.timestamp).toLocaleTimeString(), actions: '[d] delete' }));
        ctx.openSelection('Bookmarks', items, { allowSearch: true, customActions: deleteAction }, (result) => {
          if (!result) return;
          if (result.action === 'delete') {
            bm.toggle(result.item.id);
            ctx.print(`Bookmark removed: ${result.item.id}`);
          } else {
            ctx.jumpToBookmark?.(result.item.id);
          }
        });
        return;
      }
      ctx.print(['Bookmarks:', '', ...entries.map(entry => `  ${entry.key.padEnd(32)} ${entry.label}  (${new Date(entry.timestamp).toLocaleTimeString()})`)].join('\n'));
    },
  });

  registry.register({
    name: 'secrets',
    description: 'Manage encrypted API key secrets',
    usage: 'set <KEY> <value> | get <KEY> | list | delete <KEY>',
    argsHint: '<set|get|list|delete> [KEY]',
    async handler(args, ctx) {
      const mgr = getSecretsManager();
      const [sub, ...rest] = args;
      if (!sub || sub === 'list') {
        const keys = await mgr.list();
        ctx.print(keys.length === 0 ? '[secrets] No secrets stored. Use: /secrets set <KEY> <value>' : ['[secrets] Stored keys (values are encrypted at rest):', ...keys.map(k => `  ${k}`)].join('\n'));
        return;
      }
      if (sub === 'set') {
        const [key, ...valueParts] = rest;
        if (!key || valueParts.length === 0) {
          ctx.print('[secrets] Usage: /secrets set <KEY> <value>');
          return;
        }
        await mgr.set(key, valueParts.join(' '));
        ctx.print(`[secrets] Stored: ${key} (encrypted at rest)`);
        return;
      }
      if (sub === 'get') {
        const [key] = rest;
        if (!key) {
          ctx.print('[secrets] Usage: /secrets get <KEY>');
          return;
        }
        const value = await mgr.get(key);
        ctx.print(value === null ? `[secrets] Not found: ${key}` : `[secrets] ${key} = <stored> (use /secrets list to see all keys)`);
        return;
      }
      if (sub === 'delete') {
        const [key] = rest;
        if (!key) {
          ctx.print('[secrets] Usage: /secrets delete <KEY>');
          return;
        }
        await mgr.delete(key);
        ctx.print(`[secrets] Deleted: ${key}`);
        return;
      }
      ctx.print('[secrets] Usage: /secrets set <KEY> <value> | get <KEY> | list | delete <KEY>');
    },
  });

  registry.register({
    name: 'services',
    aliases: ['svc'],
    description: 'Manage API service configurations',
    usage: '[open|list|inspect <name>|test <name>|resolve <name>|auth <name>|auth-review|doctor|export <path>|import <path>]',
    async handler(args, ctx) {
      const sub = args[0] ?? 'open';
      if (sub === 'open' || sub === 'panel') {
        const panelManager = getPanelManager();
        panelManager.open('services');
        panelManager.show();
        ctx.renderRequest();
        return;
      }
      const svcRegistry = getServiceRegistry();
      const all = svcRegistry.getAll();
      const keys = Object.keys(all);
      if (sub === 'inspect') {
        const name = args[1];
        if (!name) {
          ctx.print('Usage: /services inspect <name>');
          return;
        }
        const inspection = await svcRegistry.inspect(name);
        if (!inspection) {
          ctx.print(`Unknown service: ${name}`);
          return;
        }
        ctx.print([
          `Service ${name}`,
          `  authType: ${inspection.config.authType}`,
          `  baseUrl: ${inspection.config.baseUrl ?? '(none)'}`,
          `  primaryCredential: ${inspection.hasPrimaryCredential ? 'present' : 'missing'}`,
          `  passwordCredential: ${inspection.hasPasswordCredential ? 'present' : 'missing'}`,
          `  webhookUrl: ${inspection.hasWebhookUrl ? 'present' : 'missing'}`,
          `  signingSecret: ${inspection.hasSigningSecret ? 'present' : 'missing'}`,
          `  publicKey: ${inspection.hasPublicKey ? 'present' : 'missing'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'test') {
        const name = args[1];
        if (!name) {
          ctx.print('Usage: /services test <name>');
          return;
        }
        const result = await svcRegistry.testConnection(name);
        ctx.print([
          `Service test ${name}`,
          `  ok: ${result.ok ? 'yes' : 'no'}`,
          `  status: ${result.status ?? 'n/a'}`,
          `  url: ${result.testedUrl ?? 'n/a'}`,
          `  error: ${result.error ?? 'none'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'resolve') {
        const name = args[1];
        if (!name) {
          ctx.print('Usage: /services resolve <name>');
          return;
        }
        const headers = await svcRegistry.resolveAuth(name);
        if (!headers) {
          ctx.print(`Service ${name} has no resolvable auth headers right now.`);
          return;
        }
        ctx.print([
          `Resolved auth headers for ${name}`,
          ...Object.keys(headers).map((key) => `  ${key}: <redacted>`),
        ].join('\n'));
        return;
      }
      if (sub === 'auth') {
        const name = args[1];
        if (!name) {
          ctx.print('Usage: /services auth <name>');
          return;
        }
        const headers = await svcRegistry.resolveAuth(name);
        if (!headers) {
          ctx.print(`Service ${name} has no resolvable auth headers right now.`);
          return;
        }
        ctx.print([
          `Service auth ${name}`,
          ...Object.keys(headers).map((key) => `  ${key}: <resolved>`),
        ].join('\n'));
        return;
      }
      if (sub === 'doctor') {
        const inspections = await Promise.all(keys.map((name) => svcRegistry.inspect(name)));
        const issues = inspections
          .filter((inspection): inspection is NonNullable<typeof inspection> => inspection !== null)
          .flatMap((inspection) => {
            const findings: string[] = [];
            if (!inspection.hasPrimaryCredential) findings.push(`${inspection.config.name}: missing primary credential`);
            if (inspection.config.authType === 'basic' && !inspection.hasPasswordCredential) findings.push(`${inspection.config.name}: missing password credential`);
            if (!inspection.config.baseUrl) findings.push(`${inspection.config.name}: no baseUrl configured`);
            return findings;
          });
        ctx.print([
          'Service Doctor',
          `  configured: ${keys.length}`,
          `  issues: ${issues.length}`,
          ...(issues.length > 0 ? issues.map((issue) => `  ${issue}`) : ['  all configured services passed readiness checks']),
        ].join('\n'));
        return;
      }
      if (sub === 'auth-review') {
        const inspections = await Promise.all(keys.map((name) => svcRegistry.inspect(name)));
        const authCounts = new Map<string, number>();
        const issues = inspections
          .filter((inspection): inspection is NonNullable<typeof inspection> => inspection !== null)
          .flatMap((inspection) => {
            authCounts.set(inspection.config.authType, (authCounts.get(inspection.config.authType) ?? 0) + 1);
            const findings: string[] = [];
            if (!inspection.config.baseUrl) findings.push(`${inspection.config.name}: missing baseUrl`);
            if ((inspection.config.authType === 'bearer' || inspection.config.authType === 'api-key') && !inspection.hasPrimaryCredential) {
              findings.push(`${inspection.config.name}: missing primary credential`);
            }
            if (inspection.config.authType === 'basic' && !inspection.hasPasswordCredential) {
              findings.push(`${inspection.config.name}: missing password credential`);
            }
            return findings;
          });
        ctx.print([
          'Service Auth Review',
          `  configured: ${keys.length}`,
          ...[...authCounts.entries()].map(([authType, count]) => `  ${authType}: ${count}`),
          ...(issues.length > 0 ? ['', ...issues.map((issue) => `  issue: ${issue}`)] : ['', '  all configured services have a complete auth posture']),
        ].join('\n'));
        return;
      }
      if (sub === 'export') {
        const pathArg = args[1];
        if (!pathArg) {
          ctx.print('Usage: /services export <path>');
          return;
        }
        const targetPath = resolve(process.cwd(), pathArg);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, JSON.stringify(all, null, 2) + '\n', 'utf-8');
        ctx.print(`Exported services config to ${targetPath}`);
        return;
      }
      if (sub === 'import') {
        const pathArg = args[1];
        if (!pathArg) {
          ctx.print('Usage: /services import <path>');
          return;
        }
        const sourcePath = resolve(process.cwd(), pathArg);
        try {
          const parsed = JSON.parse(readFileSync(sourcePath, 'utf-8')) as Record<string, unknown>;
          const targetPath = join(process.cwd(), '.goodvibes', 'tui', 'services.json');
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
          ctx.print(`Imported services config from ${sourcePath}`);
        } catch (error) {
          ctx.print(`Failed to import services config: ${(error as Error).message}`);
        }
        return;
      }
      if (ctx.openSelection) {
        const testAction = new Map<string, import('../selection-modal.ts').SelectionAction>([['t', 'select' as const]]);
        const items: SelectionItem[] = keys.length === 0
          ? [{ id: '_empty', label: 'No services configured', detail: '.goodvibes/tui/services.json' }]
          : keys.map((key) => ({ id: key, label: all[key].name ?? key, detail: `${all[key].authType}  ${all[key].baseUrl ?? '(no url)'}`, actions: '[t] test' }));
        ctx.openSelection('Services', items, { allowSearch: true, customActions: testAction }, (result) => {
          if (!result || result.item.id === '_empty') return;
          const svc = all[result.item.id];
          if (!svc) return;
          const baseUrl = svc.baseUrl ?? '';
          if (!baseUrl) {
            ctx.print(`[services] ${result.item.id}: no baseUrl configured`);
            return;
          }
          const testUrl = baseUrl.replace(/\/$/, '') + '/health';
          ctx.print(`[services] Testing ${result.item.id} → GET ${testUrl} …`);
          void svcRegistry.resolveAuth(result.item.id).then(async (headers) => {
            const reqHeaders: Record<string, string> = { Accept: 'application/json', ...(headers ?? {}) };
            try {
              const resp = await fetch(testUrl, { method: 'GET', headers: reqHeaders, signal: AbortSignal.timeout(5000) });
              ctx.print(`[services] ${result.item.id}: HTTP ${resp.status} ${resp.ok ? '\u2713 OK' : '\u2717 error'}`);
            } catch {
              try {
                const resp2 = await fetch(baseUrl, { method: 'GET', headers: reqHeaders, signal: AbortSignal.timeout(5000) });
                ctx.print(`[services] ${result.item.id}: HTTP ${resp2.status} ${resp2.ok ? '\u2713 OK' : '\u2717 error'}`);
              } catch (err2) {
                ctx.print(`[services] ${result.item.id}: error — ${(err2 as Error).message}`);
              }
            }
            ctx.renderRequest();
          });
        });
        return;
      }
      if (keys.length === 0) {
        ctx.print('[services] No services configured. Add entries to .goodvibes/tui/services.json');
        return;
      }
      ctx.print(['Services:', '', ...keys.map((key) => `  ${key.padEnd(20)} ${all[key].authType.padEnd(10)} ${all[key].baseUrl ?? '(no url)'}`)].join('\n'));
    },
  });

  registry.register({
    name: 'skills',
    aliases: ['skill'],
    description: 'Inspect installed skill packs',
    usage: '[open|list|show <name>|origins|browse [query]|installed|catalog-review <id>|publish-local <id> <path> <summary...>|unpublish <id>|install-hint <catalog-id>|install <id> [project|user]|update <id> [project|user]|uninstall <id> [project|user]]',
    handler(args, ctx) {
      const sub = args[0] ?? 'open';
      if (sub === 'open' || sub === 'panel') {
        const panelManager = getPanelManager();
        panelManager.open('skills');
        panelManager.show();
        ctx.renderRequest();
        return;
      }
      const skills = discoverSkills();
      if (sub === 'list') {
        if (skills.length === 0) {
          ctx.print('No skills discovered.');
          return;
        }
        ctx.print([
          `Skills (${skills.length})`,
          ...skills.map((skill) => `  ${skill.name}  [${skill.origin}]  ${skill.description || 'No description provided.'}`),
        ].join('\n'));
        return;
      }
      if (sub === 'origins') {
        const counts = new Map<string, number>();
        for (const skill of skills) counts.set(skill.origin, (counts.get(skill.origin) ?? 0) + 1);
        ctx.print([
          'Skill Origins',
          ...[...counts.entries()].map(([origin, count]) => `  ${origin}: ${count}`),
        ].join('\n'));
        return;
      }
      if (sub === 'show') {
        const name = args[1];
        if (!name) {
          ctx.print('Usage: /skills show <name>');
          return;
        }
        const skill = skills.find((entry) => entry.name === name);
        if (!skill) {
          ctx.print(`Unknown skill: ${name}`);
          return;
        }
        ctx.print([
          `Skill ${skill.name}`,
          `  origin: ${skill.origin}`,
          `  path: ${skill.path}`,
          `  description: ${skill.description || 'No description provided.'}`,
          `  dependencies: ${skill.dependencies.join(', ') || '(none)'}`,
          `  includes: ${skill.includes.join(', ') || '(none)'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'browse' || sub === 'catalog') {
        const query = args.slice(1).join(' ');
        const entries = query
          ? searchEcosystemCatalog('skill', query)
          : loadEcosystemCatalog('skill');
        if (entries.length === 0) {
          ctx.print(query
            ? `No curated skill catalog entries matched "${query}".`
            : 'No curated skill catalog entries found. Add .goodvibes/tui/ecosystem/skills.json to publish a local-first skill catalog.');
          return;
        }
        ctx.print([
          `Curated Skill Catalog (${entries.length})`,
          ...entries.map((entry) => `  ${entry.id}  ${entry.name}  [${entry.tags.join(', ') || 'untagged'}]  ${entry.summary}`),
        ].join('\n'));
        return;
      }
      if (sub === 'installed') {
        const receipts = listInstalledEcosystemEntries('skill');
        if (receipts.length === 0) {
          ctx.print('No curated skills installed from local catalogs yet.');
          return;
        }
        ctx.print([
          `Installed Curated Skills (${receipts.length})`,
          ...receipts.map((receipt) => `  ${receipt.entry.id}  ${receipt.scope}  ${receipt.targetPath}`),
        ].join('\n'));
        return;
      }
      if (sub === 'catalog-review') {
        const entryId = args[1];
        if (!entryId) {
          ctx.print('Usage: /skills catalog-review <catalog-id>');
          return;
        }
        const entry = loadEcosystemCatalog('skill').find((candidate) => candidate.id === entryId);
        if (!entry) {
          ctx.print(`Unknown curated skill entry: ${entryId}`);
          return;
        }
        const review = reviewEcosystemCatalogEntry(entry);
        ctx.print([
          `Skill Catalog Review: ${entry.name}`,
          `  id: ${entry.id}`,
          `  source: ${entry.source}`,
          `  sourceKind: ${review.sourceKind}`,
          `  sourceExists: ${review.sourceExists ? 'yes' : 'no'}`,
          `  recommendedScope: ${review.recommendedScope}`,
          `  risk: ${review.riskLevel}`,
          `  trust notes: ${entry.trustNotes ?? '(none)'}`,
          `  provenance: ${entry.provenance ?? '(none)'}`,
          `  update hint: ${entry.updateHint ?? '(none)'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'publish-local') {
        const entryId = args[1];
        const sourcePath = args[2];
        const summary = args.slice(3).join(' ').trim();
        if (!entryId || !sourcePath || !summary) {
          ctx.print('Usage: /skills publish-local <catalog-id> <path> <summary...>');
          return;
        }
        const result = upsertEcosystemCatalogEntry({
          id: entryId,
          kind: 'skill',
          name: entryId.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
          summary,
          source: sourcePath,
          tags: ['local-first', 'published'],
          provenance: 'operator-published',
          updateHint: 'Use /skills publish-local again to refresh catalog metadata after edits.',
        });
        ctx.print(result.ok
          ? `Published curated skill ${entryId} into ${result.path}`
          : `Error: ${result.error}`);
        return;
      }
      if (sub === 'unpublish') {
        const entryId = args[1];
        if (!entryId) {
          ctx.print('Usage: /skills unpublish <catalog-id>');
          return;
        }
        const result = removeEcosystemCatalogEntry('skill', entryId);
        ctx.print(result.ok
          ? `Removed curated skill ${entryId} from ${result.path}`
          : `Error: ${result.error}`);
        return;
      }
      if (sub === 'install-hint') {
        const entryId = args[1];
        if (!entryId) {
          ctx.print('Usage: /skills install-hint <catalog-id>');
          return;
        }
        const entry = loadEcosystemCatalog('skill').find((candidate) => candidate.id === entryId);
        if (!entry) {
          ctx.print(`Unknown curated skill entry: ${entryId}`);
          return;
        }
        ctx.print([
          `Skill Install Guidance: ${entry.name}`,
          `  id: ${entry.id}`,
          `  source: ${entry.source}`,
          `  tags: ${entry.tags.join(', ') || '(none)'}`,
          `  trust notes: ${entry.trustNotes ?? '(none)'}`,
          `  install hint: ${entry.installHint ?? 'Place the skill pack under a configured skill directory and refresh the skills panel.'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'install') {
        const entryId = args[1];
        const scopeArg = args[2];
        if (!entryId) {
          ctx.print('Usage: /skills install <catalog-id> [project|user]');
          return;
        }
        const scope = scopeArg === 'project' ? 'project' : 'user';
        const result = installEcosystemCatalogEntry('skill', entryId, { scope });
        ctx.print(result.ok
          ? `Installed curated skill ${entryId} into ${result.receipt.targetPath}`
          : `Error: ${result.error}`);
        return;
      }
      if (sub === 'update') {
        const entryId = args[1];
        const scopeArg = args[2];
        if (!entryId) {
          ctx.print('Usage: /skills update <catalog-id> [project|user]');
          return;
        }
        const scope = scopeArg === 'project' ? 'project' : 'user';
        const result = updateInstalledEcosystemEntry('skill', entryId, { scope });
        ctx.print(result.ok
          ? `Updated curated skill ${entryId} in ${result.receipt.targetPath}`
          : `Error: ${result.error}`);
        return;
      }
      if (sub === 'uninstall') {
        const entryId = args[1];
        const scopeArg = args[2];
        if (!entryId) {
          ctx.print('Usage: /skills uninstall <catalog-id> [project|user]');
          return;
        }
        const scope = scopeArg === 'project' ? 'project' : 'user';
        const result = uninstallEcosystemCatalogEntry('skill', entryId, { scope });
        ctx.print(result.ok
          ? `Uninstalled curated skill ${entryId} from ${result.removedPath}`
          : `Error: ${result.error}`);
        return;
      }
      ctx.print('Usage: /skills [open|list|show <name>|origins|browse [query]|installed|catalog-review <id>|publish-local <id> <path> <summary...>|unpublish <id>|install-hint <catalog-id>|install <id> [project|user]|update <id> [project|user]|uninstall <id> [project|user]]');
    },
  });

  registry.register({
    name: 'setup',
    aliases: ['startup'],
    description: 'Review startup readiness, ecosystem posture, and service configuration',
    usage: '[review|doctor|services|hooks|remote|onboarding|support-bundle <dir>|export <path>|transfer <export|inspect|import> <path>|link <surface> [target]|open-link <uri>]',
    async handler(args, ctx) {
      const sub = args[0] ?? 'review';
      const snapshot = await buildSetupReviewSnapshot(ctx);
      if (sub === 'review') {
        ctx.print([
          'Startup Readiness Review',
          `  session: ${snapshot.sessionId}`,
          `  providers/models: ${snapshot.providerCount}`,
          `  services configured: ${snapshot.serviceCount}`,
          `  skills discovered: ${snapshot.skillCount}`,
          `  plugins discovered: ${snapshot.pluginCount}`,
          `  quarantined plugins: ${snapshot.quarantinedPluginCount}`,
          `  plugin search dirs: ${snapshot.pluginDirectories.length}`,
          `  managed hooks: ${snapshot.managedHookCount}`,
          `  managed hook chains: ${snapshot.managedHookChainCount}`,
          `  mcp servers known: ${snapshot.mcpServerCount}`,
          `  mcp quarantined: ${snapshot.quarantinedMcpCount}`,
          `  mcp elevated: ${snapshot.elevatedMcpCount}`,
          `  remote runners: ${snapshot.remoteRunnerCount}`,
          '',
          `  service ids: ${snapshot.services.join(', ') || '(none)'}`,
          `  plugin dirs: ${snapshot.pluginDirectories.join(', ') || '(none)'}`,
        ].join('\n'));
        return;
      }

      if (sub === 'doctor') {
        ctx.print([
          'Startup Doctor',
          ...snapshot.issues.map((issue) => `  [${issue.severity.toUpperCase()}] ${issue.area}: ${issue.message}`),
          ...(snapshot.serviceIssues.length > 0
            ? ['', '  Service issues:', ...snapshot.serviceIssues.map((issue) => `    - ${issue}`)]
            : []),
        ].join('\n'));
        return;
      }

      if (sub === 'services') {
        ctx.print([
          'Startup Services',
          `  configured: ${snapshot.serviceCount}`,
          `  issues: ${snapshot.serviceIssues.length}`,
          ...snapshot.services.map((name) => `  ${name}`),
          ...(snapshot.serviceIssues.length > 0
            ? ['', ...snapshot.serviceIssues.map((issue) => `  issue: ${issue}`)]
            : []),
        ].join('\n'));
        return;
      }

      if (sub === 'hooks') {
        const contracts = listHookPointContracts();
        ctx.print([
          'Startup Hooks',
          `  managed hooks: ${snapshot.managedHookCount}`,
          `  managed chains: ${snapshot.managedHookChainCount}`,
          `  hook contracts: ${contracts.length}`,
        ].join('\n'));
        return;
      }

      if (sub === 'remote') {
        const runners = getRemoteRunnerRegistry().listContracts();
        ctx.print([
          'Startup Remote',
          `  runner contracts: ${snapshot.remoteRunnerCount}`,
          ...runners.map((runner) => `  ${runner.id}  [${runner.trustClass}]  ${runner.label}`),
        ].join('\n'));
        return;
      }

      if (sub === 'onboarding') {
        ctx.print([
          'Onboarding Checklist',
          `  providers: ${snapshot.providerCount > 0 ? '[ready]' : '[needs setup]'}`,
          `  services: ${snapshot.serviceCount > 0 ? '[ready]' : '[optional]'}`,
          `  hooks: ${(snapshot.managedHookCount + snapshot.managedHookChainCount) > 0 ? '[ready]' : '[optional]'}`,
          `  remote: ${snapshot.remoteRunnerCount > 0 ? '[ready]' : '[optional]'}`,
          `  plugins: ${snapshot.pluginCount > 0 ? '[ready]' : '[optional]'}`,
          `  skills: ${snapshot.skillCount > 0 ? '[ready]' : '[optional]'}`,
          '',
          'Recommended next commands:',
          '  /provider',
          '  /services doctor',
          '  /hooks scaffold <name> <match> <type>',
          '  /remote setup',
          '  /plugin browse',
          '  /skills browse',
        ].join('\n'));
        return;
      }

      if (sub === 'support-bundle') {
        const dirArg = args[1];
        if (!dirArg) {
          ctx.print('Usage: /setup support-bundle <dir>');
          return;
        }
        const targetDir = resolve(process.cwd(), dirArg);
        mkdirSync(targetDir, { recursive: true });
        writeFileSync(join(targetDir, 'startup-review.json'), JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
        const servicesPath = join(process.cwd(), '.goodvibes', 'tui', 'services.json');
        if (existsSync(servicesPath)) {
          writeFileSync(join(targetDir, 'services.json'), readFileSync(servicesPath, 'utf-8'), 'utf-8');
        }
        const hooksPath = join(process.cwd(), '.goodvibes', 'hooks.managed.json');
        if (existsSync(hooksPath)) {
          writeFileSync(join(targetDir, 'hooks.managed.json'), readFileSync(hooksPath, 'utf-8'), 'utf-8');
        }
        writeFileSync(join(targetDir, 'remote-summary.json'), JSON.stringify({
          runners: getRemoteRunnerRegistry().listContracts(),
          artifacts: getRemoteRunnerRegistry().listArtifacts().map((artifact) => ({
            id: artifact.id,
            runnerId: artifact.runnerId,
            status: artifact.task.status,
            createdAt: artifact.createdAt,
          })),
        }, null, 2) + '\n', 'utf-8');
        ctx.print(`Exported support bundle to ${targetDir}`);
        return;
      }

      if (sub === 'export') {
        const pathArg = args[1];
        if (!pathArg) {
          ctx.print('Usage: /setup export <path>');
          return;
        }
        const targetPath = resolve(process.cwd(), pathArg);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
        ctx.print(`Exported startup review to ${targetPath}`);
        return;
      }

      if (sub === 'transfer') {
        const mode = args[1]?.toLowerCase();
        const pathArg = args[2];
        if (!mode || !pathArg) {
          ctx.print('Usage: /setup transfer <export|inspect|import> <path>');
          return;
        }
        const targetPath = resolve(process.cwd(), pathArg);
        if (mode === 'export') {
          const bundle = buildSetupTransferBundle(ctx, snapshot);
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
          ctx.print(`Exported setup transfer bundle to ${targetPath}`);
          return;
        }
        if (mode === 'inspect') {
          try {
            const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as SetupTransferBundle;
            ctx.print(`${inspectSetupTransferBundle(bundle)}\n  path: ${targetPath}`);
          } catch (error) {
            ctx.print(`Failed to inspect setup transfer bundle: ${(error as Error).message}`);
          }
          return;
        }
        if (mode === 'import') {
          try {
            const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as SetupTransferBundle;
            for (const entry of CONFIG_SCHEMA) {
              if (Object.prototype.hasOwnProperty.call(bundle.config, entry.key)) {
                ctx.configManager.setDynamic(entry.key as ConfigKey, (bundle.config as Record<string, unknown>)[entry.key]);
              }
            }
            if (bundle.services) {
              const servicesPath = join(process.cwd(), '.goodvibes', 'tui', 'services.json');
              mkdirSync(dirname(servicesPath), { recursive: true });
              writeFileSync(servicesPath, JSON.stringify(bundle.services, null, 2) + '\n', 'utf-8');
            }
            if (bundle.ecosystem?.plugins) {
              const pluginsPath = join(process.cwd(), '.goodvibes', 'tui', 'ecosystem', 'plugins.json');
              mkdirSync(dirname(pluginsPath), { recursive: true });
              writeFileSync(pluginsPath, JSON.stringify(bundle.ecosystem.plugins, null, 2) + '\n', 'utf-8');
            }
            if (bundle.ecosystem?.skills) {
              const skillsPath = join(process.cwd(), '.goodvibes', 'tui', 'ecosystem', 'skills.json');
              mkdirSync(dirname(skillsPath), { recursive: true });
              writeFileSync(skillsPath, JSON.stringify(bundle.ecosystem.skills, null, 2) + '\n', 'utf-8');
            }
            ctx.print(`Imported setup transfer bundle from ${targetPath}`);
          } catch (error) {
            ctx.print(`Failed to import setup transfer bundle: ${(error as Error).message}`);
          }
          return;
        }
        ctx.print('Usage: /setup transfer <export|inspect|import> <path>');
        return;
      }

      if (sub === 'link') {
        const surface = args[1];
        const target = args[2];
        if (!surface) {
          ctx.print('Usage: /setup link <cockpit|security|remote|knowledge|incident|hooks|orchestration|tasks> [target]');
          return;
        }
        ctx.print(createSetupLink(surface, target));
        return;
      }

      if (sub === 'open-link') {
        const link = args[1];
        if (!link) {
          ctx.print('Usage: /setup open-link <goodvibes://...>');
          return;
        }
        const parsed = parseSetupLink(link);
        if (!parsed) {
          ctx.print(`Invalid setup link: ${link}`);
          return;
        }
        const panelOpeners: Record<string, (() => void) | undefined> = {
          cockpit: ctx.openCockpitPanel,
          security: ctx.openSecurityPanel,
          remote: ctx.openRemotePanel,
          knowledge: ctx.openKnowledgePanel,
          incident: ctx.openIncidentPanel,
          hooks: ctx.openHooksPanel,
          orchestration: ctx.openOrchestrationPanel,
        };
        if (parsed.surface === 'tasks') {
          const panelManager = getPanelManager();
          panelManager.open('tasks');
          panelManager.show();
          ctx.renderRequest();
          ctx.print(`Opened setup link for tasks${parsed.target ? ` (${parsed.target})` : ''}.`);
          return;
        }
        const openPanel = panelOpeners[parsed.surface];
        if (!openPanel) {
          ctx.print(`Unsupported setup link surface: ${parsed.surface}`);
          return;
        }
        openPanel();
        ctx.print(`Opened setup link for ${parsed.surface}${parsed.target ? ` (${parsed.target})` : ''}.`);
        return;
      }

      ctx.print('Usage: /setup [review|doctor|services|hooks|remote|onboarding|support-bundle <dir>|export <path>|transfer <export|inspect|import> <path>|link <surface> [target]|open-link <uri>]');
    },
  });

  registry.register({
    name: 'tasks',
    aliases: ['task'],
    description: 'Inspect and control runtime tasks',
    usage: '[list [status|kind] | show <taskId> | output <taskId> | create <kind> <owner> <title...> | update <taskId> <title|description|result> <value...> | complete <taskId> [result] | fail <taskId> <error...> | cancel <taskId> [note] | pause <taskId> [note] | resume <taskId> [note] | retry <taskId> [note]]',
    handler(args, ctx) {
      if (args.length === 0) {
        const panelManager = getPanelManager();
        panelManager.open('tasks');
        panelManager.show();
        ctx.renderRequest();
        return;
      }

      const store = ctx.runtimeStore;
      if (!store) {
        ctx.print('Runtime store is not available for task commands.');
        return;
      }

      const tasks = sortRuntimeTasks([...store.getState().tasks.tasks.values()]);
      const subcommand = args[0]?.toLowerCase() ?? 'list';

      if (subcommand === 'list') {
        const filter = args[1]?.toLowerCase();
        const filtered = tasks.filter((task) => (
          !filter
          || task.status === filter
          || task.kind === filter
        ));
        if (filtered.length === 0) {
          ctx.print(filter ? `No tasks matched "${filter}".` : 'No tasks recorded yet.');
          return;
        }
        ctx.print([
          `Runtime Tasks (${filtered.length})`,
          ...filtered.slice(0, 20).map((task) => (
            `  ${task.id}  ${task.status.padEnd(9)} ${task.kind.padEnd(11)} ${task.owner}  ${task.title}`
          )),
        ].join('\n'));
        return;
      }

      if (subcommand === 'show') {
        const taskId = args[1];
        if (!taskId) {
          ctx.print('Usage: /tasks show <taskId>');
          return;
        }
        const task = store.getState().tasks.tasks.get(taskId);
        if (!task) {
          ctx.print(`Unknown task: ${taskId}`);
          return;
        }
        ctx.print([
          `Task ${task.id}`,
          `  title: ${task.title}`,
          `  kind: ${task.kind}`,
          `  status: ${task.status}`,
          `  owner: ${task.owner}`,
          `  cancellable: ${task.cancellable ? 'yes' : 'no'}`,
          `  queuedAt: ${new Date(task.queuedAt).toISOString()}`,
          `  startedAt: ${task.startedAt ? new Date(task.startedAt).toISOString() : 'n/a'}`,
          `  endedAt: ${task.endedAt ? new Date(task.endedAt).toISOString() : 'n/a'}`,
          `  parent: ${task.parentTaskId ?? 'none'}`,
          `  children: ${task.childTaskIds.join(', ') || '(none)'}`,
          `  correlationId: ${task.correlationId ?? 'n/a'}`,
          `  summary: ${summarizeTaskResult(task)}`,
        ].join('\n'));
        return;
      }

      if (subcommand === 'output') {
        const taskId = args[1];
        if (!taskId) {
          ctx.print('Usage: /tasks output <taskId>');
          return;
        }
        const task = store.getState().tasks.tasks.get(taskId);
        if (!task) {
          ctx.print(`Unknown task: ${taskId}`);
          return;
        }
        const payload = (
          typeof task.result === 'string'
            ? task.result
            : task.result !== undefined
              ? JSON.stringify(task.result, null, 2)
              : task.error ?? task.description ?? task.title
        );
        ctx.print(String(payload));
        return;
      }

      if (subcommand === 'create') {
        if (!ctx.taskManager) {
          ctx.print('Task manager is not available for task creation in this runtime.');
          return;
        }
        const kind = args[1];
        const owner = args[2];
        const title = args.slice(3).join(' ').trim();
        if (!kind || !owner || !title) {
          ctx.print('Usage: /tasks create <kind> <owner> <title...>');
          return;
        }
        const validKinds = new Set(['exec', 'agent', 'acp', 'scheduler', 'daemon', 'mcp', 'plugin', 'integration']);
        if (!validKinds.has(kind)) {
          ctx.print(`Unknown task kind: ${kind}`);
          return;
        }
        const task = ctx.taskManager.createTask({
          kind: kind as import('../../runtime/store/domains/tasks.ts').TaskKind,
          owner,
          title,
          description: title,
        });
        ctx.print(`Created task ${task.id} (${task.kind}) for ${task.owner}.`);
        return;
      }

      if (subcommand === 'update') {
        if (!ctx.taskManager) {
          ctx.print('Task manager is not available for task updates in this runtime.');
          return;
        }
        const taskId = args[1];
        const field = args[2];
        const value = args.slice(3).join(' ').trim();
        if (!taskId || !field || !value) {
          ctx.print('Usage: /tasks update <taskId> <title|description|result> <value...>');
          return;
        }
        if (field !== 'title' && field !== 'description' && field !== 'result') {
          ctx.print(`Unsupported task update field: ${field}`);
          return;
        }
        ctx.taskManager.updateTask(taskId, field === 'result' ? { result: value } : { [field]: value });
        ctx.print(`Updated task ${taskId} field ${field}.`);
        return;
      }

      if (subcommand === 'complete') {
        if (!ctx.taskManager) {
          ctx.print('Task manager is not available for task completion in this runtime.');
          return;
        }
        const taskId = args[1];
        if (!taskId) {
          ctx.print('Usage: /tasks complete <taskId> [result]');
          return;
        }
        const result = args.slice(2).join(' ').trim() || undefined;
        ctx.taskManager.completeTask(taskId, result);
        ctx.print(`Completed task ${taskId}.`);
        return;
      }

      if (subcommand === 'fail') {
        if (!ctx.taskManager) {
          ctx.print('Task manager is not available for task failure transitions in this runtime.');
          return;
        }
        const taskId = args[1];
        const errorText = args.slice(2).join(' ').trim();
        if (!taskId || !errorText) {
          ctx.print('Usage: /tasks fail <taskId> <error...>');
          return;
        }
        ctx.taskManager.failTask(taskId, { error: errorText });
        ctx.print(`Failed task ${taskId}.`);
        return;
      }

      const taskId = args[1];
      const note = args.slice(2).join(' ').trim() || undefined;
      if (!taskId) {
        ctx.print(`Usage: /tasks ${subcommand} <taskId> [note]`);
        return;
      }
      if (!ctx.opsControlPlane) {
        ctx.print('Ops control plane is not available for task interventions in this runtime.');
        return;
      }
      try {
        switch (subcommand) {
          case 'cancel':
            ctx.opsControlPlane.cancelTask(taskId, note);
            ctx.print(`Cancelled task ${taskId}.`);
            return;
          case 'pause':
            ctx.opsControlPlane.pauseTask(taskId, note);
            ctx.print(`Paused task ${taskId}.`);
            return;
          case 'resume':
            ctx.opsControlPlane.resumeTask(taskId, note);
            ctx.print(`Resumed task ${taskId}.`);
            return;
          case 'retry':
            ctx.opsControlPlane.retryTask(taskId, note);
            ctx.print(`Re-queued task ${taskId}.`);
            return;
          default:
            ctx.print(`Unknown tasks subcommand: ${subcommand}`);
            return;
        }
      } catch (error) {
        ctx.print(error instanceof Error ? error.message : String(error));
      }
    },
  });

  registry.register({
    name: 'danger',
    argsHint: '[key] [value]',
    description: '⚠ Danger zone settings (agent recursion, daemon, HTTP listener)',
    usage: '[key] [value]',
    handler(args, ctx) {
      if (args.length === 0) {
        if (ctx.openSelection) {
          const cm = ctx.configManager;
          const dangerObj = cm.getAll().danger as Record<string, unknown>;
          const toggleAction = new Map<string, import('../selection-modal.ts').SelectionAction>([['enter', 'toggle' as const]]);
          const items: SelectionItem[] = Object.entries(dangerObj).map(([field, val]) => {
            const key = `danger.${field}`;
            const schema = CONFIG_SCHEMA.find(s => s.key === key);
            return { id: key, label: key, detail: String(val), fg: '#ef4444', actions: schema ? `[Enter] toggle  ${schema.description}` : undefined };
          });
          ctx.openSelection('⚠ Danger Zone', items, { allowSearch: false, customActions: toggleAction }, (result) => {
            if (!result) return;
            const key = result.item.id as ConfigKey;
            const schema = CONFIG_SCHEMA.find(s => s.key === key);
            if (result.action === 'toggle' && schema) {
              const currentVal = cm.get(key);
              let newVal: unknown = currentVal;
              if (schema.type === 'boolean') {
                newVal = !currentVal;
                cm.setDynamic(key, newVal);
              } else if (schema.type === 'number') {
                ctx.print(`Current: ${key} = ${String(currentVal)}. Use /danger ${key.replace('danger.', '')} <value> to set.`);
                return;
              }
              result.item.detail = String(newVal);
              ctx.renderRequest();
            }
          });
        } else {
          const dangerObj = ctx.configManager.getAll().danger as Record<string, unknown>;
          ctx.print(['⚠ Danger Zone Settings:', '', ...Object.entries(dangerObj).map(([field, val]) => `  ${`danger.${field}`.padEnd(36)} ${String(val)}`)].join('\n'));
        }
        return;
      }
      const key = args[0].startsWith('danger.') ? args[0] : `danger.${args[0]}`;
      if (args.length === 1) {
        try {
          ctx.print(`${key} = ${String(ctx.configManager.get(key as Parameters<typeof ctx.configManager.get>[0]))}`);
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
        return;
      }
      try {
        const schema = CONFIG_SCHEMA.find(s => s.key === key);
        if (!schema) {
          ctx.print(`Unknown danger key: ${key}`);
          return;
        }
        const rawValue = args.slice(1).join(' ');
        const coerced: unknown = schema.type === 'boolean' ? (rawValue === 'true' || rawValue === '1' || rawValue === 'yes') : schema.type === 'number' ? Number(rawValue) : rawValue;
        ctx.configManager.setDynamic(key as Parameters<typeof ctx.configManager.get>[0], coerced);
        ctx.print(`⚠ Set ${key} = ${String(coerced)}`);
      } catch (e) {
        ctx.print(`Error: ${(e as Error).message}`);
      }
    },
  });

  registry.register({
    name: 'image',
    aliases: ['img'],
    description: 'Attach an image file to the next message',
    usage: '<path> [prompt text]',
    argsHint: '<path> [prompt]',
    async handler(args, ctx) {
      if (args.length === 0) {
        ctx.print('Usage: /image <path> [prompt text]\nSupported formats: PNG, JPEG, WebP, GIF');
        return;
      }
      const rawPath = args[0];
      const promptText = args.slice(1).join(' ') || `Attached image: ${rawPath.split('/').pop() ?? rawPath}`;
      let resolvedPath: string;
      try {
        resolvedPath = resolveAndValidatePath(rawPath);
      } catch (err) {
        ctx.print(`Error: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (!existsSync(resolvedPath)) {
        ctx.print(`File not found: ${rawPath}`);
        return;
      }
      const ext = resolvedPath.slice(resolvedPath.lastIndexOf('.')).toLowerCase();
      const mediaType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' } as Record<string, string>)[ext];
      if (!mediaType) {
        ctx.print(`Unsupported image format: ${ext}\nSupported: .png, .jpg, .jpeg, .webp, .gif`);
        return;
      }
      const stat = statSync(resolvedPath);
      if (stat.size > 20 * 1024 * 1024) {
        ctx.print(`Image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Maximum: 20MB`);
        return;
      }
      let data: string;
      try {
        data = (await readFile(resolvedPath)).toString('base64');
      } catch (err) {
        ctx.print(`Failed to read image: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const currentModel = ctx.providerRegistry.getCurrentModel();
      if (!currentModel.capabilities.multimodal) {
        ctx.print(`Warning: ${currentModel.displayName} does not support image input. The image will be stripped when sending.`);
      }
      const content: ContentPart[] = [{ type: 'text', text: promptText }, { type: 'image', data, mediaType }];
      ctx.submitInput?.(promptText, content);
    },
  });

  registry.register({
    name: 'refresh-models',
    description: 'Refresh model catalog, benchmarks, and token limits',
    async handler(_args, ctx) {
      let catalogOk = false;
      let benchmarksOk = false;
      let limitsOk = false;
      ctx.print('Refreshing model catalog...');
      try {
        const { refreshCatalog, getCatalogModelDefinitions } = await import('../../providers/model-catalog.ts');
        await refreshCatalog();
        catalogOk = true;
        const models = getCatalogModelDefinitions();
        ctx.print(`Model catalog refreshed: ${models.length} models from ${new Set(models.map((m) => m.provider)).size} providers`);
      } catch (e) {
        ctx.print(`Catalog refresh failed: ${(e as Error).message}`);
      }
      ctx.print('Refreshing benchmarks...');
      try {
        const { refreshBenchmarks } = await import('../../providers/model-benchmarks.ts');
        await refreshBenchmarks();
        benchmarksOk = true;
        ctx.print('Benchmarks refreshed.');
      } catch (e) {
        ctx.print(`Benchmarks refresh failed: ${(e as Error).message}`);
      }
      ctx.print('Refreshing token limits...');
      try {
        const { refreshModelLimits } = await import('../../providers/model-limits.ts');
        const count = await refreshModelLimits();
        limitsOk = true;
        ctx.print(`Token limits refreshed: ${count} models updated.`);
      } catch (e) {
        ctx.print(`Token limits refresh failed: ${(e as Error).message}`);
      }
      if (!catalogOk || !benchmarksOk || !limitsOk) ctx.print('Some refreshes failed — see messages above.');
    },
  });

  registry.register({
    name: 'pin',
    description: 'Pin a model to the favorites list',
    usage: '<model-id>',
    argsHint: '<model-id>',
    async handler(args, ctx) {
      const modelId = args[0];
      if (!modelId) {
        const pinned = await getPinned();
        ctx.print(pinned.length === 0 ? 'No pinned models. Use /pin <model-id> to pin one.' : `Pinned models:\n${pinned.map(id => `  ★ ${id}`).join('\n')}`);
        return;
      }
      if (await isModelPinned(modelId)) {
        ctx.print(`Model already pinned: ${modelId}`);
        return;
      }
      await pinModel(modelId);
      ctx.print(`Pinned: ${modelId}`);
    },
  });

  registry.register({
    name: 'unpin',
    description: 'Unpin a model from the favorites list',
    usage: '<model-id>',
    argsHint: '<model-id>',
    async handler(args, ctx) {
      const modelId = args[0];
      if (!modelId) {
        ctx.print('Usage: /unpin <model-id>');
        return;
      }
      if (!await isModelPinned(modelId)) {
        ctx.print(`Model is not pinned: ${modelId}`);
        return;
      }
      await unpinModel(modelId);
      ctx.print(`Unpinned: ${modelId}`);
    },
  });
}
