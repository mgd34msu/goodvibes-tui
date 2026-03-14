import type { Tool, ToolDefinition, ToolResult } from '../types/tools.ts';
import { ToolError } from '../types/errors.ts';

/**
 * ToolRegistry - Central registry for all tools available to the LLM.
 * Manages registration, discovery, and execution of tools.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  /** Register a tool. Throws if a tool with the same name is already registered. */
  register(tool: Tool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`Tool '${tool.definition.name}' is already registered`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  /** Returns the ToolDefinition array formatted for LLM function calling. */
  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /** Execute a named tool with the given arguments. Wraps errors in ToolResult. */
  async execute(
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        callId,
        success: false,
        error: `Unknown tool: '${name}'`,
      };
    }

    try {
      const result = await tool.execute(args);
      // Tool.execute returns ToolResult without callId — inject it here
      return { ...result, callId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const toolErr = new ToolError(message, name);
      if (err instanceof Error) toolErr.cause = err;
      throw toolErr;
    }
  }

  /** Returns true if a tool with the given name is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Returns all registered tools. */
  list(): Tool[] {
    return Array.from(this.tools.values());
  }
}
