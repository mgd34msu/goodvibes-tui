import type { CommandRegistry } from '../command-registry.ts';
import { GitService } from '../../git/service.ts';

export function registerGitRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'git',
    aliases: ['g'],
    description: 'Git repository commands — status, log, diff',
    usage: '[status|log|diff]',
    argsHint: '[status|log|diff]',
    async handler(args, ctx) {
      const sub = args[0] ?? 'status';
      const cwd = process.cwd();
      if (!GitService.isGitRepo(cwd)) {
        const initResult = GitService.initRepo(cwd);
        if (!initResult.success) {
          ctx.print(`Failed to initialise git repository: ${initResult.error ?? 'unknown error'}`);
          return;
        }
        ctx.print(`Initialized git repository in ${cwd}`);
      }

      const git = new GitService(cwd);
      switch (sub) {
        case 'status': {
          try {
            const st = await git.status();
            const lines: string[] = ['Git status:'];
            if (st.isClean()) {
              lines.push('  Working tree clean — nothing to commit.');
            } else {
              if (st.staged.length > 0) {
                lines.push(`  Staged (${st.staged.length}):`);
                for (const f of st.staged) lines.push(`    + ${f}`);
              }
              if (st.modified.length > 0) {
                lines.push(`  Modified (${st.modified.length}):`);
                for (const f of st.modified) lines.push(`    ~ ${f}`);
              }
              if (st.not_added.length > 0) {
                lines.push(`  Untracked (${st.not_added.length}):`);
                for (const f of st.not_added) lines.push(`    ? ${f}`);
              }
              if (st.deleted.length > 0) {
                lines.push(`  Deleted (${st.deleted.length}):`);
                for (const f of st.deleted) lines.push(`    - ${f}`);
              }
            }
            ctx.print(lines.join('\n'));
          } catch (e) {
            ctx.print(`Git status failed: ${(e as Error).message}`);
          }
          break;
        }
        case 'log': {
          try {
            const entries = await git.log(10);
            ctx.print([`Recent commits (${entries.length}):`, ...entries.map((entry) => `  ${entry.hash.slice(0, 7)}  ${entry.date.slice(0, 10)}  ${entry.message}`)].join('\n'));
          } catch (e) {
            ctx.print(`Git log failed: ${(e as Error).message}`);
          }
          break;
        }
        case 'diff': {
          try {
            const diffText = await git.diff();
            if (!diffText.trim()) ctx.print('No unstaged changes.');
            else ctx.print(diffText.length > 4000 ? `${diffText.slice(0, 4000)}\n\n...(diff truncated)` : diffText);
          } catch (e) {
            ctx.print(`Git diff failed: ${(e as Error).message}`);
          }
          break;
        }
        default:
          ctx.print('Usage: /git [status|log|diff]\n  /git          — working tree status (default)\n  /git status   — working tree status\n  /git log      — recent commits\n  /git diff     — unstaged changes');
      }
    },
  });
}
