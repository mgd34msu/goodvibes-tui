/**
 * Shell AST parser.
 *
 * Converts a flat CommandToken list into a ShellNode AST, preserving
 * operator relationships between segments (&&, ||, ;, |, subshells).
 *
 * Grammar (simplified, right-associative for simplicity):
 *
 *   compound := sequence
 *   sequence := pipe (('&&' | '||' | ';') pipe)*
 *   pipe     := atom ('|' atom)*
 *   atom     := subshell | command
 *
 * Obfuscation handling:
 *   - Backtick subshells (`cmd`) are extracted and recursively parsed.
 *   - $(...) subshells are extracted and recursively parsed.
 *   - Base64-like argument tokens are flagged for upper-layer analysis.
 *
 * @module normalization/parser
 */

import type { CommandToken } from './types.ts';
import type {
  ShellNode,
  CommandNode,
  PipeNode,
  SequenceNode,
  SubshellNode,
} from './ast.ts';
import { tokenize } from './tokenizer.ts';
import { canonicalize } from './canonicalizer.ts';

// ── Token stream helpers ────────────────────────────────────────────────────────

type TokenCursor = { tokens: CommandToken[]; pos: number };

function peek(cur: TokenCursor): CommandToken | undefined {
  return cur.tokens[cur.pos];
}

function consume(cur: TokenCursor): CommandToken | undefined {
  return cur.tokens[cur.pos++];
}

function isAtEnd(cur: TokenCursor): boolean {
  return cur.pos >= cur.tokens.length;
}

// ── Subshell extraction helpers ────────────────────────────────────────────────

/**
 * Extracts inner content from a backtick subshell token.
 * Input: "`cmd arg`" → Output: "cmd arg"
 */
function backtickInner(raw: string): string {
  if (raw.startsWith('`') && raw.endsWith('`') && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Extracts inner content from a $(...) subshell token.
 * Input: "$(cmd arg)" → Output: "cmd arg"
 */
function dollarParenInner(raw: string): string {
  if (raw.startsWith('$(') && raw.endsWith(')') && raw.length >= 3) {
    return raw.slice(2, -1);
  }
  return raw;
}

/**
 * Attempts to recursively parse a subshell expression.
 * Returns undefined if parsing fails or produces no nodes.
 */
function parseSubshellContent(raw: string): ShellNode | undefined {
  try {
    const inner = raw.startsWith('`') ? backtickInner(raw) : dollarParenInner(raw);
    if (!inner.trim()) return undefined;
    const tokens = tokenize(inner);
    if (tokens.length === 0) return undefined;
    const cursor: TokenCursor = { tokens, pos: 0 };
    return parseSequence(cursor);
  } catch {
    return undefined;
  }
}

// ── Recursive descent parser ──────────────────────────────────────────────────

/**
 * parseAtom — Parses a single atomic unit: a subshell or a simple command.
 *
 * When a subshell token appears as the FIRST token, returns a SubshellNode.
 * When a subshell token appears after other tokens (e.g. `rm \`echo /tmp\``),
 * the subshell is included in the command's token list so that the command
 * node (rm) is correctly preserved and the subshell content is detectable
 * for obfuscation analysis.
 */
function parseAtom(cur: TokenCursor): ShellNode {
  const tokens: CommandToken[] = [];

  while (!isAtEnd(cur)) {
    const t = peek(cur)!;

    // Stop at any compound operator boundary
    if (t.type === 'operator' || t.type === 'pipe') break;

    consume(cur);

    // Subshell tokens:
    // - If this is the first token (no prior command tokens), emit a SubshellNode.
    // - Otherwise, include the subshell token in the current command's token list
    //   so the command context (e.g. `rm`) is preserved for classification.
    if (t.type === 'subshell') {
      const hasCommandContext = tokens.some((tok) => tok.type === 'command');
      if (!hasCommandContext && tokens.length === 0) {
        const inner = parseSubshellContent(t.value);
        return { kind: 'subshell', raw: t.value, inner };
      }
      // Subshell used as argument to a command: include in token list
      tokens.push(t);
      continue;
    }

    tokens.push(t);
  }

  // Build a CommandNode from collected tokens
  return buildCommandNode(tokens);
}

/**
 * Builds a CommandNode from a list of tokens.
 */
function buildCommandNode(tokens: CommandToken[]): CommandNode {
  const commandToken = tokens.find((t) => t.type === 'command');
  const rawCommand = commandToken?.value ?? '';
  const command = canonicalize(rawCommand);

  const args = tokens.filter((t) => t.type === 'argument').map((t) => t.value);
  const flags = tokens.filter((t) => t.type === 'flag').map((t) => t.value);
  const raw = tokens.map((t) => t.value).join(' ');

  return { kind: 'command', raw, tokens, command, args, flags };
}

/**
 * parsePipe — Parses one or more atoms connected by pipe operators.
 */
function parsePipe(cur: TokenCursor): ShellNode {
  let left = parseAtom(cur);

  while (!isAtEnd(cur) && peek(cur)?.type === 'pipe' && peek(cur)?.value === '|') {
    consume(cur); // consume '|'
    const right = parseAtom(cur);
    const node: PipeNode = { kind: 'pipe', left, right };
    left = node;
  }

  return left;
}

/**
 * parseSequence — Parses one or more pipe expressions connected by &&, || or ;.
 */
function parseSequence(cur: TokenCursor): ShellNode {
  let left = parsePipe(cur);

  while (!isAtEnd(cur)) {
    const t = peek(cur);
    if (t?.type !== 'operator') break;
    if (t.value !== '&&' && t.value !== '||' && t.value !== ';') break;

    const operator = t.value as '&&' | '||' | ';';
    consume(cur); // consume operator
    const right = parsePipe(cur);
    const node: SequenceNode = { kind: 'sequence', operator, left, right };
    left = node;
  }

  return left;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Parses a flat CommandToken list into a ShellNode AST.
 *
 * Handles compound commands (pipes, &&, ||, ;) and subshell expressions.
 * Falls back to a single CommandNode if parsing encounters errors.
 *
 * @param tokens - The flat token list from the tokenizer.
 * @returns The root ShellNode of the parsed AST.
 */
export function parseAST(tokens: CommandToken[]): ShellNode {
  if (tokens.length === 0) {
    return { kind: 'command', raw: '', tokens: [], command: '', args: [], flags: [] };
  }

  const cursor: TokenCursor = { tokens, pos: 0 };
  try {
    return parseSequence(cursor);
  } catch (err) {
    // Fall back to a flat command node on parse error
    const node = buildCommandNode(tokens);
    node.parseError = err instanceof Error ? err.message : 'Unknown parse error';
    return node;
  }
}

/**
 * Parses a raw shell command string into a ShellNode AST.
 *
 * Convenience wrapper: tokenizes and parses in one step.
 *
 * @param command - The raw shell command string.
 * @returns The root ShellNode of the parsed AST.
 */
export function parseCommandAST(command: string): ShellNode {
  const tokens = tokenize(command.trim());
  return parseAST(tokens);
}
