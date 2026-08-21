// ---------------------------------------------------------------------------
// acp-runtime.ts, the scripted path for hosting third-party coding agents,
// over the SAME verbs the Fleet panel's spawn affordance drives (acp.agents.list
// / acp.sessions.create). `/agents list` shows what the daemon discovered
// (read-only, quiet when none); `/agents host <agentId> [dir]` spawns one as a
// long-lived daemon session that shows up as an acp-agent fleet row. A working
// directory defaults to the current one; a known workspace root can be named
// instead, but no path is ever required beyond what the operator already has.
//
// A structured spawn failure ({binary, stage, message}) is printed verbatim,
// never left as a hung row: the daemon bounds the handshake and returns a
// 'failed' record with its three honest fields.
// ---------------------------------------------------------------------------

import type { CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';
import { describeOperatorRpcError, getOperatorRpc } from './operator-rpc.ts';

export function registerAcpRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'agents',
    aliases: ['acp'],
    description: 'Host third-party coding agents (Claude Code, Codex, opencode) as fleet rows over ACP',
    usage: 'list | host <agentId> [directory]',
    argsHint: '[list|host]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'list').toLowerCase();
      const rpc = getOperatorRpc(ctx);
      if (!rpc.available) { ctx.print(`[agents] ${rpc.reason}`); return; }

      if (sub === 'list') {
        try {
          const { agents } = await rpc.sdk.operator.invoke('acp.agents.list', {});
          if (agents.length === 0) {
            ctx.print('[agents] No third-party ACP agents discovered. Install Claude Code, Codex, or opencode on PATH to host one.');
            return;
          }
          ctx.print([
            'Discovered ACP agents (host with /agents host <id> [directory]):',
            ...agents.map((a) => `  ${a.id}: ${a.title}  (${a.binaryPath})`),
          ].join('\n'));
        } catch (error) {
          ctx.print(`[agents list] ${describeOperatorRpcError(error)}`);
        }
        return;
      }

      if (sub === 'host') {
        const agentId = args[1];
        if (!agentId) {
          ctx.print('Usage: /agents host <agentId> [directory]  (agentId from /agents list; directory defaults to the current one)');
          return;
        }
        const cwd = args[2] ?? requireShellPaths(ctx).workingDirectory;
        try {
          const { hosted, started } = await rpc.sdk.operator.invoke('acp.sessions.create', { agentId, cwd });
          if (hosted.error) {
            // Structured failure, verbatim, never a hung row.
            ctx.print(`[agents host] Could not host ${hosted.title || agentId}: ${hosted.error.stage} stage failed for ${hosted.error.binary}; ${hosted.error.message}`);
            return;
          }
          ctx.print(`[agents host] Hosting ${hosted.title || agentId} in ${cwd}${started ? '' : ' (queued)'}; it appears as an acp-agent row in the fleet; steer and stop it like any agent.`);
        } catch (error) {
          ctx.print(`[agents host] ${describeOperatorRpcError(error)}`);
        }
        return;
      }

      ctx.print('Usage: /agents list | /agents host <agentId> [directory]');
    },
  });
}
