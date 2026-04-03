/**
 * Shell AST types for compound command parsing (GC-EXEC-005).
 *
 * Represents the structural tree of a compound shell command after parsing.
 * The tree preserves operator relationships between segments so that per-segment
 * policy evaluation has full structural context.
 *
 * Node hierarchy:
 *   ShellNode = CommandNode | PipeNode | SequenceNode | SubshellNode
 *
 * @module normalization/ast
 */

import type { CommandToken } from './types.ts';

// ── Node discriminants ─────────────────────────────────────────────────────────

/**
 * A leaf node: a single simple command with its parsed tokens.
 */
export interface CommandNode {
  /** Discriminant. */
  kind: 'command';
  /** The raw source substring for this command. */
  raw: string;
  /** Ordered tokens belonging to this command. */
  tokens: CommandToken[];
  /** Canonical command name (first token, path-stripped). */
  command: string;
  /** Positional arguments. */
  args: string[];
  /** Flags and options. */
  flags: string[];
  /**
   * Set when the parser encountered an error and fell back to a flat CommandNode.
   * Useful for debug-level diagnostics; not set on successful parses.
   */
  parseError?: string;
}

/**
 * A pipe expression: left | right.
 * Both sides may themselves be compound nodes.
 */
export interface PipeNode {
  /** Discriminant. */
  kind: 'pipe';
  /** Left-hand side of the pipe. */
  left: ShellNode;
  /** Right-hand side of the pipe. */
  right: ShellNode;
}

/**
 * A sequence expression: left OP right, where OP is &&, || or ;.
 */
export interface SequenceNode {
  /** Discriminant. */
  kind: 'sequence';
  /** The operator connecting left and right. */
  operator: '&&' | '||' | ';';
  /** Left-hand operand. */
  left: ShellNode;
  /** Right-hand operand. */
  right: ShellNode;
}

/**
 * A subshell expression: $(…) or `…`.
 * The inner content is stored as a raw string and optionally parsed.
 */
export interface SubshellNode {
  /** Discriminant. */
  kind: 'subshell';
  /** Raw subshell expression (including delimiters). */
  raw: string;
  /**
   * Parsed inner tree, if the subshell content could be parsed.
   * May be undefined for complex or unparseable subshell content.
   */
  inner?: ShellNode;
}

/** Discriminated union of all shell AST node types. */
export type ShellNode = CommandNode | PipeNode | SequenceNode | SubshellNode;

// ── AST utilities ──────────────────────────────────────────────────────────────

/**
 * Collects all CommandNode leaves from a ShellNode tree in left-to-right order.
 *
 * @param node - The root node to traverse.
 * @returns Ordered list of CommandNode leaves.
 */
export function collectCommandNodes(node: ShellNode, acc: CommandNode[] = []): CommandNode[] {
  switch (node.kind) {
    case 'command':
      acc.push(node);
      return acc;
    case 'pipe':
      collectCommandNodes(node.left, acc);
      collectCommandNodes(node.right, acc);
      return acc;
    case 'sequence':
      collectCommandNodes(node.left, acc);
      collectCommandNodes(node.right, acc);
      return acc;
    case 'subshell':
      if (node.inner) collectCommandNodes(node.inner, acc);
      return acc;
  }
}

/**
 * Returns the operator chain connecting a node to its siblings, for display
 * in denial messages.
 *
 * @param node - The node to describe.
 * @returns A human-readable description of the node kind.
 */
export function describeNode(node: ShellNode): string {
  switch (node.kind) {
    case 'command':  return `command(${node.command})`;
    case 'pipe':     return `pipe(${describeNode(node.left)} | ${describeNode(node.right)})`;
    case 'sequence': return `sequence(${describeNode(node.left)} ${node.operator} ${describeNode(node.right)})`;
    case 'subshell': return `subshell(${node.raw})`;
  }
}
