import { getConfigSnapshot, isAutoApproveEnabled } from '../config/index.ts';
import type { PermissionAction, PermissionsToolConfig } from '../config/schema.ts';
import type { PermissionRequestHandler } from './prompt.ts';
import { analyzePermissionRequest } from './analysis.ts';
import type { PolicyRuntimeState } from '../runtime/permissions/policy-runtime.ts';
import { LayeredPolicyEvaluator } from '../runtime/permissions/evaluator.ts';
import type { PermissionDecision as LayeredPermissionDecision } from '../runtime/permissions/types.ts';
import type { HookDispatcher } from '../hooks/index.ts';
import type { HookCategory, HookEventPath, HookPhase } from '../hooks/types.ts';
import type { ConfigManager } from '../config/manager.ts';
import type {
  PermissionCategory,
  PermissionCheckResult,
  PermissionDecisionReasonCode,
  PermissionDecisionSource,
} from './types.ts';
export type { PermissionMode } from '../config/schema.ts';
export type {
  PermissionCategory,
  PermissionRiskLevel,
  PermissionDecisionSource,
  PermissionDecisionReasonCode,
  PermissionRequestAnalysis,
  PermissionCheckResult,
} from './types.ts';

type PermissionConfigSnapshot = ReturnType<typeof getConfigSnapshot>;

export interface PermissionConfigReader {
  isAutoApproveEnabled(): boolean;
  getSnapshot(): PermissionConfigSnapshot;
  getWorkingDirectory(): string | null;
}

export function createPermissionConfigReader(
  configManager: Pick<ConfigManager, 'get' | 'getRaw' | 'getWorkingDirectory'>,
): PermissionConfigReader {
  return {
    isAutoApproveEnabled: () => isAutoApproveEnabled(configManager),
    getSnapshot: () => getConfigSnapshot(configManager),
    getWorkingDirectory: () => configManager.getWorkingDirectory(),
  };
}

/** Maps tool names to permission categories and config tool keys. */
const TOOL_CATEGORIES: Record<string, PermissionCategory> = {
  read: 'read',
  find: 'read',
  fetch: 'read',
  analyze: 'read',
  inspect: 'read',
  state: 'read',
  registry: 'read',
  // write — new tool names
  write: 'write',
  edit: 'write',
  // execute — new tool name
  exec: 'execute',
  // delegate — new tool names
  agent: 'delegate',
  delegate: 'delegate',
  workflow: 'delegate',
  mcp: 'delegate',
};

/** Maps tool names to their key in PermissionsToolConfig. */
const TOOL_CONFIG_KEYS: Record<string, keyof PermissionsToolConfig> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  exec: 'exec',
  find: 'find',
  fetch: 'fetch',
  analyze: 'analyze',
  inspect: 'inspect',
  agent: 'agent',
  state: 'state',
  workflow: 'workflow',
  registry: 'registry',
  delegate: 'delegate',
  mcp: 'mcp',
};

/**
 * PermissionManager - Controls tool execution approval.
 *
 * Approval logic (priority order):
 *   1. --no-worries-just-vibes flag OR mode='allow-all' -> auto-approve everything
 *   2. mode='custom' -> check per-tool config action ('allow'/'prompt'/'deny')
 *   3. mode='prompt' (default) -> auto-approve reads, prompt for writes/execute/delegate
 *   4. Session approval cache hit -> use cached decision
 *   5. Ask the shell-owned permission controller and block until user responds
 */
export class PermissionManager {
  private sessionApprovals = new Map<string, boolean>();
  private readonly requestPermission: PermissionRequestHandler;
  private readonly configReader: PermissionConfigReader;
  private readonly hookDispatcher: Pick<HookDispatcher, 'fire'> | null;
  private readonly policyRuntimeState: Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'>;

  constructor(
    requestPermission: PermissionRequestHandler = async () => ({ approved: false, remember: false }),
    configReader: PermissionConfigReader,
    policyRuntimeState: Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'>,
    hookDispatcher: Pick<HookDispatcher, 'fire'> | null = null,
  ) {
    this.requestPermission = requestPermission;
    this.configReader = configReader;
    this.policyRuntimeState = policyRuntimeState;
    this.hookDispatcher = hookDispatcher;
  }

  /**
   * check - Returns a Promise that resolves to true (approved) or false (denied).
   * Blocks orchestrator until the user responds when a prompt is needed.
   */
  async check(toolName: string, args: Record<string, unknown>): Promise<boolean> {
    const result = await this.checkDetailed(toolName, args);
    return result.approved;
  }

  async checkDetailed(toolName: string, args: Record<string, unknown>): Promise<PermissionCheckResult> {
    // 1. Auto-approve when --no-worries-just-vibes is active
    const category = this.getCategory(toolName, args);
    const analysis = analyzePermissionRequest(toolName, args, category);
    const callId = crypto.randomUUID();
    await this.fireHook('Pre:permission:request', 'Pre', 'permission', 'request', {
      callId,
      toolName,
      category,
      analysis,
    });
    this.policyRuntimeState.recordPermissionRequest({
      callId,
      tool: toolName,
      category,
      analysis,
    });
    if (this.configReader.isAutoApproveEnabled()) {
      return this.emitAndReturn(callId, toolName, category, this.result(true, false, 'config_policy', 'config_allow', analysis));
    }

    const permsConfig = this.configReader.getSnapshot().permissions;
    const mode = permsConfig?.mode ?? 'prompt';

    // 2. allow-all mode: auto-approve everything
    if (mode === 'allow-all') {
      return this.emitAndReturn(callId, toolName, category, this.result(true, false, 'runtime_mode', 'mode_allow_all', analysis));
    }

    const evaluatorDecision = this.evaluateRuntimePolicy(toolName, args, mode);
    const mappedDecision = this.mapEvaluatorDecision(evaluatorDecision, analysis);
    if (mappedDecision) {
      return this.emitAndReturn(callId, toolName, category, mappedDecision);
    }

    // 3. custom mode: check per-tool setting
    if (mode === 'custom') {
      if (TOOL_CONFIG_KEYS[toolName] !== undefined) {
        const toolKey = TOOL_CONFIG_KEYS[toolName];
        const action: PermissionAction = permsConfig?.tools?.[toolKey] ?? 'prompt';
        if (action === 'allow') return this.emitAndReturn(callId, toolName, category, this.result(true, false, 'config_policy', 'config_allow', analysis));
        if (action === 'deny') return this.emitAndReturn(callId, toolName, category, this.result(false, false, 'config_policy', 'config_deny', analysis));
        // action === 'prompt': fall through to cache + prompt
      } else {
        // Unknown tool in custom mode: default to 'prompt' behavior
        // Fall through to cache + prompt
      }
    } else {
      // 4. prompt mode: auto-approve read operations
      if (category === 'read') return this.emitAndReturn(callId, toolName, category, this.result(true, false, 'config_policy', 'config_allow', analysis));
    }

    // 5. Check session approval cache
    const key = this.getApprovalKey(toolName, args);
    if (this.sessionApprovals.has(key)) {
      const approved = this.sessionApprovals.get(key)!;
      return this.emitAndReturn(callId, toolName, category, this.result(
        approved,
        true,
        'session_override',
        approved ? 'session_cached_allow' : 'session_cached_deny',
        analysis,
      ));
    }

    // 6. Prompt user via the shell-owned permission controller
    let decision: Awaited<ReturnType<PermissionRequestHandler>>;
    try {
      decision = await this.requestPermission({
        callId,
        tool: toolName,
        args,
        category,
        analysis,
        workingDirectory: this.configReader.getWorkingDirectory() ?? undefined,
      });
    } catch (error) {
      void this.fireHook('Fail:permission:request', 'Fail', 'permission', 'request', {
        callId,
        toolName,
        category,
        analysis,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (decision.remember) {
      this.sessionApprovals.set(key, decision.approved);
    }
    return this.emitAndReturn(callId, toolName, category, this.result(
      decision.approved,
      Boolean(decision.remember),
      'user_prompt',
      decision.approved ? 'user_approved' : 'user_denied',
      analysis,
    ));
  }

  /** Returns the permission category for a tool name. Unknown tools default to 'delegate'. */
  getCategory(toolName: string, args: Record<string, unknown> = {}): PermissionCategory {
    if (toolName === 'inspect' && args.mode === 'scaffold' && args.dryRun === false) {
      return 'write';
    }
    return TOOL_CATEGORIES[toolName] ?? 'delegate';
  }

  /**
   * getApprovalKey - Stable key for session-level "always approve" decisions.
   * Includes the most meaningful argument to distinguish different invocations.
   */
  private getApprovalKey(toolName: string, args: Record<string, unknown>): string {
    if (typeof args['path'] === 'string') {
      return `${toolName}:${args['path']}`;
    }
    if (typeof args['command'] === 'string') {
      return `${toolName}:${args['command']}`;
    }
    // Generic fallback: key only on tool name ("always allow this tool")
    return toolName;
  }

  private result(
    approved: boolean,
    persisted: boolean,
    sourceLayer: PermissionDecisionSource,
    reasonCode: PermissionDecisionReasonCode,
    analysis: ReturnType<typeof analyzePermissionRequest>,
  ): PermissionCheckResult {
    return {
      approved,
      persisted,
      sourceLayer,
      reasonCode,
      analysis,
    };
  }

  private evaluateRuntimePolicy(
    toolName: string,
    args: Record<string, unknown>,
    mode: PermissionConfigSnapshot['permissions']['mode'],
  ): LayeredPermissionDecision {
    const rules = this.policyRuntimeState.getRegistry().getCurrent()?.rules ?? [];
    const evaluator = new LayeredPolicyEvaluator({
      mode: mode === 'allow-all' ? 'allow-all' : mode === 'custom' ? 'custom' : 'default',
      projectRoot: this.configReader.getWorkingDirectory() ?? undefined,
      rules,
      defaultEffect: 'deny',
    });
    return evaluator.evaluate(toolName, args);
  }

  private mapEvaluatorDecision(
    decision: LayeredPermissionDecision,
    analysis: ReturnType<typeof analyzePermissionRequest>,
  ): PermissionCheckResult | null {
    if (decision.allowed) {
      if (decision.sourceLayer === 'policy') {
        return this.result(true, false, 'managed_policy', 'managed_policy_allow', analysis);
      }
      if (decision.sourceLayer === 'safety') {
        return this.result(false, false, 'safety_check', 'safety_guardrail', analysis);
      }
      if (decision.sourceLayer === 'mode') {
        return this.result(true, false, 'runtime_mode', 'mode_allow_all', analysis);
      }
      if (decision.sourceLayer === 'default' && decision.classification === 'read') {
        return this.result(true, false, 'config_policy', 'config_allow', analysis);
      }
      return null;
    }

    if (decision.sourceLayer === 'safety') {
      return this.result(false, false, 'safety_check', 'safety_guardrail', analysis);
    }
    if (decision.sourceLayer === 'mode') {
      return this.result(false, false, 'runtime_mode', 'mode_denied', analysis);
    }
    if (decision.sourceLayer === 'policy') {
      return this.result(false, false, 'managed_policy', 'managed_policy_deny', analysis);
    }

    return null;
  }

  private emitAndReturn(
    callId: string,
    toolName: string,
    category: PermissionCategory,
    result: PermissionCheckResult,
  ): PermissionCheckResult {
    this.policyRuntimeState.recordPermissionDecision({
      callId,
      tool: toolName,
      category,
      result,
    });
    void this.fireHook('Post:permission:decision', 'Post', 'permission', 'decision', {
      callId,
      toolName,
      category,
      approved: result.approved,
      persisted: result.persisted,
      sourceLayer: result.sourceLayer,
      reasonCode: result.reasonCode,
      riskLevel: result.analysis.riskLevel,
      classification: result.analysis.classification,
    });
    return result;
  }

  private async fireHook(
    path: HookEventPath,
    phase: HookPhase,
    category: HookCategory,
    specific: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.hookDispatcher) return;
    try {
      await this.hookDispatcher.fire({
        path,
        phase,
        category,
        specific,
        sessionId: 'permissions',
        timestamp: Date.now(),
        payload,
      });
    } catch {
      // Permission hooks are best-effort observability surfaces.
    }
  }
}
