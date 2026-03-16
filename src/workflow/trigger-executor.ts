import { logger } from '../utils/logger.ts';
import type { HookEvent } from '../hooks/types.ts';
import type { TriggerDefinition } from '../tools/workflow/index.ts';
import { matchesEventPath } from '../hooks/matcher.ts';

// ---------------------------------------------------------------------------
// TriggerExecutor
// ---------------------------------------------------------------------------
// Evaluates trigger conditions and executes actions when a hook event fires.
// Kept decoupled from HookDispatcher to avoid circular imports.
// ---------------------------------------------------------------------------

export interface TriggerManagerLike {
  list(): TriggerDefinition[];
}

/**
 * Result of a single trigger evaluation.
 */
export interface TriggerFireResult {
  triggerId: string;
  event: string;
  action: string;
  executed: boolean;
  error?: string;
  pid?: number;
}

/**
 * Evaluate all enabled triggers against a fired hook event.
 * Matching triggers have their action executed via Bun.spawn.
 */
export async function fireTriggers(
  event: HookEvent,
  triggerManager: TriggerManagerLike,
): Promise<TriggerFireResult[]> {
  const results: TriggerFireResult[] = [];
  const triggers = triggerManager.list().filter((t) => t.enabled);

  for (const trigger of triggers) {
    if (!matchesEventPath(trigger.event, event.path)) continue;

    // Optional JS-expression condition guard
    if (trigger.condition) {
      const passed = evaluateCondition(trigger.condition, event);
      if (!passed) {
        results.push({
          triggerId: trigger.id,
          event: trigger.event,
          action: trigger.action,
          executed: false,
        });
        continue;
      }
    }

    // Execute the action
    const fireResult = await executeAction(trigger, event);
    results.push(fireResult);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely evaluate a simple boolean condition string.
 * The condition has access to `event` and `payload` (alias for event.data).
 * Returns true if the condition throws or is not a boolean.
 */
function evaluateCondition(condition: string, event: HookEvent): boolean {
  try {
    // Build a minimal sandbox — Function constructor, no node globals
    // eslint-disable-next-line no-new-func
    const fn = new Function('event', 'payload', `return !!(${condition})`);
    const result = fn(event, event.payload ?? {});
    return Boolean(result);
  } catch (err) {
    logger.debug('TriggerExecutor: condition evaluation error', {
      condition,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Execute a trigger action command via Bun.spawn (fire-and-forget with PID tracking).
 */
async function executeAction(
  trigger: TriggerDefinition,
  event: HookEvent,
): Promise<TriggerFireResult> {
  const base: Omit<TriggerFireResult, 'executed'> = {
    triggerId: trigger.id,
    event: trigger.event,
    action: trigger.action,
  };

  // Parse the action string as a shell command
  const parts = trigger.action.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { ...base, executed: false, error: 'Empty action command' };
  }

  try {
    const proc = Bun.spawn(parts, {
      env: {
        ...process.env,
        GV_TRIGGER_ID: trigger.id,
        GV_TRIGGER_EVENT: event.path,
        GV_TRIGGER_PHASE: event.phase,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    // Fire-and-forget: don't await full completion
    proc.exited.catch((err) => {
      logger.debug('TriggerExecutor: action process error', {
        triggerId: trigger.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const pid = proc.pid;
    logger.debug('TriggerExecutor: action spawned', { triggerId: trigger.id, pid, action: trigger.action });
    return { ...base, executed: true, pid };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug('TriggerExecutor: failed to spawn action', { triggerId: trigger.id, error: message });
    return { ...base, executed: false, error: message };
  }
}
