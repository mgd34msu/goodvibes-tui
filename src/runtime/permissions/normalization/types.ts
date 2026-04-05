/**
 * Command normalization types for the runtime permissions pipeline.
 *
 * Defines the token, segment, classification, and normalized command
 * types used throughout the command normalization pipeline.
 */

/**
 * A single lexical token parsed from a shell command string.
 */
export interface CommandToken {
  /** The raw string value of this token. */
  value: string;
  /** Semantic role of the token within the command. */
  type:
    | 'command'
    | 'argument'
    | 'flag'
    | 'operator'
    | 'path'
    | 'redirect'
    | 'pipe'
    | 'subshell';
  /** Zero-based character offset in the original command string. */
  position: number;
}

/**
 * A single command segment produced by splitting a compound command
 * on shell operators (&&, ||, ;, |).
 */
export interface CommandSegment {
  /** The raw, unsplit substring for this segment. */
  raw: string;
  /** Ordered list of tokens parsed from this segment. */
  tokens: CommandToken[];
  /** The resolved canonical command name (first token, path-stripped). */
  command: string;
  /** Positional arguments (tokens of type 'argument'). */
  args: string[];
  /** Flags and options (tokens of type 'flag'). */
  flags: string[];
  /**
   * The operator that joins this segment to the NEXT one, if any.
   * Undefined for the last segment in a compound command.
   */
  operator?: '&&' | '||' | ';' | '|';
}

/**
 * The risk classification tier for a command or command segment.
 *
 * Priority order (highest to lowest): destructive > escalation > network > write > read.
 */
export type CommandClassification =
  | 'read'
  | 'write'
  | 'network'
  | 'destructive'
  | 'escalation';

/**
 * The fully normalised representation of a shell command string,
 * including all segments, classifications, and dangerous-pattern analysis.
 */
export interface NormalizedCommand {
  /** The original, unmodified command string. */
  original: string;
  /** Ordered list of command segments (split on &&, ||, ;, |). */
  segments: CommandSegment[];
  /** All unique classifications found across all segments. */
  classifications: CommandClassification[];
  /** The highest-risk classification among all segments. */
  highestClassification: CommandClassification;
  /** True if any dangerous patterns were detected. */
  hasDangerousPatterns: boolean;
  /** Descriptions of each dangerous pattern detected, if any. */
  dangerousPatterns?: string[];
}
