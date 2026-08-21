import { join } from 'path';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { GitService } from '@pellux/goodvibes-sdk/platform/git';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requirePanelManager, requireSessionChangeTracker, requireShellPaths } from './runtime-services.ts';

/**
 * Run a git command that lists changed file names, capturing stderr instead
 * of letting it fall through to the process's real stderr (which, for a
 * spawned child with no stdio option, is inherited from the parent, i.e.
 * written straight to the TUI's controlling terminal, corrupting the screen
 * outside the renderer's front/back-buffer diffing). Mirrors the 'staged'
 * subcommand's existing pattern below.
 */
async function runGitNameOnly(args: string[], cwd: string): Promise<{ files: string[]; errText: string; ok: boolean }> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', cwd });
  const [out, errRaw] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return {
    files: out.trim().split('\n').filter(Boolean),
    errText: errRaw.trim(),
    ok: exitCode === 0,
  };
}

/** Report a failed name-only fetch through the normal print channel and force
 * a full repaint on the next frame as defense-in-depth, in case anything did
 * reach the real tty. */
function reportGitNameOnlyFailure(ctx: CommandContext, label: string, errText: string): void {
  ctx.print(`${label} failed: ${errText || 'unknown error'}`);
  ctx.requestFullRepaint?.();
}

async function enrichSemanticDiff(
  panel: InstanceType<typeof import('../../panels/diff-panel.ts').DiffPanel>,
  files: string[],
  ref: string,
  renderFn: () => void,
  workingDirectory: string,
): Promise<void> {
  const { computeSemanticDiff, formatSemanticDiffSummary } = await import('../../renderer/semantic-diff.ts');
  const { relative: pathRelative } = await import('path');
  const repoRootProc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], { stdout: 'pipe', stderr: 'pipe', cwd: workingDirectory });
  await repoRootProc.exited;
  const repoRoot = (await new Response(repoRootProc.stdout).text()).trim() || workingDirectory;
  await Promise.allSettled(
    files.map(async (filePath) => {
      try {
        const absPath = filePath.startsWith('/') ? filePath : join(workingDirectory, filePath);
        const repoRelPath = filePath.startsWith('/') ? pathRelative(repoRoot, filePath) : filePath;
        const [beforeResult, afterResult] = await Promise.allSettled([
          (async () => {
            const proc = Bun.spawn(
              ['git', 'show', `${ref}:${repoRelPath}`],
              { stdout: 'pipe', stderr: 'pipe', cwd: repoRoot },
            );
            const [text, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
            if (exitCode !== 0) throw new Error(`git show failed for ${repoRelPath}`);
            return text;
          })(),
          Bun.file(absPath).text(),
        ]);
        if (beforeResult.status !== 'fulfilled' || afterResult.status !== 'fulfilled') return;
        const semanticDiff = await computeSemanticDiff(filePath, beforeResult.value, afterResult.value);
        if (!semanticDiff) return;
        const summary = formatSemanticDiffSummary(semanticDiff);
        if (summary) {
          panel.setSemanticSummary(filePath, summary);
          renderFn();
        }
      } catch {
        // best-effort only
      }
    }),
  );
}

export function registerDiffRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'diff',
    aliases: ['d'],
    description: 'Show unified diff of session file changes. Uses git diff HEAD if in a git repo',
    usage: '[session|head|working|staged|<git-ref>]',
    argsHint: '[session|head|working|staged|<ref>]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const workingDirectory = shellPaths.workingDirectory;
      // Gate before any git spawn happens (same defensive check /git already
      // has), every subcommand below shells out to git, and without this
      // they each produced a differently-shaped error for the same
      // not-a-git-repo condition.
      if (!GitService.isGitRepo(workingDirectory)) {
        ctx.print('Not a git repository here. Run /git to initialize one.');
        return;
      }
      const { DiffPanel } = await import('../../panels/diff-panel.ts');

      const pm = requirePanelManager(ctx);
      let panel = pm.getAllOpen().find(p => p.id === 'diff');
      if (!panel) {
        try {
          panel = pm.open('diff');
        } catch {
          ctx.print('Could not open diff panel.');
          return;
        }
      }
      pm.activateById('diff');
      if (!pm.isVisible()) pm.show();
      ctx.focusPanels?.();

      const diffPanel = panel as InstanceType<typeof DiffPanel>;
      const sub = (args[0] ?? 'session').toLowerCase();

      switch (sub) {
        case 'working': {
          ctx.print('Loading working-tree diff...');
          await diffPanel.showGitDiff();
          ctx.print('Diff panel updated: working tree changes.');
          const workingChanged = await runGitNameOnly(['git', 'diff', '--name-only'], workingDirectory);
          if (!workingChanged.ok) {
            reportGitNameOnlyFailure(ctx, 'git diff --name-only', workingChanged.errText);
          } else if (workingChanged.files.length > 0) {
            enrichSemanticDiff(diffPanel, workingChanged.files, 'HEAD', () => ctx.renderRequest(), workingDirectory).catch((err) => { logger.debug('semantic diff enrichment failed', { err }); });
          }
          break;
        }
        case 'staged': {
          ctx.print('Loading staged diff...');
          const proc = Bun.spawn(['/bin/sh', '-c', 'git diff --cached'], { stdout: 'pipe', stderr: 'pipe', cwd: workingDirectory });
          const [raw, errText] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            ctx.print(`git diff --cached failed: ${errText.trim() || 'unknown error'}`);
            return;
          }
          if (!raw.trim()) {
            ctx.print('No staged changes.');
            diffPanel.showDiff('(no staged changes)', '@@ -0,0 +0,0 @@\n No staged changes.');
          } else {
            diffPanel.loadRawDiff(raw);
            ctx.print('Diff panel updated: staged changes.');
            const stagedChanged = await runGitNameOnly(['git', 'diff', '--cached', '--name-only'], workingDirectory);
            if (!stagedChanged.ok) {
              reportGitNameOnlyFailure(ctx, 'git diff --cached --name-only', stagedChanged.errText);
            } else if (stagedChanged.files.length > 0) {
              enrichSemanticDiff(diffPanel, stagedChanged.files, 'HEAD', () => ctx.renderRequest(), workingDirectory).catch((err) => { logger.debug('semantic diff enrichment failed', { err }); });
            }
          }
          break;
        }
        case 'head': {
          ctx.print('Loading diff vs HEAD...');
          await diffPanel.showGitDiff('HEAD');
          ctx.print('Diff panel updated: all changes vs HEAD.');
          const headChanged = await runGitNameOnly(['git', 'diff', 'HEAD', '--name-only'], workingDirectory);
          if (!headChanged.ok) {
            reportGitNameOnlyFailure(ctx, 'git diff HEAD --name-only', headChanged.errText);
          } else if (headChanged.files.length > 0) {
            enrichSemanticDiff(diffPanel, headChanged.files, 'HEAD', () => ctx.renderRequest(), workingDirectory).catch((err) => { logger.debug('semantic diff enrichment failed', { err }); });
          }
          break;
        }
        case 'session':
        default: {
          const sessionFiles = requireSessionChangeTracker(ctx).getChangedFiles();
          if (sessionFiles.length > 0) {
            ctx.print(`Loading session diff (${sessionFiles.length} file${sessionFiles.length === 1 ? '' : 's'} changed this session)...`);
            await diffPanel.showFileDiffs(sessionFiles, 'HEAD');
            ctx.print(`Diff panel updated: ${sessionFiles.length} session file${sessionFiles.length === 1 ? '' : 's'}.`);
            enrichSemanticDiff(diffPanel, sessionFiles, 'HEAD', () => ctx.renderRequest(), workingDirectory).catch((err) => { logger.debug('semantic diff enrichment failed', { err }); });
          } else {
            ctx.print('No session changes tracked yet. Showing diff vs HEAD...');
            await diffPanel.showGitDiff('HEAD');
            ctx.print('Diff panel updated: all changes vs HEAD.');
            const fallback = await runGitNameOnly(['git', 'diff', 'HEAD', '--name-only'], workingDirectory);
            if (!fallback.ok) {
              reportGitNameOnlyFailure(ctx, 'git diff HEAD --name-only', fallback.errText);
            } else if (fallback.files.length > 0) {
              enrichSemanticDiff(diffPanel, fallback.files, 'HEAD', () => ctx.renderRequest(), workingDirectory).catch((err) => { logger.debug('semantic diff enrichment failed', { err }); });
            }
          }
          break;
        }
      }

      ctx.renderRequest();
    },
  });
}
