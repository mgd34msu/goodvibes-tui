import type { CommandRegistry } from '../command-registry.ts';
import { getOperatorRpc, describeOperatorRpcError } from './operator-rpc.ts';
import { renderWorkstreamGraphLines } from '../../panels/workstream-graph-render.ts';

// ---------------------------------------------------------------------------
// /graph — a workstream's task graph (fleet.graph.get) rendered legibly.
//
// The observability-layer surface: nodes, edges, per-node states (ready /
// running / blocked-with-"waiting on: X" / stalled / orphaned) and the elastic
// pool posture ("N ready, M running, at cap (fleet.maxSize=N)") — the shape of
// the dependency graph WITHOUT opening any transcript. The fix-phase chain's
// task graph is one such workstream.
// ---------------------------------------------------------------------------

function renderWidth(): number {
  const cols = typeof process !== 'undefined' && process.stdout && process.stdout.columns ? process.stdout.columns : 80;
  return Math.max(40, cols - 2);
}

export function registerGraphRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'graph',
    description: "Show a workstream's task graph — nodes, edges, states, and pool posture",
    usage: '<workstreamId>',
    argsHint: '<workstreamId>',
    async handler(args, ctx) {
      const workstreamId = (args[0] ?? '').trim();
      if (!workstreamId) {
        ctx.print('Usage: /graph <workstreamId>  — renders that workstream\'s task graph (nodes, edges, states, pool).');
        return;
      }
      const rpc = getOperatorRpc(ctx);
      if (!rpc.available) {
        ctx.print(`[graph] ${rpc.reason}`);
        return;
      }
      try {
        const snapshot = await rpc.sdk.operator.invoke('fleet.graph.get', { workstreamId });
        ctx.print(renderWorkstreamGraphLines(snapshot, renderWidth()).join('\n'));
      } catch (error) {
        ctx.print(`[graph] ${describeOperatorRpcError(error)}`);
      }
    },
  });
}
