import { getPersistedWorktreeMeta, reviewWorktreeAttachments, summarizeWorktreeOwnership } from '../../runtime/worktree/registry.ts';
import type { CommandRegistry } from '../command-registry.ts';
import { openCommandPanel } from './runtime-services.ts';

export function registerWorktreeRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'worktree',
    aliases: ['worktrees'],
    description: 'Review and manage orchestrator-owned git worktrees',
    usage: '[review|panel|inspect <path>|attach <path> <session|task> <id>|session <id>|task <id>|recover <session|task> <id>|pause <path>|resume <path>|keep <path>|discard <path>|cleanup <path>]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'review').toLowerCase();
      const runtime = ctx.worktreeRegistry;
      if (!runtime) {
        ctx.print('Worktree registry is not wired into this runtime.');
        return;
      }
      if (sub === 'panel' || sub === 'open') {
        openCommandPanel(ctx, 'worktrees');
        return;
      }
      if (sub === 'inspect') {
        const path = args[1];
        if (!path) {
          ctx.print('Usage: /worktree inspect <path>');
          return;
        }
        const record = getPersistedWorktreeMeta(path);
        if (!record) {
          ctx.print(`Worktree inspect: no tracked worktree metadata for ${path}.`);
          return;
        }
        const nextSteps = [
          record.state === 'paused' ? `/worktree resume ${record.path}` : null,
          record.state === 'discard' || record.state === 'cleanup-pending' ? `/worktree cleanup ${record.path}` : null,
          record.state === 'kept' ? `/worktree keep ${record.path}` : null,
          record.sessionId ? `/worktree session ${record.sessionId}` : null,
          record.taskId ? `/worktree task ${record.taskId}` : null,
        ].filter((value): value is string => Boolean(value));
        ctx.print([
          'Worktree Inspect',
          `  path: ${record.path}`,
          `  kind: ${record.kind}`,
          `  state: ${record.state}`,
          `  owner: ${record.ownerId ?? 'n/a'}`,
          `  session: ${record.sessionId ?? 'n/a'}`,
          `  task: ${record.taskId ?? 'n/a'}`,
          `  updated: ${new Date(record.updatedAt).toLocaleString()}`,
          ...(nextSteps.length > 0 ? ['  next:', ...nextSteps.map((step) => `    ${step}`)] : ['  next: /worktree review']),
        ].join('\n'));
        return;
      }
      if (sub === 'attach') {
        const path = args[1];
        const targetKind = args[2];
        const targetId = args[3];
        if (!path || !targetKind || !targetId || (targetKind !== 'session' && targetKind !== 'task')) {
          ctx.print('Usage: /worktree attach <path> <session|task> <id>');
          return;
        }
        runtime.attach(path, targetKind === 'session' ? { sessionId: targetId } : { taskId: targetId });
        ctx.print(`Attached ${path} to ${targetKind} ${targetId}.`);
        return;
      }
      if (sub === 'session' || sub === 'task' || sub === 'recover') {
        const targetKind = sub === 'recover' ? args[1] : sub;
        const targetId = sub === 'recover' ? args[2] : args[1];
        if (!targetId || (targetKind !== 'session' && targetKind !== 'task')) {
          ctx.print(sub === 'recover'
            ? 'Usage: /worktree recover <session|task> <id>'
            : `Usage: /worktree ${sub} <id>`);
          return;
        }
        const review = reviewWorktreeAttachments(targetKind, targetId);
        const header = sub === 'recover' ? 'Worktree Recovery' : 'Worktree Attachment Review';
        ctx.print(review.total > 0
          ? [
              `${header}: ${targetKind} ${targetId}`,
              `  total: ${review.total}`,
              `  active: ${review.active}  paused: ${review.paused}  kept: ${review.kept}  discard: ${review.discard}  cleanup: ${review.cleanupPending}`,
              ...review.records.map((record) => `  ${record.state.padEnd(15)} ${record.kind.padEnd(12)} ${record.path}`),
              ...(sub === 'recover'
                ? [
                    '  next:',
                    ...review.records.map((record) => `    /worktree ${record.state === 'paused' ? 'resume' : 'keep'} ${record.path}`),
                    `    /${targetKind === 'session' ? 'session info' : 'task status'} ${targetId}`,
                  ]
                : []),
            ].join('\n')
          : `${header}: ${targetKind} ${targetId}\n  No attached worktrees tracked.`);
        return;
      }
      if (sub === 'pause' || sub === 'resume' || sub === 'keep' || sub === 'discard') {
        const path = args[1];
        if (!path) {
          ctx.print(`Usage: /worktree ${sub} <path>`);
          return;
        }
        const nextState = sub === 'resume'
          ? 'active'
          : sub === 'pause'
            ? 'paused'
            : sub === 'keep'
              ? 'kept'
              : 'discard';
        runtime.setState(path, nextState);
        ctx.print(`Updated ${path} to state ${nextState}.`);
        return;
      }
      if (sub === 'cleanup') {
        const path = args[1];
        if (!path) {
          ctx.print('Usage: /worktree cleanup <path>');
          return;
        }
        await runtime.cleanup(path);
        ctx.print(`Cleaned up worktree ${path}.`);
        return;
      }
      const rows = await runtime.list();
      const summary = summarizeWorktreeOwnership(rows);
      ctx.print(rows.length > 0
        ? [
            'Worktree Review',
            `  total: ${summary.total}`,
            `  active: ${summary.active}  paused: ${summary.paused}  kept: ${summary.kept}  discard: ${summary.discard}`,
            `  session attached: ${summary.sessionAttached}  task attached: ${summary.taskAttached}`,
            `  agent owned: ${summary.agentOwned}  orchestrator owned: ${summary.orchestratorOwned}  manual: ${summary.manualOwned}`,
            ...rows.map((row) => (
              `  ${row.kind.padEnd(12)} ${row.state.padEnd(15)} ${row.branch.padEnd(22)} session=${(row.sessionId ?? '-').padEnd(12)} task=${(row.taskId ?? '-').padEnd(12)} ${row.path}`
            )),
          ].join('\n')
        : 'Worktree Review\n  No worktrees discovered.');
    },
  });
}
