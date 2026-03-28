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

// ---------------------------------------------------------------------------
// Safe condition evaluator — no eval() or new Function()
// ---------------------------------------------------------------------------
//
// Supports a restricted expression language for trigger conditions.
// Operators: === !== == != > < >= <= && || ! (parentheses)
// Operands: dotted property paths on `event` or `payload`, string literals,
//           number literals, boolean literals (true/false/null/undefined).
//
// Examples:
//   event.phase === 'Post'
//   payload.tool === 'exec' && event.category !== 'system'
//   !payload.skipped

type ConditionValue = string | number | boolean | null | undefined;

function resolvePath(root: Record<string, unknown>, path: string): ConditionValue {
  const parts = path.split('.');
  let cur: unknown = root;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (cur === null) return null;
  if (cur === undefined) return undefined;
  if (typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean') return cur;
  return String(cur);
}

/** Tokenise a condition string into an array of tokens. */
function tokenise(condition: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < condition.length) {
    // Skip whitespace
    if (/\s/.test(condition[i])) { i++; continue; }

    // String literals
    if (condition[i] === '"' || condition[i] === "'") {
      const quote = condition[i];
      let j = i + 1;
      while (j < condition.length && condition[j] !== quote) {
        if (condition[j] === '\\') j++; // skip escape
        j++;
      }
      tokens.push(condition.slice(i, j + 1));
      i = j + 1;
      continue;
    }

    // Multi-char operators
    const twoChar = condition.slice(i, i + 2);
    if (['===', '!=='].includes(condition.slice(i, i + 3))) {
      tokens.push(condition.slice(i, i + 3)); i += 3; continue;
    }
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(twoChar)) {
      tokens.push(twoChar); i += 2; continue;
    }

    // Single-char operators / parens
    if ('!><()'.includes(condition[i])) {
      tokens.push(condition[i]); i++; continue;
    }

    // Numbers
    if (/[0-9]/.test(condition[i]) || (condition[i] === '-' && /[0-9]/.test(condition[i + 1] ?? ''))) {
      let j = i;
      if (condition[j] === '-') j++;
      while (j < condition.length && /[0-9.]/.test(condition[j])) j++;
      tokens.push(condition.slice(i, j)); i = j; continue;
    }

    // Identifiers (including dotted paths and keywords)
    if (/[a-zA-Z_$]/.test(condition[i])) {
      let j = i;
      while (j < condition.length && /[a-zA-Z0-9_.$]/.test(condition[j])) j++;
      tokens.push(condition.slice(i, j)); i = j; continue;
    }

    // Unknown character — abort
    throw new Error(`Unexpected character '${condition[i]}' in condition`);
  }
  return tokens;
}

function parseValue(token: string, event: HookEvent): ConditionValue {
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (token === 'null') return null;
  if (token === 'undefined') return undefined;
  // String literal
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  // Number
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(token)) return Number(token);
  // Property path — only event.* and payload.*
  if (token.startsWith('event.')) {
    return resolvePath(event as unknown as Record<string, unknown>, token.slice(6));
  }
  if (token.startsWith('payload.')) {
    return resolvePath((event.payload ?? {}) as Record<string, unknown>, token.slice(8));
  }
  // Bare 'event' or 'payload'
  if (token === 'event') return JSON.stringify(event);
  if (token === 'payload') return JSON.stringify(event.payload ?? {});
  throw new Error(`Unrecognised token '${token}' in condition`);
}

/**
 * Recursive descent parser for the restricted condition language.
 * Grammar (simplified):
 *   expr   := or
 *   or     := and ('||' and)*
 *   and    := unary ('&&' unary)*
 *   unary  := '!' unary | compare
 *   compare:= atom (('==='|'!=='|'=='|'!='|'>'|'<'|'>='|'<=') atom)?
 *   atom   := '(' expr ')' | VALUE
 */
class ConditionParser {
  private pos = 0;
  constructor(private tokens: string[], private event: HookEvent) {}

  parse(): boolean {
    const result = this.parseOr();
    if (this.pos < this.tokens.length) {
      throw new Error(`Unexpected token '${this.tokens[this.pos]}' at position ${this.pos}`);
    }
    return Boolean(result);
  }

  private peek(): string | undefined { return this.tokens[this.pos]; }
  private consume(): string { return this.tokens[this.pos++]; }
  private match(t: string): boolean { if (this.peek() === t) { this.pos++; return true; } return false; }

  private parseOr(): ConditionValue {
    let left = this.parseAnd();
    while (this.peek() === '||') { this.consume(); const right = this.parseAnd(); left = Boolean(left) || Boolean(right); }
    return left;
  }

  private parseAnd(): ConditionValue {
    let left = this.parseUnary();
    while (this.peek() === '&&') { this.consume(); const right = this.parseUnary(); left = Boolean(left) && Boolean(right); }
    return left;
  }

  private parseUnary(): ConditionValue {
    if (this.peek() === '!') { this.consume(); return !Boolean(this.parseUnary()); }
    return this.parseCompare();
  }

  private parseCompare(): ConditionValue {
    const left = this.parseAtom();
    const op = this.peek();
    if (op && ['===', '!==', '==', '!=', '>', '<', '>=', '<='].includes(op)) {
      this.consume();
      const right = this.parseAtom();
      switch (op) {
        case '===': return left === right;
        case '!==': return left !== right;
        // eslint-disable-next-line eqeqeq
        case '==': return left == right;
        // eslint-disable-next-line eqeqeq
        case '!=': return left != right;
        case '>': return Number(left) > Number(right);
        case '<': return Number(left) < Number(right);
        case '>=': return Number(left) >= Number(right);
        case '<=': return Number(left) <= Number(right);
      }
    }
    return left;
  }

  private parseAtom(): ConditionValue {
    const t = this.peek();
    if (t === undefined) throw new Error('Unexpected end of condition');
    if (t === '(') {
      this.consume();
      const val = this.parseOr();
      if (!this.match(')')) throw new Error('Expected closing parenthesis');
      return val;
    }
    this.consume();
    return parseValue(t, this.event);
  }
}

/**
 * Safely evaluate a simple boolean condition string.
 * The condition has access to `event` and `payload` (alias for event.payload).
 * Uses a restricted expression parser — no eval() or new Function().
 * Returns false if the condition is invalid or throws.
 */
function evaluateCondition(condition: string, event: HookEvent): boolean {
  try {
    const tokens = tokenise(condition);
    if (tokens.length === 0) return true; // empty condition = always pass
    const parser = new ConditionParser(tokens, event);
    return parser.parse();
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
