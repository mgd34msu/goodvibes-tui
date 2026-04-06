/** Represents a tool the LLM can invoke. Parameters follow JSON Schema. */
export type ToolSideEffect =
  | 'read_fs'
  | 'write_fs'
  | 'network'
  | 'exec'
  | 'agent'
  | 'workflow'
  | 'state';

export type ToolConcurrencyMode = 'serial' | 'parallel' | 'singleton';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Side effects the tool may perform when executed successfully. */
  sideEffects?: readonly ToolSideEffect[];
  /** Whether multiple calls can safely run in parallel. */
  concurrency?: ToolConcurrencyMode;
  /** Whether the tool can emit meaningful progress before final completion. */
  supportsProgress?: boolean;
  /** Whether results may be streamed or delivered incrementally. */
  supportsStreamingOutput?: boolean;
}

/** A tool invocation requested by the LLM. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** The outcome of executing a tool. */
export interface ToolResult {
  callId: string;
  success: boolean;
  output?: string;
  error?: string;
}

/** A registered tool with its definition and executor. */
export interface Tool {
  definition: ToolDefinition;
  /** Tools return a result without callId — the registry injects callId when wrapping. */
  execute(args: Record<string, unknown>): Promise<Omit<ToolResult, 'callId'>>;
}
