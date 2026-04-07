import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CommandRegistry } from '../command-registry.ts';
import { getSecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '../../config/service-registry.ts';
import { pluginManager } from '../../plugins/manager.ts';
import { listInstalledEcosystemEntries, loadEcosystemCatalog } from '../../runtime/ecosystem/catalog.ts';
import {
  getRemoteRunnerRegistry,
  importRemoteArtifact,
} from '../../runtime/remote/runner-registry.ts';
import { BUILTIN_SUITES } from '../../runtime/eval/suites.ts';

interface TrustReviewBundle {
  readonly version: 1;
  readonly capturedAt: number;
  readonly permissionMode: string;
  readonly secretKeys: readonly string[];
  readonly serviceNames: readonly string[];
  readonly pluginSummary: {
    readonly total: number;
    readonly trusted: number;
    readonly limited: number;
    readonly untrusted: number;
    readonly quarantined: number;
  };
  readonly mcpSummary: {
    readonly total: number;
    readonly constrained: number;
    readonly askOnRisk: number;
    readonly allowAll: number;
    readonly blocked: number;
    readonly quarantined: number;
  };
}

interface ReleaseBundle {
  readonly version: 1;
  readonly capturedAt: number;
  readonly runtime: {
    readonly provider: string;
    readonly model: string;
    readonly sessionId: string;
  };
  readonly evalSuites: readonly string[];
  readonly incidentCount: number;
  readonly remote: {
    readonly pools: number;
    readonly contracts: number;
    readonly artifacts: number;
  };
  readonly ecosystem: {
    readonly pluginCatalog: number;
    readonly skillCatalog: number;
    readonly installedPlugins: number;
    readonly installedSkills: number;
  };
}

let serviceRegistrySingleton: ServiceRegistry | null = null;

function getServiceRegistry(): ServiceRegistry {
  if (!serviceRegistrySingleton) {
    serviceRegistrySingleton = new ServiceRegistry();
  }
  return serviceRegistrySingleton;
}

function countByMode<T extends string>(values: readonly T[], mode: T): number {
  return values.filter((value) => value === mode).length;
}

function buildTrustReviewBundle(ctx: Parameters<NonNullable<CommandRegistry['register']>>[0]['handler'] extends (args: string[], context: infer C) => unknown ? C : never): Promise<TrustReviewBundle> {
  return (async () => {
    const secretKeys = await getSecretsManager().list();
    const services = Object.keys(getServiceRegistry().getAll()).sort((a, b) => a.localeCompare(b));
    const plugins = pluginManager.list();
    const mcpServers = [...(ctx.runtimeStore?.getState().mcp.servers.values() ?? [])];
    return {
      version: 1,
      capturedAt: Date.now(),
      permissionMode: String(ctx.configManager.get('permissions.mode')),
      secretKeys,
      serviceNames: services,
      pluginSummary: {
        total: plugins.length,
        trusted: plugins.filter((plugin) => plugin.trustTier === 'trusted').length,
        limited: plugins.filter((plugin) => plugin.trustTier === 'limited').length,
        untrusted: plugins.filter((plugin) => plugin.trustTier === 'untrusted').length,
        quarantined: plugins.filter((plugin) => plugin.quarantined).length,
      },
      mcpSummary: {
        total: mcpServers.length,
        constrained: countByMode(mcpServers.map((server) => server.trustMode), 'constrained'),
        askOnRisk: countByMode(mcpServers.map((server) => server.trustMode), 'ask-on-risk'),
        allowAll: countByMode(mcpServers.map((server) => server.trustMode), 'allow-all'),
        blocked: countByMode(mcpServers.map((server) => server.trustMode), 'blocked'),
        quarantined: mcpServers.filter((server) => server.schemaFreshness === 'quarantined').length,
      },
    };
  })();
}

function formatTrustReview(bundle: TrustReviewBundle): string {
  return [
    'Trust Review',
    `  permission mode: ${bundle.permissionMode}`,
    `  secrets stored: ${bundle.secretKeys.length}`,
    `  configured services: ${bundle.serviceNames.length}`,
    `  plugins: ${bundle.pluginSummary.total} (trusted ${bundle.pluginSummary.trusted}, limited ${bundle.pluginSummary.limited}, untrusted ${bundle.pluginSummary.untrusted}, quarantined ${bundle.pluginSummary.quarantined})`,
    `  MCP servers: ${bundle.mcpSummary.total} (constrained ${bundle.mcpSummary.constrained}, ask-on-risk ${bundle.mcpSummary.askOnRisk}, allow-all ${bundle.mcpSummary.allowAll}, blocked ${bundle.mcpSummary.blocked}, quarantined ${bundle.mcpSummary.quarantined})`,
  ].join('\n');
}

function inspectTrustBundle(path: string): string {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as TrustReviewBundle;
  return [
    'Trust Bundle Review',
    `  captured: ${new Date(parsed.capturedAt).toISOString()}`,
    `  permission mode: ${parsed.permissionMode}`,
    `  secrets stored: ${parsed.secretKeys.length}`,
    `  configured services: ${parsed.serviceNames.length}`,
    `  plugins: ${parsed.pluginSummary.total}`,
    `  MCP servers: ${parsed.mcpSummary.total}`,
  ].join('\n');
}

function buildReleaseBundle(ctx: Parameters<NonNullable<CommandRegistry['register']>>[0]['handler'] extends (args: string[], context: infer C) => unknown ? C : never): ReleaseBundle {
  const remoteRegistry = getRemoteRunnerRegistry();
  const incidents = ctx.forensicsRegistry?.getAll() ?? [];
  return {
    version: 1,
    capturedAt: Date.now(),
    runtime: {
      provider: ctx.runtime.provider,
      model: ctx.runtime.model,
      sessionId: ctx.runtime.sessionId,
    },
    evalSuites: Object.keys(BUILTIN_SUITES),
    incidentCount: incidents.length,
    remote: {
      pools: remoteRegistry.listPools().length,
      contracts: remoteRegistry.listContracts().length,
      artifacts: remoteRegistry.listArtifacts().length,
    },
    ecosystem: {
      pluginCatalog: loadEcosystemCatalog('plugin').length,
      skillCatalog: loadEcosystemCatalog('skill').length,
      installedPlugins: listInstalledEcosystemEntries('plugin').length,
      installedSkills: listInstalledEcosystemEntries('skill').length,
    },
  };
}

function inspectReleaseBundle(path: string): string {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ReleaseBundle;
  return [
    'Release Bundle Review',
    `  provider/model: ${parsed.runtime.provider || '(unset)'}/${parsed.runtime.model || '(unset)'}`,
    `  eval suites: ${parsed.evalSuites.length}`,
    `  incidents: ${parsed.incidentCount}`,
    `  remote pools/contracts/artifacts: ${parsed.remote.pools}/${parsed.remote.contracts}/${parsed.remote.artifacts}`,
    `  ecosystem catalog plugins/skills: ${parsed.ecosystem.pluginCatalog}/${parsed.ecosystem.skillCatalog}`,
  ].join('\n');
}

export function registerProductRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'trust',
    description: 'Review trust posture and export portable trust bundles',
    usage: '[review|bundle export <path>|bundle inspect <path>]',
    async handler(args, ctx) {
      const sub = args[0] ?? 'review';
      if (sub === 'review') {
        const bundle = await buildTrustReviewBundle(ctx);
        ctx.print(formatTrustReview(bundle));
        return;
      }
      if (sub === 'bundle') {
        const mode = args[1];
        const pathArg = args[2];
        if ((mode === 'export' || mode === 'inspect') && !pathArg) {
          ctx.print(`Usage: /trust bundle ${mode} <path>`);
          return;
        }
        if (mode === 'export') {
          const bundle = await buildTrustReviewBundle(ctx);
          const targetPath = resolve(process.cwd(), pathArg!);
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
          ctx.print(`Trust bundle exported to ${targetPath}`);
          return;
        }
        if (mode === 'inspect') {
          ctx.print(inspectTrustBundle(resolve(process.cwd(), pathArg!)));
          return;
        }
      }
      ctx.print('Usage: /trust [review|bundle export <path>|bundle inspect <path>]');
    },
  });
  registry.register({
    name: 'bridge',
    description: 'Review and operate self-hosted bridge and remote runner flows',
    usage: '[status|pools|assign <pool> <runner>|runner <id>|review <artifactId>|export <artifactId> [path]|import <path>]',
    async handler(args, ctx) {
      const remoteRegistry = getRemoteRunnerRegistry();
      const sub = args[0] ?? 'status';
      if (sub === 'status') {
        remoteRegistry.ensureContractsFromStore(ctx.runtimeStore);
        ctx.print([
          'Bridge Status',
          `  remote pools: ${remoteRegistry.listPools().length}`,
          `  runner contracts: ${remoteRegistry.listContracts().length}`,
          `  review artifacts: ${remoteRegistry.listArtifacts().length}`,
        ].join('\n'));
        return;
      }
      if (sub === 'pools') {
        const pools = remoteRegistry.listPools();
        ctx.print(pools.length > 0
          ? ['Bridge Pools', ...pools.map((pool) => `  ${pool.id}  runners=${pool.runnerIds.length}  trust=${pool.trustClass}`)].join('\n')
          : 'Bridge Pools\n  No runner pools registered yet.');
        return;
      }
      if (sub === 'assign') {
        const poolId = args[1];
        const runnerId = args[2];
        if (!poolId || !runnerId) {
          ctx.print('Usage: /bridge assign <pool> <runner>');
          return;
        }
        const pool = remoteRegistry.assignRunnerToPool(poolId, runnerId);
        if (!pool) {
          ctx.print(`Unable to assign runner ${runnerId} to pool ${poolId}.`);
          return;
        }
        ctx.print(`Assigned runner ${runnerId} to bridge pool ${poolId}.`);
        return;
      }
      if (sub === 'runner') {
        const runnerId = args[1];
        if (!runnerId) {
          ctx.print('Usage: /bridge runner <id>');
          return;
        }
        const contract = remoteRegistry.getContract(runnerId);
        if (!contract) {
          ctx.print(`Unknown runner contract: ${runnerId}`);
          return;
        }
        ctx.print([
          `Bridge Runner ${runnerId}`,
          `  template: ${contract.template}`,
          `  trustClass: ${contract.trustClass}`,
          `  transport: ${contract.sourceTransport}/${contract.transport.state}`,
          `  tools: ${contract.capabilityCeiling.allowedTools.join(', ') || '(none)'}`,
          `  pool: ${contract.poolId ?? '(unassigned)'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'review') {
        const artifactId = args[1];
        if (!artifactId) {
          ctx.print('Usage: /bridge review <artifactId>');
          return;
        }
        const summary = remoteRegistry.buildReviewSummary(artifactId);
        ctx.print(summary ?? `Unknown remote artifact: ${artifactId}`);
        return;
      }
      if (sub === 'export') {
        const artifactId = args[1];
        if (!artifactId) {
          ctx.print('Usage: /bridge export <artifactId> [path]');
          return;
        }
        const exported = await remoteRegistry.exportArtifact(artifactId, args[2] ? resolve(process.cwd(), args[2]) : undefined);
        if (!exported) {
          ctx.print(`Unknown remote artifact: ${artifactId}`);
          return;
        }
        ctx.print(`Exported remote bridge artifact to ${exported.path}`);
        return;
      }
      if (sub === 'import') {
        const pathArg = args[1];
        if (!pathArg) {
          ctx.print('Usage: /bridge import <path>');
          return;
        }
        const artifact = await importRemoteArtifact(resolve(process.cwd(), pathArg));
        ctx.print(`Imported remote bridge artifact ${artifact.id} for runner ${artifact.runnerId}.`);
        return;
      }
      ctx.print('Usage: /bridge [status|pools|assign <pool> <runner>|runner <id>|review <artifactId>|export <artifactId> [path]|import <path>]');
    },
  });

  registry.register({
    name: 'release',
    description: 'Package certification and release-readiness operations',
    usage: '[review|checklist|bundle export <path>|bundle inspect <path>]',
    handler(args, ctx) {
      const sub = args[0] ?? 'review';
      if (sub === 'review') {
        const bundle = buildReleaseBundle(ctx);
        ctx.print([
          'Release Review',
          `  provider/model: ${bundle.runtime.provider || '(unset)'}/${bundle.runtime.model || '(unset)'}`,
          `  eval suites: ${bundle.evalSuites.length}`,
          `  incidents: ${bundle.incidentCount}`,
          `  remote pools/contracts/artifacts: ${bundle.remote.pools}/${bundle.remote.contracts}/${bundle.remote.artifacts}`,
          `  ecosystem catalog plugins/skills: ${bundle.ecosystem.pluginCatalog}/${bundle.ecosystem.skillCatalog}`,
          `  installed plugins/skills: ${bundle.ecosystem.installedPlugins}/${bundle.ecosystem.installedSkills}`,
        ].join('\n'));
        return;
      }
      if (sub === 'checklist') {
        ctx.print([
          'Release Checklist',
          '  1. Run /setup review and /setup doctor',
          '  2. Run /security review and /trust review',
          '  3. Run /policy preflight and /policy simulate',
          '  4. Run /eval gate <suite> for required certification suites',
          '  5. Review /incident latest and /bridge status',
          '  6. Export /release bundle export <path> for release evidence',
        ].join('\n'));
        return;
      }
      if (sub === 'bundle') {
        const mode = args[1];
        const pathArg = args[2];
        if ((mode === 'export' || mode === 'inspect') && !pathArg) {
          ctx.print(`Usage: /release bundle ${mode} <path>`);
          return;
        }
        if (mode === 'export') {
          const bundle = buildReleaseBundle(ctx);
          const targetPath = resolve(process.cwd(), pathArg!);
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
          ctx.print(`Release bundle exported to ${targetPath}`);
          return;
        }
        if (mode === 'inspect') {
          ctx.print(inspectReleaseBundle(resolve(process.cwd(), pathArg!)));
          return;
        }
      }
      ctx.print('Usage: /release [review|checklist|bundle export <path>|bundle inspect <path>]');
    },
  });
}
