import type { CommandRegistry } from '../command-registry.ts';
import { GitService } from '@pellux/goodvibes-sdk/platform/git';
import { requireShellPaths, requirePanelManager } from './runtime-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

export function registerGitRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'git',
    aliases: ['g'],
    description: 'Git repository commands — status, log, diff',
    usage: '[status|log|diff]',
    argsHint: '[status|log|diff]',
    async handler(args, ctx) {
      const sub = args[0] ?? 'status';
      const cwd = requireShellPaths(ctx).workingDirectory;
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
            ctx.print(`Git status failed: ${summarizeError(e)}`);
          }
          break;
        }
        case 'log': {
          try {
            const entries = await git.log(10);
            ctx.print([`Recent commits (${entries.length}):`, ...entries.map((entry) => `  ${entry.hash.slice(0, 7)}  ${entry.date.slice(0, 10)}  ${entry.message}`)].join('\n'));
          } catch (e) {
            ctx.print(`Git log failed: ${summarizeError(e)}`);
          }
          break;
        }
        case 'diff': {
          // Route the full, uncapped working-tree diff (GitService.diffStructured
          // — parsed per-file/per-hunk with no size limit) into the real diff
          // panel. The old path sliced the raw text at 4,000 chars and printed a
          // stub; a large diff now renders complete.
          try {
            const structured = await git.diffStructured();
            if (structured.files.length === 0) {
              ctx.print('No unstaged changes.');
              break;
            }
            const { DiffPanel } = await import('../../panels/diff-panel.ts');
            const pm = requirePanelManager(ctx);
            let panel = pm.getAllOpen().find((p) => p.id === 'diff');
            if (!panel) {
              try {
                panel = pm.open('diff');
              } catch {
                ctx.print('Could not open diff panel.');
                break;
              }
            }
            pm.activateById('diff');
            if (!pm.isVisible()) pm.show();
            ctx.focusPanels?.();
            (panel as InstanceType<typeof DiffPanel>).loadStructuredDiff(structured);
            const fileWord = structured.files.length === 1 ? 'file' : 'files';
            ctx.print(`Diff panel updated: ${structured.files.length} ${fileWord}, +${structured.additions} -${structured.deletions} (complete, uncapped).`);
            ctx.renderRequest();
          } catch (e) {
            ctx.print(`Git diff failed: ${summarizeError(e)}`);
          }
          break;
        }
        default:
          ctx.print('Usage: /git [status|log|diff]\n  /git          — working tree status (default)\n  /git status   — working tree status\n  /git log      — recent commits\n  /git diff     — unstaged changes');
      }
    },
  });
}
