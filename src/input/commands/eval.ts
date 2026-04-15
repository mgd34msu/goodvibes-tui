/**
 * /eval command handler.
 *
 * Implements the Evaluation Harness commands:
 *
 *   /eval list                    — List all available eval suites
 *   /eval run <suite>             — Run a named suite (or 'all')
 *   /eval compare <baseline-file> — Compare last run against a baseline file
 *   /eval gate <suite>            — Run suite and apply CI gate (exits 1 on regression)
 */

import type { SlashCommand, CommandContext } from '../command-registry.ts';
import { EvalRunner } from '../../runtime/eval/runner.ts';
import { BUILTIN_SUITES } from '../../runtime/eval/suites.ts';
import { formatScorecard } from '@pellux/goodvibes-sdk/platform/runtime/eval/scorecard';
import { loadBaseline, captureBaseline, formatBaselineComparison, writeBaseline } from '@pellux/goodvibes-sdk/platform/runtime/eval/baseline';
import type { EvalRegistry } from '../../panels/eval-panel.ts';
import { formatSuiteResult, formatGateResult } from '@pellux/goodvibes-sdk/platform/runtime/eval/format';
import { requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

// ── Subcommand helpers ────────────────────────────────────────────────────────

function printSuiteList(context: CommandContext): void {
  context.print('[eval] Available suites:');
  for (const [name, scenarios] of Object.entries(BUILTIN_SUITES)) {
    context.print(`  ${name}  (${scenarios.length} scenarios)`);
    for (const s of scenarios) {
      context.print(`    - ${s.id}: ${s.name}`);
    }
  }
  context.print('[eval] Usage: /eval run <suite>  or  /eval run all');
}

function getRegistry(context: CommandContext): EvalRegistry | undefined {
  return context.extensions.evalRegistry;
}

// ── /eval list ────────────────────────────────────────────────────────────────

function handleList(_args: string[], context: CommandContext): void {
  printSuiteList(context);
}

// ── /eval run ────────────────────────────────────────────────────────────────

async function handleRun(args: string[], context: CommandContext): Promise<void> {
  const suiteName = args[0] ?? 'all';
  const registry = getRegistry(context);

  const suitesToRun =
    suiteName === 'all'
      ? Object.keys(BUILTIN_SUITES)
      : BUILTIN_SUITES[suiteName]
        ? [suiteName]
        : null;

  if (!suitesToRun) {
    context.print(`[eval] Unknown suite: "${suiteName}". Run /eval list to see available suites.`);
    return;
  }

  const runner = new EvalRunner();
  registry?.setRunning(true);

  for (const name of suitesToRun) {
    const scenarios = BUILTIN_SUITES[name];
    if (!scenarios) continue;

    context.print(`[eval] Running suite: ${name} (${scenarios.length} scenarios)...`);
    const result = await runner.runSuite(name, scenarios);
    registry?.push(result);

    context.print(formatSuiteResult(result));

    for (const r of result.results) {
      context.print(formatScorecard(r.scorecard));
    }
  }

  registry?.setRunning(false);
}

// ── /eval compare ─────────────────────────────────────────────────────────────

async function handleCompare(args: string[], context: CommandContext): Promise<void> {
  const baselineFile = args[0] ?? '.goodvibes/eval/baseline.json';
  const registry = getRegistry(context);
  const projectRoot = requireShellPaths(context).workingDirectory;
  const suiteResults = registry?.getSuiteResults() ?? [];

  if (suiteResults.length === 0) {
    context.print('[eval] No suite results to compare. Run /eval run <suite> first.');
    return;
  }

  const baseline = await loadBaseline(baselineFile, projectRoot);
  if (!baseline) {
    context.print(`[eval] Baseline file not found: ${baselineFile}`);
    context.print('[eval] Tip: run /eval gate <suite> to create a baseline.');
    return;
  }

  for (const result of suiteResults) {
    context.print(formatBaselineComparison(baseline, result));
  }
}

// ── /eval gate ────────────────────────────────────────────────────────────────

async function handleGate(args: string[], context: CommandContext): Promise<void> {
  const suiteName = args[0];
  const baselineFile = args[1] ?? '.goodvibes/eval/baseline.json';
  const saveFlag = args.includes('--save-baseline');
  const projectRoot = requireShellPaths(context).workingDirectory;

  if (!suiteName) {
    context.print('[eval] Usage: /eval gate <suite> [baseline-file] [--save-baseline]');
    return;
  }

  const scenarios = BUILTIN_SUITES[suiteName];
  if (!scenarios) {
    context.print(`[eval] Unknown suite: "${suiteName}". Run /eval list to see available suites.`);
    return;
  }

  const registry = getRegistry(context);
  const runner = new EvalRunner();

  context.print(`[eval] Gate: running suite "${suiteName}"...`);
  registry?.setRunning(true);
  const fresh = await runner.runSuite(suiteName, scenarios);
  registry?.push(fresh);
  registry?.setRunning(false);

  const baseline = await loadBaseline(baselineFile, projectRoot);
  const gate = runner.evaluateGate(fresh, baseline);
  registry?.pushGate(gate);

  context.print(formatGateResult(gate));

  if (saveFlag || !baseline) {
    const label = args[0] ?? 'latest';
    const newBaseline = captureBaseline(label, [fresh]);
    try {
      await writeBaseline(baselineFile, newBaseline, projectRoot);
      context.print(`[eval] Baseline saved to ${baselineFile}`);
    } catch (err) {
      context.print(`[eval] Warning: could not save baseline: ${summarizeError(err)}`);
    }
  }

  if (!gate.passed) {
    context.print(`[eval] Gate FAILED: ${gate.regressions.length} regression(s) detected.`);
  } else {
    context.print('[eval] Gate PASSED.');
  }
}

// ── Top-level command ─────────────────────────────────────────────────────────

export const evalCommand: SlashCommand = {
  name: 'eval',
  description: 'Evaluation harness: run benchmark suites, compare baselines, and gate regressions.',
  usage: '<subcommand> [args]',
  argsHint: 'list|run <suite>|compare <baseline>|gate <suite>',
  handler: async (args: string[], context: CommandContext): Promise<void> => {
    const [sub, ...rest] = args;

    switch (sub) {
      case 'list':
      case 'ls':
        handleList(rest, context);
        break;

      case 'run':
        await handleRun(rest, context);
        break;

      case 'compare':
      case 'cmp':
        await handleCompare(rest, context);
        break;

      case 'gate':
        await handleGate(rest, context);
        break;

      default: {
        const usage = [
          'Usage: /eval <subcommand>',
          '  list                           — List all available eval suites',
          '  run <suite|all>                — Run a named suite (or all suites)',
          '  compare [baseline-file]        — Compare last results against baseline',
          '  gate <suite> [baseline-file]   — Run suite and apply regression gate',
          '    --save-baseline              — Save fresh run as new baseline',
        ].join('\n');
        context.print(usage);
        break;
      }
    }
  },
};
