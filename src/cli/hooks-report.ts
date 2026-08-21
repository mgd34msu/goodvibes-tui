import { existsSync, readFileSync } from 'node:fs';
import { createHookDispatcher, createHookWorkbench, getHookPointContract } from '@pellux/goodvibes-sdk/platform/hooks';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { HookDefinition, HookEventPath, HookPointContract, HookType } from '@pellux/goodvibes-sdk/platform/hooks';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

// ---------------------------------------------------------------------------
// Shared hooks validation core. The single source of truth for both
// `goodvibes hooks validate` (src/cli/hooks-command.ts) and `goodvibes doctor
// hooks` (src/cli/doctor.ts). There is NO second validator: field-level
// acceptance comes from running the SDK's own HookDispatcher.loadFromFile (the
// same loader the app uses at startup), and the "is this a real hook event
// point" verdict comes from the SDK's getHookPointContract. This module only
// reads and reports, it changes no config and fires no hooks.
// ---------------------------------------------------------------------------

/** Per-hook acceptance verdict, keyed to the on-disk position it was declared at. */
export interface HookCheck {
  readonly pattern: string;
  readonly index: number;
  readonly name: string;
  /** The declared hook type, when present and readable (command/prompt/agent/http/ts). */
  readonly type: string;
  readonly ok: boolean;
  readonly reason?: string;
  readonly contract?: HookPointContract | null;
}

/** The full validation result for one hooks file. */
export interface HooksValidation {
  /** Absolute path the app resolves `tools.hooksFile` to, the "from where" of every hook. */
  readonly path: string;
  readonly present: boolean;
  readonly valid: boolean;
  /** A whole-file parse failure (invalid JSON / not an object). Present ⇒ no per-hook checks. */
  readonly reason?: string;
  readonly topLevelIssues: readonly string[];
  readonly checks: readonly HookCheck[];
  readonly chains: { readonly declared: number; readonly accepted: number };
  readonly passCount: number;
  readonly failCount: number;
}

export const LOADER_FIELD_REASON =
  "the hooks loader skipped this entry; a hook needs a string \"match\" and a \"type\" of command, prompt, agent, http, or ts";

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

function readHookType(def: unknown): string {
  if (def && typeof def === 'object' && typeof (def as { type?: unknown }).type === 'string') {
    return (def as { type: string }).type;
  }
  return '(none)';
}

function readHookName(def: unknown): string {
  if (def && typeof def === 'object' && typeof (def as { name?: unknown }).name === 'string') {
    return (def as { name: string }).name;
  }
  return '(unnamed)';
}

/**
 * Resolve the hooks file the same way the running app does (tools.hooksFile),
 * load it through the real dispatcher, and report per-hook acceptance plus each
 * hook's event-point contract. Empty/absent file ⇒ present=false, valid=true.
 */
export function buildHooksValidation(configManager: Pick<ConfigManager, 'get' | 'getWorkingDirectory'>): HooksValidation {
  const dispatcher = createHookDispatcher();
  const workbench = createHookWorkbench({ hookDispatcher: dispatcher, configManager });
  const path = workbench.getHooksFilePath();

  if (!existsSync(path)) {
    return { path, present: false, valid: true, topLevelIssues: [], checks: [], chains: { declared: 0, accepted: 0 }, passCount: 0, failCount: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    return { path, present: true, valid: false, reason: `hooks.json is not valid JSON; ${summarizeError(error)}`, topLevelIssues: [], checks: [], chains: { declared: 0, accepted: 0 }, passCount: 0, failCount: 1 };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { path, present: true, valid: false, reason: 'hooks.json must be a JSON object with "hooks" and/or "chains".', topLevelIssues: [], checks: [], chains: { declared: 0, accepted: 0 }, passCount: 0, failCount: 1 };
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
          checks.push({ pattern, index: 0, name: '(all)', type: '(none)', ok: false, contract, reason: `the value for "${pattern}" must be an array of hook definitions.` });
          continue;
        }
        const counts = accepted.get(pattern);
        defs.forEach((def, index) => {
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
          checks.push({ pattern, index, name: readHookName(def), type: readHookType(def), ok, contract, ...(reason ? { reason } : {}) });
        });
      }
    }
  }

  const declaredChains = Array.isArray(record.chains) ? record.chains.length : 0;
  if (record.chains !== undefined && !Array.isArray(record.chains)) {
    topLevelIssues.push('the "chains" field must be an array.');
  }
  const acceptedChains = dispatcher.getChains().length;

  const failCount = checks.filter((c) => !c.ok).length + topLevelIssues.length;
  const passCount = checks.filter((c) => c.ok).length;

  return {
    path,
    present: true,
    valid: failCount === 0,
    topLevelIssues,
    checks,
    chains: { declared: declaredChains, accepted: acceptedChains },
    passCount,
    failCount,
  };
}

export type { HookType };
