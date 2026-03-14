/** Represents a tool the LLM can invoke. Parameters follow JSON Schema. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
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
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}
