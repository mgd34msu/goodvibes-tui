import { resolve } from 'node:path';
import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import { AGENT_TEMPLATES } from '@pellux/goodvibes-sdk/platform/tools';
import { handleRemoteSetupCommand } from './remote-runtime-setup.ts';
import { handleRemotePoolCommand } from './remote-runtime-pool.ts';
import { requireAgentManager, requireAcpManager, requirePeerClient, requireShellPaths } from './runtime-services.ts';

type RemoteConnectionLike = { agentId: string };
type RemoteCancelContext = Pick<CommandContext, 'print'>;
type RemoteCancelAgentManager = Pick<ReturnType<typeof requireAgentManager>, 'cancel'>;
type RemoteCancelAcpManager = Pick<ReturnType<typeof requireAcpManager>, 'cancel'>;

export function handleRemoteCancelCommand(
  agentId: string | undefined,
  activeConnections: RemoteConnectionLike[],
  ctx: RemoteCancelContext,
  agentManager: RemoteCancelAgentManager,
  acpManager?: RemoteCancelAcpManager,
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
  if (!acpManager) {
    ctx.print(`Remote agent ${agentId} could not be cancelled in this runtime.`);
    return;
  }
  void acpManager.cancel(agentId);
  ctx.print(`Cancellation requested for remote runner ${agentId}.`);
}

export function registerRemoteRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'remote',
    aliases: [],
    description: 'Inspect, dispatch, and review self-hosted remote runners and artifacts',
    usage: '[list | show [agentId] | supervisor [runnerId] | capabilities [runnerId] | recover [runnerId] | setup [export <path>] | env [export <path>] | tunnel [review|export <path>] | bootstrap [export <path>|inspect <path>] | session <export|inspect|import> <path> | pool <list|show|create|assign|unassign> ... | dispatch [template] <description> | dispatch-pool <pool> [template] <description> | contract [agentId] | cancel <agentId> | export <agentId> [path] | artifact list | artifact show <id> | artifact export <id> [path] | review <id> | rerun-local <id> | import <path>]',
    async handler(args, ctx) {
      if (args.length === 0) {
        if (ctx.openModal) {
          ctx.openModal('remote-modal'); // remote panel -> config modal
          return;
        }
        ctx.print('Remote surface is not available in this runtime.');
        return;
      }

      let peerClient;
      try {
        peerClient = requirePeerClient(ctx);
      } catch {
        ctx.print('Remote runtime services are not available in this runtime.');
        return;
      }
      const peerSnapshot = peerClient.getSnapshot();
      const remoteRunners = peerClient.runners;
      const activeConnections = [...peerSnapshot.acp.activeConnections];
      const subcommand = args[0]?.toLowerCase() ?? 'show';

      if (await handleRemoteSetupCommand(args, ctx, activeConnections, {
        listContracts: () => remoteRunners.listContracts(),
        exportSessionBundle: (path) => remoteRunners.exportSessionBundle(path),
        importSessionBundle: (path) => remoteRunners.importSessionBundle(path),
      })) {
        return;
      }

      if (subcommand === 'list') {
        const supervisor = peerSnapshot.supervisor;
        const contracts = peerSnapshot.runners.contracts;
        const pools = peerSnapshot.runners.pools;
        const artifacts = peerSnapshot.runners.artifacts;
        const lines = [
          'Remote Control Surface',
          `  active connections: ${activeConnections.length}`,
          `  runner contracts: ${contracts.length}`,
          `  runner pools: ${pools.length}`,
          `  review artifacts: ${artifacts.length}`,
          `  supervisor sessions: ${supervisor.sessions.length}`,
          `  degraded sessions: ${supervisor.degradedConnections}`,
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

      if (subcommand === 'supervisor') {
        const snapshot = peerSnapshot.supervisor;
        const runnerId = args[1];
        const selected = runnerId
          ? snapshot.sessions.find((entry) => entry.runnerId === runnerId)
          : snapshot.sessions[0];
        if (!selected) {
          ctx.print(runnerId ? `Unknown remote supervisor session: ${runnerId}` : 'No remote supervisor sessions are currently tracked.');
          return;
        }
        ctx.print([
          `Remote Supervisor ${selected.runnerId}`,
          `  label: ${selected.label}`,
          `  transport: ${selected.transportState}`,
          `  heartbeat: ${selected.heartbeat.status}`,
          `  heartbeat detail: ${selected.heartbeat.detail}`,
          `  executionProtocol: ${selected.negotiation.executionProtocol}`,
          `  reviewMode: ${selected.negotiation.reviewMode}`,
          `  communicationLane: ${selected.negotiation.communicationLane}`,
          `  trustClass: ${selected.negotiation.trustClass}`,
          `  taskId: ${selected.taskId ?? 'n/a'}`,
          `  messageCount: ${selected.messageCount}`,
          `  errorCount: ${selected.errorCount}`,
          ...(selected.lastError ? [`  lastError: ${selected.lastError}`] : []),
          '  capabilities:',
          ...selected.capabilities.map((capability) => `    ${capability.id}: ${capability.supported ? 'yes' : 'no'} (${capability.detail})`),
          '  recovery:',
          ...selected.recovery.map((action) => `    ${action.command} — ${action.reason}`),
        ].join('\n'));
        return;
      }

      if (subcommand === 'capabilities') {
        const snapshot = peerSnapshot.supervisor;
        const runnerId = args[1];
        const selected = runnerId
          ? snapshot.sessions.find((entry) => entry.runnerId === runnerId)
          : snapshot.sessions[0];
        if (!selected) {
          ctx.print(runnerId ? `Unknown remote runner: ${runnerId}` : 'No remote supervisor sessions are currently tracked.');
          return;
        }
        ctx.print([
          `Remote Capabilities ${selected.runnerId}`,
          `  label: ${selected.label}`,
          `  transport: ${selected.transportState}`,
          `  executionProtocol: ${selected.negotiation.executionProtocol}`,
          `  reviewMode: ${selected.negotiation.reviewMode}`,
          `  communicationLane: ${selected.negotiation.communicationLane}`,
          `  trustClass: ${selected.negotiation.trustClass}`,
          '  capabilities:',
          ...selected.capabilities.map((capability) => (
            `    ${capability.id}: ${capability.supported ? 'supported' : 'missing'} — ${capability.detail}`
          )),
        ].join('\n'));
        return;
      }

      if (subcommand === 'recover') {
        const snapshot = peerSnapshot.supervisor;
        const runnerId = args[1];
        const selected = runnerId
          ? snapshot.sessions.find((entry) => entry.runnerId === runnerId)
          : snapshot.sessions.find((entry) => entry.recovery.length > 0) ?? snapshot.sessions[0];
        if (!selected) {
          ctx.print(runnerId ? `Unknown remote runner: ${runnerId}` : 'No remote supervisor sessions are currently tracked.');
          return;
        }
        const nextSteps = selected.recovery.length > 0
          ? selected.recovery
          : [{
              id: 'show',
              label: 'Review remote runtime',
              command: `/remote show ${selected.runnerId}`,
              reason: 'Inspect the current remote session before deciding on recovery.',
            }];
        ctx.print([
          `Remote Recovery ${selected.runnerId}`,
          `  label: ${selected.label}`,
          `  transport: ${selected.transportState}`,
          `  heartbeat: ${selected.heartbeat.status}`,
          `  detail: ${selected.heartbeat.detail}`,
          ...(selected.lastError ? [`  lastError: ${selected.lastError}`] : []),
          ...(selected.taskId ? [`  bound task: ${selected.taskId}`] : []),
          '  actions:',
          ...nextSteps.map((action) => `    ${action.command} — ${action.reason}`),
        ].join('\n'));
        return;
      }

      if (handleRemotePoolCommand(args, ctx, remoteRunners)) {
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
        const contract = remoteRunners.upsertContractForAgent(connection.agentId);
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
        if (!ctx.ops.acpManager) {
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
        const workingDirectory = requireShellPaths(ctx).workingDirectory;
        const runnerId = await ctx.ops.acpManager.spawn({
          description,
          context: `Self-hosted remote runner dispatched from session ${ctx.session.runtime.sessionId}. Follow ${template} discipline and return concise evidence.`,
          tools: [...templateDef.defaultTools],
          workingDirectory,
        });
        const now = Date.now();
        remoteRunners.registerContract({
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
        if (!ctx.ops.acpManager) {
          ctx.print('ACP manager is not available for remote dispatch in this runtime.');
          return;
        }
        const poolId = args[1];
        if (!poolId) {
          ctx.print('Usage: /remote dispatch-pool <pool> [template] <description>');
          return;
        }
        const pool = remoteRunners.getPool(poolId);
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
        const workingDirectory = requireShellPaths(ctx).workingDirectory;
        const runnerId = await ctx.ops.acpManager.spawn({
          description,
          context: `Self-hosted remote runner dispatched from session ${ctx.session.runtime.sessionId} via pool ${poolId}. Follow ${template} discipline and return concise evidence.`,
          tools: [...templateDef.defaultTools],
          workingDirectory,
        });
        const now = Date.now();
        remoteRunners.registerContract({
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
        remoteRunners.assignRunnerToPool(poolId, runnerId);
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
        const contract = remoteRunners.upsertContractForAgent(agentId);
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
        if (!ctx.ops.agentManager) {
          ctx.print('Agent manager is not available in this runtime.');
          return;
        }
        handleRemoteCancelCommand(
          args[1],
          activeConnections,
          ctx,
          requireAgentManager(ctx),
          ctx.ops.acpManager ? requireAcpManager(ctx) : undefined,
        );
        return;
      }

      if (subcommand === 'export') {
        const agentId = args[1];
        if (!agentId) {
          ctx.print('Usage: /remote export <agentId> [path]');
          return;
        }
        const artifact = remoteRunners.captureArtifactForRunner(agentId);
        if (!artifact) {
          ctx.print(`Remote artifact export failed for ${agentId}.`);
          return;
        }
        const exported = await remoteRunners.exportArtifact(artifact.id, args[2]);
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
          const artifacts = remoteRunners.listArtifacts();
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
          const summary = remoteRunners.buildReviewSummary(artifactId);
          ctx.print(summary ?? `Unknown remote artifact: ${artifactId}`);
          return;
        }
        if (mode === 'export') {
          const artifactId = args[2];
          if (!artifactId) {
            ctx.print('Usage: /remote artifact export <artifactId> [path]');
            return;
          }
          const exported = await remoteRunners.exportArtifact(artifactId, args[3]);
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
        const summary = remoteRunners.buildReviewSummary(artifactId);
        ctx.print(summary ?? `Unknown remote artifact: ${artifactId}`);
        return;
      }

      if (subcommand === 'rerun-local') {
        const artifactId = args[1];
        if (!artifactId) {
          ctx.print('Usage: /remote rerun-local <artifactId>');
          return;
        }
        const artifact = remoteRunners.getArtifact(artifactId);
        if (!artifact) {
          ctx.print(`Unknown remote artifact: ${artifactId}`);
          return;
        }
        const template = artifact.runnerContract.template in AGENT_TEMPLATES
          ? artifact.runnerContract.template
          : 'general';
        const agentManager = ctx.ops.agentManager;
        if (!agentManager) {
          ctx.print('Agent manager is not available in this runtime.');
          return;
        }
        const agent = agentManager.spawn({
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
        const artifact = await remoteRunners.importArtifact(path);
        ctx.print(`Imported remote review artifact ${artifact.id} for runner ${artifact.runnerId}.`);
        return;
      }

      ctx.print(`Unknown remote subcommand: ${subcommand}`);
    },
  });
}
