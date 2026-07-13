/**
 * ci-runtime.ts
 *
 * `/ci` — the CI-watch surface: a one-shot per-job status check (`ci.status`)
 * and standing watches (`ci.watches.*`) over the operator wire (see
 * operator-rpc.ts for why this goes over HTTP rather than the in-process
 * OperatorClient facade). The doctrine, verbatim from the operator contract's
 * `ci.status` description: "the overall verdict is derived from the per-job
 * conclusions (never a rollup); continue-on-error jobs are surfaced as
 * violations and force the verdict off 'passed'." `platform/ci-watch` (the
 * module implementing that doctrine server-side) is not in this SDK's public
 * export map yet, so the per-job rendering below is a thin, doctrine-faithful
 * mirror of the contract's own `ci.status`/`ci.watches.run` output — every job
 * name and conclusion listed individually, never summarized.
 */
import type { CommandRegistry } from '../command-registry.ts';
import { describeOperatorRpcError, getOperatorRpc } from './operator-rpc.ts';
import type { OperatorMethodOutput } from '@pellux/goodvibes-sdk';

export type CiReport = OperatorMethodOutput<'ci.status'>['report'];
export type CiWatchSubscription = OperatorMethodOutput<'ci.watches.list'>['watches'][number];

interface CiTarget {
  readonly repo: string;
  readonly ref?: string;
  readonly prNumber?: number;
}

/**
 * Parse a combined "repo-or-pr" token: `owner/repo`, `owner/repo#123` (PR),
 * or `owner/repo@ref` (branch/tag/sha). Returns null when the repo segment
 * is missing so callers can print a usage hint instead of a confusing error.
 */
export function parseCiTarget(token: string): CiTarget | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const prMatch = trimmed.match(/^([^#@]+)#(\d+)$/);
  if (prMatch) {
    const [, repo, prNumber] = prMatch;
    if (!repo) return null;
    return { repo, prNumber: Number(prNumber) };
  }
  const refMatch = trimmed.match(/^([^#@]+)@(.+)$/);
  if (refMatch) {
    const [, repo, ref] = refMatch;
    if (!repo || !ref) return null;
    return { repo, ref };
  }
  return { repo: trimmed };
}

export function formatTarget(target: { readonly repo: string; readonly ref?: string | undefined; readonly prNumber?: number | undefined }): string {
  if (target.prNumber) return `${target.repo}#${target.prNumber}`;
  if (target.ref) return `${target.repo}@${target.ref}`;
  return target.repo;
}

/** Per-job listing, doctrine-faithful: every job and its conclusion, never a rollup. */
export function renderReport(report: CiReport): string {
  const failing = report.jobs
    .filter((job) => job.status === 'completed' && job.conclusion !== 'success')
    .map((job) => job.name);
  const lines: string[] = [];
  if (report.overall !== 'passed' && failing.length > 0) lines.push(`FAILING: ${failing.join(', ')}`);
  lines.push(`CI ${report.overall.toUpperCase()} for ${formatTarget(report)}`);
  for (const job of report.jobs) {
    lines.push(`  - ${job.name}: ${job.status === 'completed' ? (job.conclusion ?? 'no-conclusion') : job.status}${job.continueOnError ? ' [continue-on-error]' : ''}`);
  }
  for (const violation of report.violations) lines.push(`  ! ${violation}`);
  return lines.join('\n');
}

export function renderWatch(watch: CiWatchSubscription): string {
  const parts = [
    `  ${watch.id}  ${formatTarget(watch)}`,
    `    delivery: ${watch.deliveryChannel}`,
    `    fix-session on failure: ${watch.triggerFixSession ? 'yes' : 'no'}`,
  ];
  if (watch.lastOverall) parts.push(`    last checked: ${watch.lastOverall}`);
  return parts.join('\n');
}

export function registerCiRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'ci',
    description: 'CI-watch: one-shot per-job status and standing watches over the operator surface',
    usage: 'status <repo-or-pr> | watch <repo-or-pr> <deliveryChannel> [--fix-session] | watches | unwatch <id>',
    argsHint: '[status|watch|watches|unwatch]',
    async handler(args, ctx) {
      const sub = args[0];
      const rpc = getOperatorRpc(ctx);

      if (sub === 'status') {
        const target = args[1] ? parseCiTarget(args[1]) : null;
        if (!target) {
          ctx.print('Usage: /ci status <repo-or-pr>  (e.g. owner/repo, owner/repo#123, owner/repo@branch)');
          return;
        }
        if (!rpc.available) {
          ctx.print(`[ci] ${rpc.reason}`);
          return;
        }
        try {
          const { report } = await rpc.sdk.operator.invoke('ci.status', {
            repo: target.repo,
            ...(target.ref !== undefined ? { ref: target.ref } : {}),
            ...(target.prNumber !== undefined ? { prNumber: target.prNumber } : {}),
          });
          ctx.print(renderReport(report));
        } catch (error) {
          ctx.print(`[ci status] ${describeOperatorRpcError(error)}`);
        }
        return;
      }

      if (sub === 'watch') {
        const target = args[1] ? parseCiTarget(args[1]) : null;
        const deliveryChannel = args[2];
        const triggerFixSession = args.includes('--fix-session');
        if (!target || !deliveryChannel) {
          ctx.print('Usage: /ci watch <repo-or-pr> <deliveryChannel> [--fix-session]  (deliveryChannel: "surfaceKind" or "surfaceKind:address")');
          return;
        }
        if (!rpc.available) {
          ctx.print(`[ci] ${rpc.reason}`);
          return;
        }
        try {
          const { watch } = await rpc.sdk.operator.invoke('ci.watches.create', {
            repo: target.repo,
            ...(target.ref !== undefined ? { ref: target.ref } : {}),
            ...(target.prNumber !== undefined ? { prNumber: target.prNumber } : {}),
            deliveryChannel,
            triggerFixSession,
          });
          ctx.print(`[ci watch] created watch ${watch.id} for ${formatTarget(watch)} -> ${watch.deliveryChannel}`);
        } catch (error) {
          ctx.print(`[ci watch] ${describeOperatorRpcError(error)}`);
        }
        return;
      }

      if (sub === 'watches') {
        const runId = args[1] === 'run' ? args[2] : undefined;
        if (!rpc.available) {
          ctx.print(`[ci] ${rpc.reason}`);
          return;
        }
        if (args[1] === 'run') {
          if (!runId) {
            ctx.print('Usage: /ci watches run <id>');
            return;
          }
          try {
            const result = await rpc.sdk.operator.invoke('ci.watches.run', { watchId: runId });
            const lines = [renderReport(result.report)];
            lines.push(`notified: ${result.notified ? 'yes' : 'no'}${result.notificationId ? ` (${result.notificationId})` : ''}`);
            lines.push(`fix-session triggered: ${result.fixSessionTriggered ? 'yes' : 'no'}`);
            ctx.print(lines.join('\n'));
            // Route the spawned session through the shared one-key jump affordance
            // instead of printing the id for the user to retype — same attach flow
            // as the accepted fix-this card.
            if (result.fixSessionId) ctx.armFixSessionAttach?.(result.fixSessionId);
          } catch (error) {
            ctx.print(`[ci watches run] ${describeOperatorRpcError(error)}`);
          }
          return;
        }
        try {
          const { watches } = await rpc.sdk.operator.invoke('ci.watches.list', {});
          if (watches.length === 0) {
            ctx.print('[ci watches] no standing watches.');
            return;
          }
          ctx.print(['CI watches:', ...watches.map(renderWatch)].join('\n'));
        } catch (error) {
          ctx.print(`[ci watches] ${describeOperatorRpcError(error)}`);
        }
        return;
      }

      if (sub === 'unwatch') {
        const watchId = args[1];
        if (!watchId) {
          ctx.print('Usage: /ci unwatch <id>');
          return;
        }
        if (!rpc.available) {
          ctx.print(`[ci] ${rpc.reason}`);
          return;
        }
        try {
          const result = await rpc.sdk.operator.invoke('ci.watches.delete', { watchId });
          ctx.print(result.deleted ? `[ci unwatch] deleted watch ${watchId}.` : `[ci unwatch] no watch found with id ${watchId}.`);
        } catch (error) {
          ctx.print(`[ci unwatch] ${describeOperatorRpcError(error)}`);
        }
        return;
      }

      ctx.print(
        'Usage: /ci <subcommand>\n'
        + '  /ci status <repo-or-pr>                        — per-job CI status (never a rollup)\n'
        + '  /ci watch <repo-or-pr> <deliveryChannel> [--fix-session] — create a standing watch\n'
        + '  /ci watches                                    — list standing watches\n'
        + '  /ci watches run <id>                           — check one watch now\n'
        + '  /ci unwatch <id>                                — delete a standing watch'
      );
    },
  });
}
