import type { HookChain, HookEvent, HookResult, ChainStep } from './types.ts';
import type { HookDispatcher } from './dispatcher.ts';
import { matchesEventPath } from './matcher.ts';
import { logger } from '../utils/logger.ts';
import { summarizeError } from '../utils/error-display.ts';

/** Parse a duration string like "30s" or "5m" into milliseconds */
function parseDuration(s: string): number {
  const match = s.match(/^(\d+(\.\d+)?)(s|m|ms)$/);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[3];
  if (unit === 'ms') return value;
  if (unit === 's') return value * 1000;
  if (unit === 'm') return value * 60_000;
  return 0;
}

/**
 * Tokenizer for the safe expression evaluator.
 * Produces a flat list of tokens from the condition string.
 */
type Token =
  | { kind: 'ident'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'undefined' }
  | { kind: 'op'; value: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'dot' }
  | { kind: 'bang' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i])) { i++; continue; }
    // String literals (single or double quoted)
    if (input[i] === '\'' || input[i] === '"') {
      const quote = input[i++];
      let s = '';
      while (i < input.length && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < input.length) { i++; }
        s += input[i++];
      }
      i++; // closing quote
      tokens.push({ kind: 'string', value: s });
      continue;
    }
    // Numbers
    if (/[0-9]/.test(input[i]) || (input[i] === '-' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let n = '';
      if (input[i] === '-') n += input[i++];
      while (i < input.length && /[0-9.]/.test(input[i])) n += input[i++];
      tokens.push({ kind: 'number', value: parseFloat(n) });
      continue;
    }
    // Operators: ===, !==, >=, <=, >, <, &&, ||
    if (input.startsWith('===', i)) { tokens.push({ kind: 'op', value: '===' }); i += 3; continue; }
    if (input.startsWith('!==', i)) { tokens.push({ kind: 'op', value: '!==' }); i += 3; continue; }
    if (input.startsWith('>=', i)) { tokens.push({ kind: 'op', value: '>=' }); i += 2; continue; }
    if (input.startsWith('<=', i)) { tokens.push({ kind: 'op', value: '<=' }); i += 2; continue; }
    if (input.startsWith('&&', i)) { tokens.push({ kind: 'op', value: '&&' }); i += 2; continue; }
    if (input.startsWith('||', i)) { tokens.push({ kind: 'op', value: '||' }); i += 2; continue; }
    if (input[i] === '>') { tokens.push({ kind: 'op', value: '>' }); i++; continue; }
    if (input[i] === '<') { tokens.push({ kind: 'op', value: '<' }); i++; continue; }
    if (input[i] === '!') { tokens.push({ kind: 'bang' }); i++; continue; }
    if (input[i] === '(') { tokens.push({ kind: 'lparen' }); i++; continue; }
    if (input[i] === ')') { tokens.push({ kind: 'rparen' }); i++; continue; }
    if (input[i] === '.') { tokens.push({ kind: 'dot' }); i++; continue; }
    // Identifiers and keywords
    if (/[a-zA-Z_$]/.test(input[i])) {
      let id = '';
      while (i < input.length && /[a-zA-Z0-9_$]/.test(input[i])) id += input[i++];
      if (id === 'true') tokens.push({ kind: 'bool', value: true });
      else if (id === 'false') tokens.push({ kind: 'bool', value: false });
      else if (id === 'null') tokens.push({ kind: 'null' });
      else if (id === 'undefined') tokens.push({ kind: 'undefined' });
      else tokens.push({ kind: 'ident', value: id });
      continue;
    }
    // Unknown character — skip (will surface as parse error)
    i++;
  }
  return tokens;
}

/**
 * Evaluate a safe condition expression against a context object.
 *
 * Allowed syntax:
 *   - Property access on context: `message`, `count`, `status`
 *   - Dot-chained property access: `event.type`
 *   - Comparison operators: `===`, `!==`, `>`, `<`, `>=`, `<=`
 *   - Logical operators: `&&`, `||`
 *   - Unary negation: `!expr`
 *   - String methods: `.startsWith()`, `.endsWith()`, `.includes()`
 *   - Literals: strings, numbers, booleans, null, undefined
 *   - Grouping: `(expr)`
 *
 * Does NOT use `eval`, `new Function`, or `vm.runInNewContext`.
 * Any expression that references identifiers not in the context, or
 * uses unsupported constructs, evaluates to false.
 */
/** @internal — used directly by safe-evaluate.test.ts; not part of public API. */
export function safeEvaluate(condition: string, context: Record<string, unknown>): boolean {
  const tokens = tokenize(condition);
  let pos = 0;

  function peek(): Token | undefined { return tokens[pos]; }
  function consume(): Token { return tokens[pos++]; }

  function parseExpr(): unknown { return parseOr(); }

  function parseOr(): unknown {
    let left = parseAnd();
    while (peek()?.kind === 'op' && (peek() as { value: string }).value === '||') {
      consume();
      const right = parseAnd();
      left = !!(left) || !!(right);
    }
    return left;
  }

  function parseAnd(): unknown {
    let left = parseComparison();
    while (peek()?.kind === 'op' && (peek() as { value: string }).value === '&&') {
      consume();
      const right = parseComparison();
      left = !!(left) && !!(right);
    }
    return left;
  }

  function parseComparison(): unknown {
    let left = parseUnary();
    const t = peek();
    if (t?.kind === 'op') {
      const op = (t as { value: string }).value;
      if (['===', '!==', '>', '<', '>=', '<='].includes(op)) {
        consume();
        const right = parseUnary();
        switch (op) {
          case '===': return left === right;
          case '!==': return left !== right;
          case '>':   return (left as number) > (right as number);
          case '<':   return (left as number) < (right as number);
          case '>=':  return (left as number) >= (right as number);
          case '<=':  return (left as number) <= (right as number);
        }
      }
    }
    return left;
  }

  function parseUnary(): unknown {
    if (peek()?.kind === 'bang') {
      consume();
      return !parseUnary();
    }
    return parsePostfix();
  }

  function parsePostfix(): unknown {
    let val = parsePrimary();
    // Handle dot-chained property access and allowed string methods
    while (peek()?.kind === 'dot') {
      consume(); // consume '.'
      const t = peek();
      if (!t || t.kind !== 'ident') break;
      const name = (t as { kind: 'ident'; value: string }).value;
      consume(); // consume method/property name
      // Check for method call syntax: .startsWith(...), .endsWith(...), .includes(...)
      if (peek()?.kind === 'lparen') {
        consume(); // '('
        const arg = parsePrimary();
        if (peek()?.kind === 'rparen') consume(); // ')'
        if (typeof val === 'string') {
          if (name === 'startsWith') { val = val.startsWith(String(arg)); continue; }
          if (name === 'endsWith') { val = val.endsWith(String(arg)); continue; }
          if (name === 'includes') { val = val.includes(String(arg)); continue; }
        }
        val = false;
      } else {
        // Property access
        if (val !== null && val !== undefined && typeof val === 'object') {
          val = (val as Record<string, unknown>)[name];
        } else {
          val = undefined;
        }
      }
    }
    return val;
  }

  function parsePrimary(): unknown {
    const t = peek();
    if (!t) return undefined;
    if (t.kind === 'lparen') {
      consume();
      const val = parseExpr();
      if (peek()?.kind === 'rparen') consume();
      return val;
    }
    if (t.kind === 'string') { consume(); return t.value; }
    if (t.kind === 'number') { consume(); return t.value; }
    if (t.kind === 'bool') { consume(); return t.value; }
    if (t.kind === 'null') { consume(); return null; }
    if (t.kind === 'undefined') { consume(); return undefined; }
    if (t.kind === 'ident') {
      consume();
      // Only allow access to keys present in context
      return Object.prototype.hasOwnProperty.call(context, t.value)
        ? context[t.value]
        : undefined;
    }
    return undefined;
  }

  try {
    return !!(parseExpr());
  } catch (err) {
    logger.error('ChainEngine: condition evaluation error', {
      condition,
      error: summarizeError(err),
    });
    return false;
  }
}

/** Internal alias used by the chain engine */
function evaluateCondition(condition: string, payload: Record<string, unknown>): boolean {
  return safeEvaluate(condition, payload);
}

interface ChainState {
  currentStep: number;
  captures: Record<string, string>;
  lastAdvance: number;
  /** Timer ID for debounce tracking */
  debounceTimer?: ReturnType<typeof setTimeout>;
  /** Pending debounce event */
  pendingDebounce?: HookEvent;
}

export class ChainEngine {
  private dispatcher: HookDispatcher;
  private chains: HookChain[] = [];
  private states = new Map<string, ChainState>();

  constructor(dispatcher: HookDispatcher) {
    this.dispatcher = dispatcher;
  }

  /** Register a chain and initialize its state */
  register(chain: HookChain): void {
    this.chains.push(chain);
    this.states.set(chain.name, {
      currentStep: 0,
      captures: {},
      lastAdvance: 0,
    });
  }

  /** Called after each event to advance matching chains */
  async evaluate(event: HookEvent): Promise<HookResult | null> {
    let result: HookResult | null = null;

    for (const chain of this.chains) {
      const state = this.states.get(chain.name);
      if (!state) continue;

      const step = chain.steps[state.currentStep] as ChainStep | undefined;
      if (!step) continue;

      // Check within timeout: if exceeded since last advance, reset
      if (step.within && state.lastAdvance > 0) {
        const withinMs = parseDuration(step.within);
        if (withinMs > 0 && Date.now() - state.lastAdvance > withinMs) {
          this._resetState(chain.name);
          // Re-check from step 0 with same event
          const freshState = this.states.get(chain.name)!;
          const freshStep = chain.steps[freshState.currentStep] as ChainStep | undefined;
          if (!freshStep || !matchesEventPath(freshStep.match, event.path)) continue;
        }
      }

      if (!matchesEventPath(step.match, event.path)) continue;

      // Evaluate condition if present
      if (step.condition) {
        if (!evaluateCondition(step.condition, event.payload)) continue;
      }

      // Handle debounce for optional steps
      if (step.debounce && step.optional) {
        const debounceMs = parseDuration(step.debounce);
        if (state.debounceTimer !== undefined) {
          clearTimeout(state.debounceTimer);
        }
        state.pendingDebounce = event;
        state.debounceTimer = setTimeout(async () => {
          try {
            state.debounceTimer = undefined;
            const pendingEvent = state.pendingDebounce;
            if (!pendingEvent) return;
            state.pendingDebounce = undefined;
            // Advance after debounce
            this._advanceState(chain, state, pendingEvent, step);
            // Check if chain is complete
            if (state.currentStep >= chain.steps.length) {
              try {
                await this.dispatcher.fire({
                  ...pendingEvent,
                  path: chain.action.match as unknown as import('./types.ts').HookEventPath,
                });
              } catch (err) {
                logger.error('ChainEngine: chain action error', {
                  chain: chain.name,
                  error: summarizeError(err),
                });
              }
              this._resetState(chain.name);
            }
          } catch (err) {
            logger.error('ChainEngine: debounce callback error', {
              chain: chain.name,
              error: summarizeError(err),
            });
          }
        }, debounceMs);
        continue;
      }

      // Advance step
      this._advanceState(chain, state, event, step);

      // Fire chain action if all steps complete
      if (state.currentStep >= chain.steps.length) {
        const actionEvent: HookEvent = {
          ...event,
          path: chain.action.match as unknown as import('./types.ts').HookEventPath,
        };
        try {
          result = await this.dispatcher.fire(actionEvent);
        } catch (err) {
          logger.error('ChainEngine: chain action error', {
            chain: chain.name,
            error: summarizeError(err),
          });
          result = { ok: false, error: summarizeError(err) };
        }
        this._resetState(chain.name);
      }
    }

    return result;
  }

  private _advanceState(chain: HookChain, state: ChainState, event: HookEvent, step: ChainStep): void {
    // Capture variables if specified
    if (step.capture) {
      for (const [varName, payloadKey] of Object.entries(step.capture)) {
        const val = event.payload[payloadKey];
        if (val !== undefined) {
          state.captures[varName] = String(val);
        }
      }
    }
    state.lastAdvance = Date.now();
    state.currentStep++;
  }

  private _resetState(chainName: string): void {
    const state = this.states.get(chainName);
    if (state?.debounceTimer !== undefined) {
      clearTimeout(state.debounceTimer);
    }
    this.states.set(chainName, {
      currentStep: 0,
      captures: {},
      lastAdvance: 0,
    });
  }

  /** Reset a specific chain */
  reset(chainName: string): void {
    this._resetState(chainName);
  }

  /** Reset all chains */
  resetAll(): void {
    for (const chain of this.chains) {
      this._resetState(chain.name);
    }
  }

  /** Get chain states for debugging */
  getStates(): Map<string, { currentStep: number; captures: Record<string, string>; lastAdvance: number }> {
    const result = new Map<string, { currentStep: number; captures: Record<string, string>; lastAdvance: number }>();
    for (const [name, state] of this.states.entries()) {
      result.set(name, {
        currentStep: state.currentStep,
        captures: { ...state.captures },
        lastAdvance: state.lastAdvance,
      });
    }
    return result;
  }
}
