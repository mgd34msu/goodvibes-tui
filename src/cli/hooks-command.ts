import { existsSync, readFileSync } from 'node:fs';
import { createHookDispatcher, createHookWorkbench, getHookPointContract } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookDefinition, HookEventPath, HookPointContract } from '@pellux/goodvibes-sdk/platform/hooks';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { CliCommandOutput, CliCommandRuntime } from './types.ts';

// ---------------------------------------------------------------------------
// `goodvibes hooks validate` — validate the user's hooks.json against the
// hooks loader's REAL schema. No second validator: the field-level acceptance
// verdict comes from running the SDK's own HookDispatcher.loadFromFile (the same
// loader the app uses), and the "is this a real hook event point" verdict comes
// from the SDK's getHookPointContract. This command only reads and reports.
// ---------------------------------------------------------------------------

interface HookCheck {
  readonly pattern: string;
  readonly index: number;
  readonly name: string;
  readonly ok: boolean;
  readonly reason?: string;
  readonly contract?: HookPointContract | null;
}

const LOADER_FIELD_REASON =
  "the hooks loader skipped this entry — a hook needs a string \"match\" and a \"type\" of command, prompt, agent, http, or ts";

/** Build a consumable multiset of the loader-accepted definitions, keyed by pattern. */
function acceptedMultiset(accepted: Map<string, HookDefinition[]>): Map<string, Map<string, number>> {
  const byPattern = new Map<string, Map<string, number>>();
  for (const [pattern, defs] of accepted.entries()) {
    const counts = new Map<string, number>();
    for (const def of defs) {
      const key = JSON.stringify(def);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    byPattern.set(pattern, counts);
  }
  return byPattern;
}

/** True when this exact definition was accepted by the loader (consumes one match). */
function consumeAccepted(counts: Map<string, number> | undefined, def: unknown): boolean {
  if (!counts) return false;
  const key = JSON.stringify(def);
  const remaining = counts.get(key);
  if (remaining === undefined || remaining <= 0) return false;
  counts.set(key, remaining - 1);
  return true;
}

export async function handleHooksCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const [sub = 'validate'] = runtime.cli.commandArgs;
  const json = runtime.cli.flags.outputFormat === 'json';
  if (sub !== 'validate') {
    return { output: 'Usage: goodvibes hooks validate', exitCode: 2 };
  }

  // Resolve the hooks file the same way the running app does (tools.hooksFile).
  const dispatcher = createHookDispatcher();
  const workbench = createHookWorkbench({ hookDispatcher: dispatcher, configManager: runtime.configManager });
  const path = workbench.getHooksFilePath();

  if (!existsSync(path)) {
    const text = [
      'GoodVibes hooks validation',
      `  file: ${path}`,
      '  no hooks file present — nothing to validate.',
    ].join('\n');
    return { output: json ? JSON.stringify({ path, present: false, hooks: [], valid: true }, null, 2) : text, exitCode: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    const reason = summarizeError(error);
    const text = [
      'GoodVibes hooks validation',
      `  file: ${path}`,
      `  FAIL: hooks.json is not valid JSON — ${reason}`,
    ].join('\n');
    return { output: json ? JSON.stringify({ path, present: true, valid: false, reason }, null, 2) : text, exitCode: 1 };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const text = [
      'GoodVibes hooks validation',
      `  file: ${path}`,
      '  FAIL: hooks.json must be a JSON object with "hooks" and/or "chains".',
    ].join('\n');
    return { output: json ? JSON.stringify({ path, valid: false, reason: 'hooks.json must be an object' }, null, 2) : text, exitCode: 1 };
  }

  const record = parsed as { hooks?: unknown; chains?: unknown };
  const topLevelIssues: string[] = [];

  // Run the real loader once so field-level acceptance mirrors runtime behavior.
  dispatcher.loadFromFile(path);
  const accepted = acceptedMultiset(dispatcher.getHooks());

  const checks: HookCheck[] = [];
  if (record.hooks !== undefined) {
    if (typeof record.hooks !== 'object' || record.hooks === null || Array.isArray(record.hooks)) {
      topLevelIssues.push('the "hooks" field must be an object keyed by event-path pattern.');
    } else {
      for (const [pattern, defs] of Object.entries(record.hooks as Record<string, unknown>)) {
        const contract = getHookPointContract(pattern as HookEventPath);
        if (!Array.isArray(defs)) {
          checks.push({ pattern, index: 0, name: '(all)', ok: false, contract, reason: `the value for "${pattern}" must be an array of hook definitions.` });
          continue;
        }
        const counts = accepted.get(pattern);
        defs.forEach((def, index) => {
          const name = (typeof def === 'object' && def !== null && typeof (def as { name?: unknown }).name === 'string')
            ? (def as { name: string }).name
            : '(unnamed)';
          const loaderAccepted = consumeAccepted(counts, def);
          let ok = true;
          let reason: string | undefined;
          if (!loaderAccepted) {
            ok = false;
            reason = LOADER_FIELD_REASON;
          } else if (contract === null) {
            ok = false;
            reason = `"${pattern}" is not a recognized hook event point (no matching hook contract).`;
          }
          checks.push({ pattern, index, name, ok, contract, ...(reason ? { reason } : {}) });
        });
      }
    }
  }

  const chainCount = Array.isArray(record.chains) ? record.chains.length : 0;
  if (record.chains !== undefined && !Array.isArray(record.chains)) {
    topLevelIssues.push('the "chains" field must be an array.');
  }
  const acceptedChains = dispatcher.getChains().length;

  const failCount = checks.filter((c) => !c.ok).length + topLevelIssues.length;
  const passCount = checks.filter((c) => c.ok).length;
  const valid = failCount === 0;

  if (json) {
    return {
      output: JSON.stringify({
        path,
        present: true,
        valid,
        topLevelIssues,
        hooks: checks.map((c) => ({ pattern: c.pattern, index: c.index, name: c.name, ok: c.ok, reason: c.reason ?? null })),
        chains: { declared: chainCount, accepted: acceptedChains },
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
      lines.push(`  FAIL  ${label} — ${check.reason}`);
    }
  }
  if (chainCount > 0 || acceptedChains > 0) {
    lines.push(`  chains: ${chainCount} declared, ${acceptedChains} accepted by the loader`);
  }
  lines.push(valid ? '  result: all hooks are valid.' : `  result: ${failCount} problem(s) found.`);

  return { output: lines.join('\n'), exitCode: valid ? 0 : 1 };
}
