import type { CommandRegistry } from '../command-registry.ts';

/** /status, everything the footer used to carry, in one report (shell/status-report.ts). */
export function registerStatusRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'status',
    aliases: [],
    description: 'Show session status: model, tools, token totals and cost, context use, surfaces and safety states',
    handler(_args, ctx) {
      ctx.print(ctx.describeStatus ? ctx.describeStatus() : 'Status is not available in this runtime.');
    },
  });
}
