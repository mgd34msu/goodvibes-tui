// TODO: import PhasedToolExecutor from './phased-executor.ts' when that module is available.
// TODO: import { FeatureFlagManager } from '../feature-flags/index.ts' when that module is available.
import type { ToolResult } from '../../types/tools.ts';
import type { ToolRuntimeContext } from './context.ts';
import { ToolRegistry } from '../../tools/registry.ts';

/**
 * Placeholder type for the phased executor.
 * Replace this import with the real type once phased-executor.ts is ready.
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
}
