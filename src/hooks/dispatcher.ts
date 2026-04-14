import { readFileSync, statSync } from 'fs';
import { dirname } from 'path';
import type { HookDefinition, HookChain, HookEvent, HookResult } from './types.ts';
import { matchesEventPath, matchesMatcher } from './matcher.ts';
import { getHookPointContract } from './contracts.ts';
import { HookActivityTracker } from './activity.ts';
import { logger } from '../utils/logger.ts';
import type { HooksConfig } from './types.ts';
import type { AgentManager } from '../tools/agent/index.ts';
import type { ToolLLM } from '../config/tool-llm.ts';
import * as commandRunner from './runners/command.ts';
import * as promptRunner from './runners/prompt.ts';
import * as agentRunner from './runners/agent.ts';
import * as httpRunner from './runners/http.ts';
import * as tsRunner from './runners/typescript.ts';
import { fireTriggers } from '../workflow/trigger-executor.ts';
import type { TriggerManagerLike } from '../workflow/trigger-executor.ts';
import { summarizeError } from '../utils/error-display.ts';

type HookRunnerDeps = {
  readonly agentManager?: Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel'>;
  readonly toolLLM?: Pick<ToolLLM, 'chat'>;
  readonly projectRoot?: string;
};

/** Global timeout: if cumulative hook time exceeds this, skip remaining */
const GLOBAL_TIMEOUT_MS = 120_000;

function runHook(
  hook: HookDefinition,
  event: HookEvent,
  deps: HookRunnerDeps,
  hooksBaseDirectory: string | null,
): Promise<HookResult> {
  switch (hook.type) {
    case 'command': return commandRunner.run(hook, event);
    case 'prompt': return promptRunner.run(hook, event, deps.toolLLM ?? null);
    case 'agent':
      if (!deps.agentManager) {
        return Promise.resolve({ ok: false, error: 'agent hook runner is not configured in this runtime' });
      }
      return agentRunner.run(hook, event, deps.agentManager);
    case 'http': return httpRunner.run(hook, event);
    case 'ts': {
      const projectRoot = deps.projectRoot ?? hooksBaseDirectory;
      if (!projectRoot) {
        return Promise.resolve({ ok: false, error: 'ts hook runner requires an explicit project root' });
      }
      return tsRunner.run(hook, event, projectRoot);
    }
    default:
      return Promise.resolve({ ok: false, error: `unknown hook type: ${(hook as HookDefinition).type}` });
  }
}

export class HookDispatcher {
  private hooks = new Map<string, HookDefinition[]>();
  private chains: HookChain[] = [];
  private triggerManager: TriggerManagerLike | null = null;
  private hooksBaseDirectory: string | null = null;
  private readonly runnerDeps: HookRunnerDeps;
  private readonly activityTracker: HookActivityTracker;

  constructor(runnerDeps: HookRunnerDeps = {}, activityTracker: HookActivityTracker = new HookActivityTracker()) {
    this.runnerDeps = runnerDeps;
    this.activityTracker = activityTracker;
  }

  /** Attach a TriggerManager so hook events automatically fire matching triggers. */
  setTriggerManager(tm: TriggerManagerLike | null): void {
    this.triggerManager = tm;
  }

  /** Load hooks from hooks.json file */
  loadFromFile(filePath: string): void {
    this.hooksBaseDirectory = dirname(filePath);
    try {
      // Warn if hooks.json is world-writable — it is a trust boundary.
      try {
        const st = statSync(filePath);
        // st.mode & 0o002 is the world-writable bit
        if ((st.mode & 0o002) !== 0) {
          logger.info(
            'HookDispatcher: hooks.json is world-writable — only load trusted hooks files',
            { filePath },
          );
        }
      } catch {
        // Stat failure is non-fatal; proceed with load
      }

      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      const VALID_HOOK_TYPES = new Set(['command', 'prompt', 'agent', 'http', 'ts']);

      // Validate and load hooks
      if (parsed.hooks !== undefined) {
        if (typeof parsed.hooks !== 'object' || parsed.hooks === null || Array.isArray(parsed.hooks)) {
          logger.info('HookDispatcher: hooks.json "hooks" field must be an object, skipping', { filePath });
        } else {
          for (const [pattern, defs] of Object.entries(parsed.hooks as Record<string, unknown>)) {
            if (!Array.isArray(defs)) {
              logger.info('HookDispatcher: hook pattern value must be an array, skipping', { filePath, pattern });
              continue;
            }
            for (const def of defs as unknown[]) {
              if (typeof def !== 'object' || def === null) {
                logger.info('HookDispatcher: hook definition must be an object, skipping', { filePath, pattern });
                continue;
              }
              const d = def as Record<string, unknown>;
              if (typeof d.type !== 'string' || !VALID_HOOK_TYPES.has(d.type)) {
                logger.info('HookDispatcher: hook missing valid "type" field, skipping', { filePath, pattern, type: d.type });
                continue;
              }
              if (typeof d.match !== 'string') {
                logger.info('HookDispatcher: hook missing "match" field, skipping', { filePath, pattern });
                continue;
              }
              this.register(pattern, d as unknown as import('./types.ts').HookDefinition);
            }
          }
        }
      }

      // Validate and load chains
      if (parsed.chains !== undefined) {
        if (!Array.isArray(parsed.chains)) {
          logger.info('HookDispatcher: hooks.json "chains" field must be an array, skipping', { filePath });
        } else {
          for (const chain of parsed.chains as unknown[]) {
            if (typeof chain !== 'object' || chain === null) {
              logger.info('HookDispatcher: chain entry must be an object, skipping', { filePath });
              continue;
            }
            const c = chain as Record<string, unknown>;
            if (typeof c.name !== 'string') {
              logger.info('HookDispatcher: chain missing "name" field, skipping', { filePath });
              continue;
            }
            if (!Array.isArray(c.steps)) {
              logger.info('HookDispatcher: chain missing "steps" array, skipping', { filePath, name: c.name });
              continue;
            }
            if (typeof c.action !== 'object' || c.action === null) {
              logger.info('HookDispatcher: chain missing "action" object, skipping', { filePath, name: c.name });
              continue;
            }
            const action = c.action as Record<string, unknown>;
            if (typeof action.type !== 'string' || !VALID_HOOK_TYPES.has(action.type)) {
              logger.info('HookDispatcher: chain action missing valid "type" field, skipping', { filePath, name: c.name });
              continue;
            }
            if (typeof action.match !== 'string') {
              logger.info('HookDispatcher: chain action missing "match" field, skipping', { filePath, name: c.name });
              continue;
            }
            this.registerChain(c as unknown as import('./types.ts').HookChain);
          }
        }
      }
    } catch (err) {
      logger.error('HookDispatcher: failed to load hooks file', {
        filePath,
        error: summarizeError(err),
      });
    }
  }

  /** Register a hook programmatically */
  register(eventPattern: string, hook: HookDefinition): void {
    const existing = this.hooks.get(eventPattern);
    if (existing) {
      existing.push(hook);
    } else {
      this.hooks.set(eventPattern, [hook]);
    }
  }

  /** Register a chain programmatically */
  registerChain(chain: HookChain): void {
    this.chains.push(chain);
  }

  /**
   * Fire an event and run all matching hooks.
   *
   * All matching hooks run sequentially. For Pre phase, the first deny sets
   * the aggregated decision; subsequent hooks still execute (for
   * logging/auditing) but their deny decisions don't change the outcome.
   * For all hooks: additionalContext strings are concatenated.
   * Once hooks are auto-removed after first execution.
   * Async hooks fire and forget.
   */
  async fire(event: HookEvent): Promise<HookResult> {
    const contract = getHookPointContract(event.path);
    const matchingEntries: Array<{ pattern: string; hook: HookDefinition }> = [];

    for (const [pattern, defs] of this.hooks.entries()) {
      if (matchesEventPath(pattern, event.path)) {
        for (const hook of defs) {
          const specificValue = event.specific;
          if (matchesMatcher(hook.matcher, specificValue)) {
            matchingEntries.push({ pattern, hook });
          }
        }
      }
    }

    if (matchingEntries.length === 0) {
      return { ok: true };
    }

    const aggregated: HookResult = { ok: true };
    const contextParts: string[] = [];
    let updatedInput: Record<string, unknown> | undefined;
    const onceToRemove: Array<{ pattern: string; hook: HookDefinition }> = [];
    const startTime = Date.now();

    for (const { pattern, hook } of matchingEntries) {
      // Global timeout check
      if (Date.now() - startTime > GLOBAL_TIMEOUT_MS) {
        logger.error('HookDispatcher: global timeout exceeded, skipping remaining hooks', {
          path: event.path,
        });
        break;
      }

      // Async hooks fire and forget
      if (hook.async) {
        const asyncStart = Date.now();
        runHook(hook, event, this.runnerDeps, this.hooksBaseDirectory)
          .then((result) => {
            this.activityTracker.record(event, {
              pattern,
              hookName: hook.name,
              hookType: hook.type,
              result,
              durationMs: Date.now() - asyncStart,
              async: true,
            });
          })
          .catch((err) => {
            const message = summarizeError(err);
            logger.error('HookDispatcher: async hook error', {
              path: event.path,
              error: message,
            });
            this.activityTracker.record(event, {
              pattern,
              hookName: hook.name,
              hookType: hook.type,
              result: { ok: false, error: message },
              durationMs: Date.now() - asyncStart,
              async: true,
            });
          });
        if (hook.once) onceToRemove.push({ pattern, hook });
        continue;
      }

      let result: HookResult;
      const hookStart = Date.now();
      try {
        result = await runHook(hook, event, this.runnerDeps, this.hooksBaseDirectory);
      } catch (err) {
        const message = summarizeError(err);
        logger.error('HookDispatcher: hook threw unexpectedly', {
          path: event.path,
          error: message,
        });
        result = { ok: false, error: message };
      }
      this.activityTracker.record(event, {
        pattern,
        hookName: hook.name,
        hookType: hook.type,
        result,
        durationMs: Date.now() - hookStart,
        async: false,
      });

      if (hook.once) onceToRemove.push({ pattern, hook });

      if (!result.ok) {
        aggregated.ok = false;
        if (!aggregated.error) aggregated.error = result.error;
      }

      // For Pre hooks: first deny wins
      if ((contract?.canDeny ?? event.phase === 'Pre') && result.decision === 'deny') {
        if (aggregated.decision !== 'deny') {
          aggregated.decision = 'deny';
          aggregated.reason = result.reason;
        }
      } else if (result.decision && (contract?.canDeny ?? event.phase === 'Pre') && aggregated.decision !== 'deny') {
        aggregated.decision = result.decision;
        if (result.reason) aggregated.reason = result.reason;
      }

      // Last updatedInput wins
      if (result.updatedInput && (contract?.canMutateInput ?? true)) {
        updatedInput = result.updatedInput;
      }

      if (result.additionalContext && (contract?.canInjectContext ?? true)) {
        contextParts.push(result.additionalContext);
      }
    }

    // Remove once hooks
    for (const { pattern, hook } of onceToRemove) {
      const defs = this.hooks.get(pattern);
      if (defs) {
        const idx = defs.indexOf(hook);
        if (idx !== -1) defs.splice(idx, 1);
        if (defs.length === 0) this.hooks.delete(pattern);
      }
    }

    if (updatedInput) aggregated.updatedInput = updatedInput;
    if (contextParts.length > 0) aggregated.additionalContext = contextParts.join('\n');

    // Fire matching triggers (fire-and-forget)
    if (this.triggerManager) {
      fireTriggers(event, this.triggerManager).catch((err) => {
        logger.debug('HookDispatcher: trigger fire error', {
          path: event.path,
          error: summarizeError(err),
        });
      });
    }

    return aggregated;
  }

  /** Get all registered hooks (for debugging/inspection) */
  getHooks(): Map<string, HookDefinition[]> {
    return new Map(this.hooks);
  }

  /** Get all registered chains */
  getChains(): HookChain[] {
    return [...this.chains];
  }

  /** Remove all hooks (for testing) */
  clear(): void {
    this.hooks.clear();
    this.chains = [];
  }

  /**
   * List all registered hooks as a flat array with their event pattern included.
   */
  listHooks(): Array<{ pattern: string; hook: HookDefinition }> {
    const result: Array<{ pattern: string; hook: HookDefinition }> = [];
    for (const [pattern, defs] of this.hooks.entries()) {
      for (const hook of defs) {
        result.push({ pattern, hook });
      }
    }
    return result;
  }

  /**
   * Enable a named hook (sets enabled: true).
   * Returns true if found, false if no hook with that name exists.
   */
  enableHook(name: string): boolean {
    for (const defs of this.hooks.values()) {
      for (const hook of defs) {
        if (hook.name === name) {
          hook.enabled = true;
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Disable a named hook (sets enabled: false).
   * Returns true if found, false if no hook with that name exists.
   */
  disableHook(name: string): boolean {
    for (const defs of this.hooks.values()) {
      for (const hook of defs) {
        if (hook.name === name) {
          hook.enabled = false;
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Remove a named hook from the registry.
   * Returns true if removed, false if not found.
   */
  unregister(name: string): boolean {
    for (const [pattern, defs] of this.hooks.entries()) {
      const idx = defs.findIndex((h) => h.name === name);
      if (idx !== -1) {
        defs.splice(idx, 1);
        if (defs.length === 0) this.hooks.delete(pattern);
        return true;
      }
    }
    return false;
  }
}
