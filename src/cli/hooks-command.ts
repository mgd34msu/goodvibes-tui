import { buildHooksValidation } from './hooks-report.ts';
import type { CliCommandOutput, CliCommandRuntime } from '@pellux/goodvibes-terminal-shell';

// ---------------------------------------------------------------------------
// `goodvibes hooks validate`, validate the user's hooks.json against the
// hooks loader's REAL schema. The acceptance verdict comes from
// buildHooksValidation (src/cli/hooks-report.ts), which runs the SDK's own
// HookDispatcher.loadFromFile and getHookPointContract, the same machinery
// `goodvibes doctor hooks` reuses. This command only reads and reports.
// ---------------------------------------------------------------------------

export async function handleHooksCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const [sub = 'validate'] = runtime.cli.commandArgs;
  const json = runtime.cli.flags.outputFormat === 'json';
  if (sub !== 'validate') {
    return { output: 'Usage: goodvibes hooks validate', exitCode: 2 };
  }

  const report = buildHooksValidation(runtime.configManager);
  const { path } = report;

  if (!report.present) {
    const text = [
      'GoodVibes hooks validation',
      `  file: ${path}`,
      '  no hooks file present: nothing to validate.',
    ].join('\n');
    return { output: json ? JSON.stringify({ path, present: false, hooks: [], valid: true }, null, 2) : text, exitCode: 0 };
  }

  if (report.reason && report.checks.length === 0 && report.topLevelIssues.length === 0) {
    const text = ['GoodVibes hooks validation', `  file: ${path}`, `  FAIL: ${report.reason}`].join('\n');
    return { output: json ? JSON.stringify({ path, present: true, valid: false, reason: report.reason }, null, 2) : text, exitCode: 1 };
  }

  const { checks, topLevelIssues, chains, passCount, failCount, valid } = report;

  if (json) {
    return {
      output: JSON.stringify({
        path,
        present: true,
        valid,
        topLevelIssues,
        hooks: checks.map((c) => ({ pattern: c.pattern, index: c.index, name: c.name, ok: c.ok, reason: c.reason ?? null })),
        chains: { declared: chains.declared, accepted: chains.accepted },
      }, null, 2),
      exitCode: valid ? 0 : 1,
    };
  }

  const lines: string[] = [
    'GoodVibes hooks validation',
    `  file: ${path}`,
    `  hooks: ${checks.length} total, ${passCount} pass, ${checks.length - passCount} fail`,
  ];
  for (const issue of topLevelIssues) lines.push(`  FAIL: ${issue}`);
  for (const check of checks) {
    const label = `${check.pattern} #${check.index} ${check.name}`;
    if (check.ok) {
      const c = check.contract;
      const detail = c ? ` (contract: ${c.authority}/${c.executionMode})` : '';
      lines.push(`  PASS  ${label}${detail}`);
    } else {
      lines.push(`  FAIL  ${label}: ${check.reason}`);
    }
  }
  if (chains.declared > 0 || chains.accepted > 0) {
    lines.push(`  chains: ${chains.declared} declared, ${chains.accepted} accepted by the loader`);
  }
  lines.push(valid ? '  result: all hooks are valid.' : `  result: ${failCount} problem(s) found.`);

  return { output: lines.join('\n'), exitCode: valid ? 0 : 1 };
}
