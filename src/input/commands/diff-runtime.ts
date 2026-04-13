import { join } from 'path';
import type { CommandRegistry } from '../command-registry.ts';
import { requirePanelManager, requireSessionChangeTracker, requireShellPaths } from './runtime-services.ts';

async function enrichSemanticDiff(
  panel: InstanceType<typeof import('../../panels/diff-panel.ts').DiffPanel>,
  files: string[],
  ref: string,
  renderFn: () => void,
  workingDirectory: string,
): Promise<void> {
  const { computeSemanticDiff, formatSemanticDiffSummary } = await import('../../renderer/semantic-diff.ts');
  const { relative: pathRelative } = await import('path');
  const repoRootProc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], { stdout: 'pipe', cwd: workingDirectory });
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
    description: 'Show unified diff of session file changes. Uses git diff HEAD if in a git repo.',
    usage: '[session|head|working|staged|<git-ref>]',
    argsHint: '[session|head|working|staged|<ref>]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const workingDirectory = shellPaths.workingDirectory;
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
          const workingChangedFiles = await (async () => {
            const proc = Bun.spawn(['git', 'diff', '--name-only'], { stdout: 'pipe', cwd: workingDirectory });
            await proc.exited;
            return (await new Response(proc.stdout).text()).trim().split('\n').filter(Boolean);
          })();
          if (workingChangedFiles.length > 0) {
            enrichSemanticDiff(diffPanel, workingChangedFiles, 'HEAD', () => ctx.renderRequest(), workingDirectory).catch(() => {});
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
            const stagedChangedFiles = await (async () => {
              const stagedProc = Bun.spawn(['git', 'diff', '--cached', '--name-only'], { stdout: 'pipe', cwd: workingDirectory });
              await stagedProc.exited;
              return (await new Response(stagedProc.stdout).text()).trim().split('\n').filter(Boolean);
            })();
            if (stagedChangedFiles.length > 0) {
              enrichSemanticDiff(diffPanel, stagedChangedFiles, 'HEAD', () => ctx.renderRequest(), workingDirectory).catch(() => {});
            }
          }
          break;
        }
        case 'head': {
          ctx.print('Loading diff vs HEAD...');
          await diffPanel.showGitDiff('HEAD');
          ctx.print('Diff panel updated: all changes vs HEAD.');
          const headChangedFiles = await (async () => {
            const proc = Bun.spawn(['/bin/sh', '-c', 'git diff HEAD --name-only'], { stdout: 'pipe', cwd: workingDirectory });
            await proc.exited;
            return (await new Response(proc.stdout).text()).trim().split('\n').filter(Boolean);
          })();
          if (headChangedFiles.length > 0) {
            enrichSemanticDiff(diffPanel, headChangedFiles, 'HEAD', () => ctx.renderRequest(), workingDirectory).catch(() => {});
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
            enrichSemanticDiff(diffPanel, sessionFiles, 'HEAD', () => ctx.renderRequest(), workingDirectory).catch(() => {});
          } else {
            ctx.print('No session changes tracked yet. Showing diff vs HEAD...');
            await diffPanel.showGitDiff('HEAD');
            ctx.print('Diff panel updated: all changes vs HEAD.');
            const fallbackFiles = await (async () => {
              const proc = Bun.spawn(['/bin/sh', '-c', 'git diff HEAD --name-only'], { stdout: 'pipe', cwd: workingDirectory });
              await proc.exited;
              return (await new Response(proc.stdout).text()).trim().split('\n').filter(Boolean);
            })();
            if (fallbackFiles.length > 0) {
              enrichSemanticDiff(diffPanel, fallbackFiles, 'HEAD', () => ctx.renderRequest(), workingDirectory).catch(() => {});
            }
          }
          break;
        }
      }

      ctx.renderRequest();
    },
  });
}
