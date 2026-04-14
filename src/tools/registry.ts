import type { Tool, ToolDefinition, ToolResult } from '../types/tools.ts';
import { ToolError } from '../types/errors.ts';
import { repairToolCall } from './auto-repair.ts';
import { ToolContractVerifier } from '../runtime/tools/contract-verifier.ts';
import type { ContractVerificationResult, ContractVerifierOptions } from '../runtime/tools/contract-verifier.ts';
import { summarizeError } from '../utils/error-display.ts';

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

  /**
   * Register a tool after running contract verification.
   *
   * If verification finds error-level violations the tool is NOT registered
   * and an error is thrown listing all violations. This implements "fail closed"
   * semantics: invalid tools cannot enter the registry.
   *
   * Warn-level violations are collected and returned so callers can surface them
   * without blocking registration.
   *
   * @param tool    - The tool to register.
   * @param opts    - Optional verifier options (strictness overrides).
   * @returns The full ContractVerificationResult so callers can inspect warnings.
   * @throws If the tool has any error-level contract violations.
   */
  registerWithContract(
    tool: Tool,
    opts?: ContractVerifierOptions,
  ): ContractVerificationResult {
    const verifier = new ToolContractVerifier(opts);
    const result = verifier.verify(tool);

    if (!result.passed) {
      const errors = result.violations
        .filter((v) => v.severity === 'error')
        .map((v) => `  [${v.dimension}] ${v.message}`);
      throw new Error(
        `Tool '${tool.definition.name}' failed contract verification:\n${errors.join('\n')}`,
      );
    }

    this.register(tool);
    return result;
  }

  /**
   * Run contract verification on a single registered tool without re-registering.
   *
   * @param name - The tool name to verify.
   * @param opts - Optional verifier options.
   * @returns The verification result, or undefined if the tool is not registered.
   */
  verifyContract(
    name: string,
    opts?: ContractVerifierOptions,
  ): ContractVerificationResult | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    const verifier = new ToolContractVerifier(opts);
    return verifier.verify(tool);
  }

  /**
   * Run contract verification on all registered tools.
   *
   * @param opts - Optional verifier options.
   * @returns Map of tool name → ContractVerificationResult for every registered tool.
   */
  verifyAllContracts(
    opts?: ContractVerifierOptions,
  ): Map<string, ContractVerificationResult> {
    const verifier = new ToolContractVerifier(opts);
    return verifier.verifyAll(this.list());
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
      // Attempt to repair malformed args before execution.
      // Premium models that send correct calls pass through unchanged.
      const repairResult = repairToolCall(name, args, tool.definition);
      const effectiveArgs = repairResult.repaired ? repairResult.fixed : args;

      const result = await tool.execute(effectiveArgs);
      // Tool.execute returns ToolResult without callId — inject it here
      const toolResult = { ...result, callId };

      // Surface repairs to the LLM so it knows what was auto-fixed
      if (repairResult.repaired) {
        const repairNote = `[Auto-repaired: ${repairResult.repairs.join(', ')}]`;
        if (typeof toolResult.output === 'string') {
          toolResult.output = `${repairNote}\n${toolResult.output}`;
        } else {
          toolResult.output = repairNote;
        }
      }

      return toolResult;
    } catch (err) {
      const message = summarizeError(err);
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
