// TODO: import PhasedToolExecutor from './phased-executor.ts' when that module is available.
// TODO: import { FeatureFlagManager } from '../feature-flags/index.ts' when that module is available.
import type { ToolResult } from '../../types/tools.ts';
import type { ToolRuntimeContext } from './context.ts';
import { ToolRegistry } from '../../tools/registry.ts';
import type { ContractVerificationResult, ContractVerifierOptions } from './contract-verifier.ts';
import { ToolContractVerifier } from './contract-verifier.ts';

/**
 * Placeholder type for the phased executor.
 * Replace this import with the real type once phased-executor.ts is ready.
 *
 * Migration stubs — to be replaced when phased executor types are unified.
 *
 * @internal
 */
interface PhasedToolExecutor {
  execute(
    callId: string,
    name: string,
    args: Record<string, unknown>,
    context?: ToolRuntimeContext,
  ): Promise<ToolResult>;
}

/**
 * Placeholder type for the feature flag manager.
 * Replace this import with the real type once feature-flags/ is ready.
 *
 * Migration stubs — to be replaced when phased executor types are unified.
 *
 * @internal
 */
interface FeatureFlagManager {
  isEnabled(flag: string): boolean;
}

/** Feature flag that enables routing through the phased executor. */
const PHASED_EXECUTOR_FLAG = 'phased-tool-executor';

/**
 * ToolRegistryBridge routes tool execution through either the legacy ToolRegistry
 * or the new PhasedToolExecutor, selected at call-time via a feature flag.
 *
 * @remarks
 * This class is scaffolding for the phased executor migration. It will be wired
 * into the executor pipeline in Phase 8, at which point real imports replace
 * the stub interfaces above and this bridge becomes the active dispatch layer.
 *
 * This allows incremental migration: flip the flag on to route through the phased
 * executor; flip it off to fall back to the proven legacy path. Both paths remain
 * active in the binary — no code is removed during migration.
 *
 * ## Usage
 *
 * ```ts
 * const bridge = new ToolRegistryBridge(registry, phasedExecutor, flagManager);
 *
 * // Route a tool call — chooses phased or legacy based on feature flag:
 * const result = await bridge.execute(callId, 'read', args, { sessionId });
 * ```
 *
 * ## Migration path
 *
 * 1. Construct with both `legacy` and `phased` executors.
 * 2. Enable the `phased-tool-executor` flag in a canary / dev environment.
 * 3. Verify behaviour parity, then promote the flag to stable.
 * 4. Once fully promoted, callers can migrate to calling `phased.execute` directly
 *    and this bridge can be retired.
 */
export class ToolRegistryBridge {
  constructor(
    private readonly legacy: ToolRegistry,
    private readonly phased: PhasedToolExecutor,
    private readonly flags: FeatureFlagManager,
  ) {}

  /**
   * Execute a named tool, routing through the phased executor when the
   * `phased-tool-executor` feature flag is enabled, or the legacy ToolRegistry
   * otherwise.
   *
   * @param callId  - Unique identifier for this tool invocation.
   * @param name    - Registered tool name (must exist in both paths).
   * @param args    - Arguments forwarded to the tool's execute method.
   * @param context - Optional runtime context (used by phased path only).
   * @returns       The ToolResult produced by whichever path was selected.
   */
  async execute(
    callId: string,
    name: string,
    args: Record<string, unknown>,
    context?: ToolRuntimeContext,
  ): Promise<ToolResult> {
    if (this.flags.isEnabled(PHASED_EXECUTOR_FLAG)) {
      return this.phased.execute(callId, name, args, context);
    }
    return this.legacy.execute(callId, name, args);
  }

  /**
   * Returns true when tool calls are currently routing through the phased executor.
   * Useful for logging and diagnostics.
   */
  isPhasedEnabled(): boolean {
    return this.flags.isEnabled(PHASED_EXECUTOR_FLAG);
  }

  /**
   * Run contract verification on all tools in the legacy registry.
   *
   * Delegates to `ToolRegistry.verifyAllContracts`. The result map can be
   * loaded into a `ToolContractsPanel` for diagnostics display.
   *
   * @param opts - Optional verifier options.
   * @returns Map of tool name → ContractVerificationResult.
   */
  verifyAll(opts?: ContractVerifierOptions): Map<string, ContractVerificationResult> {
    return this.legacy.verifyAllContracts(opts);
  }

  /**
   * Run contract verification on a single tool in the legacy registry.
   *
   * @param name - Tool name to verify.
   * @param opts - Optional verifier options.
   * @returns The verification result, or undefined if not registered.
   */
  verifyTool(name: string, opts?: ContractVerifierOptions): ContractVerificationResult | undefined {
    return this.legacy.verifyContract(name, opts);
  }

  /**
   * Format the result of a verifyAll run as a human-readable diagnostic string.
   * Suitable for rendering in the diagnostics panel or printing to the terminal.
   *
   * @param results - Map from verifyAll().
   * @returns Multi-line formatted string.
   */
  static formatVerifyAllReport(results: Map<string, ContractVerificationResult>): string {
    return ToolContractVerifier.formatAllResults(results);
  }
}
