import type { CommandContext } from '../command-registry.ts';

type RemotePoolLike = {
  id: string;
  label: string;
  trustClass: string;
  preferredTemplate?: string;
  maxRunners?: number;
  runnerIds: readonly string[];
  description?: string;
};

type RemoteRegistryLike = {
  listPools(): RemotePoolLike[];
  getPool(id: string): RemotePoolLike | null | undefined;
  createPool(input: { id: string; label: string }): RemotePoolLike;
  assignRunnerToPool(poolId: string, runnerId: string): RemotePoolLike | null | undefined;
  removeRunnerFromPool(poolId: string, runnerId: string): RemotePoolLike | null | undefined;
};

export function handleRemotePoolCommand(
  args: string[],
  ctx: Pick<CommandContext, 'print'>,
  remoteRegistry: RemoteRegistryLike,
): boolean {
  const subcommand = args[0]?.toLowerCase() ?? 'show';
  if (subcommand !== 'pool') return false;
  const mode = args[1]?.toLowerCase() ?? 'list';
  if (mode === 'list') {
    const pools = remoteRegistry.listPools();
    if (pools.length === 0) {
      ctx.print('No remote runner pools defined yet.');
      return true;
    }
    ctx.print([
      `Remote Runner Pools (${pools.length})`,
      ...pools.map((pool) => `  ${pool.id}  ${pool.runnerIds.length} runners  trust=${pool.trustClass}  template=${pool.preferredTemplate ?? '(none)'}`),
    ].join('\n'));
    return true;
  }
  if (mode === 'show') {
    const poolId = args[2];
    if (!poolId) {
      ctx.print('Usage: /remote pool show <poolId>');
      return true;
    }
    const pool = remoteRegistry.getPool(poolId);
    if (!pool) {
      ctx.print(`Unknown remote runner pool: ${poolId}`);
      return true;
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
    return true;
  }
  if (mode === 'create') {
    const poolId = args[2];
    if (!poolId) {
      ctx.print('Usage: /remote pool create <poolId> [label]');
      return true;
    }
    const label = args.slice(3).join(' ').trim() || poolId;
    const pool = remoteRegistry.createPool({ id: poolId, label });
    ctx.print(`Created remote runner pool ${pool.id} (${pool.label}).`);
    return true;
  }
  if (mode === 'assign') {
    const poolId = args[2];
    const runnerId = args[3];
    if (!poolId || !runnerId) {
      ctx.print('Usage: /remote pool assign <poolId> <runnerId>');
      return true;
    }
    const pool = remoteRegistry.assignRunnerToPool(poolId, runnerId);
    if (!pool) {
      ctx.print(`Could not assign ${runnerId} to pool ${poolId}.`);
      return true;
    }
    ctx.print(`Assigned remote runner ${runnerId} to pool ${poolId}.`);
    return true;
  }
  if (mode === 'unassign') {
    const poolId = args[2];
    const runnerId = args[3];
    if (!poolId || !runnerId) {
      ctx.print('Usage: /remote pool unassign <poolId> <runnerId>');
      return true;
    }
    const pool = remoteRegistry.removeRunnerFromPool(poolId, runnerId);
    if (!pool) {
      ctx.print(`Unknown remote runner pool: ${poolId}`);
      return true;
    }
    ctx.print(`Removed remote runner ${runnerId} from pool ${poolId}.`);
    return true;
  }
  ctx.print('Usage: /remote pool <list|show|create|assign|unassign> ...');
  return true;
}
