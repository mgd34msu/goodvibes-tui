import type { CommandRegistry } from '../command-registry.ts';
import { AgentManager } from '../../tools/agent/index.ts';
import { getTokenAuditor } from '../../security/token-audit.ts';
import { buildMcpAttackPathReview } from '../../runtime/mcp/index.ts';
import { getPolicyRuntimeState } from '../../runtime/permissions/policy-runtime.ts';
import { pluginManager } from '../../plugins/manager.ts';
import { buildKnowledgeInjectionPrompt, selectKnowledgeForTask } from '../../state/knowledge-injection.ts';
import { getSubscriptionManager } from '../../config/subscriptions.ts';
import { listBuiltinSubscriptionProviders } from '../../config/subscription-providers.ts';

export function registerControlRoomRuntimeCommands(registry: CommandRegistry): void {
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
      const subscriptions = getSubscriptionManager();
      const builtinProviders = listBuiltinSubscriptionProviders();
      ctx.print([
        'Security Review',
        `  tokens: ${audit.results.length}`,
        `  blocked tokens: ${audit.blocked.length}`,
        `  scope violations: ${audit.scopeViolations.length}`,
        `  rotation overdue: ${audit.rotationOverdue.length}`,
        `  rotation warnings: ${audit.rotationWarnings.length}`,
        `  built-in subscription providers: ${builtinProviders.length}`,
        `  active subscriptions: ${subscriptions.list().length}`,
        `  pending subscriptions: ${subscriptions.listPending().length}`,
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
      ctx.print(`Unknown knowledge subcommand: ${subcommand}`);
    },
  });
}
