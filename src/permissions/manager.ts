import { getConfigSnapshot, isAutoApproveEnabled } from '../config/index.ts';
import type { PermissionAction, PermissionsToolConfig } from '../config/schema.ts';
import type { PermissionRequestHandler } from './prompt.ts';
export type { PermissionMode } from '../config/schema.ts';

export type PermissionCategory = 'read' | 'write' | 'execute' | 'delegate';

type PermissionConfigSnapshot = ReturnType<typeof getConfigSnapshot>;

export interface PermissionConfigReader {
  isAutoApproveEnabled(): boolean;
  getSnapshot(): PermissionConfigSnapshot;
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

  constructor(
    requestPermission: PermissionRequestHandler = async () => ({ approved: false, remember: false }),
    configReader: PermissionConfigReader = {
      isAutoApproveEnabled,
      getSnapshot: getConfigSnapshot,
    },
  ) {
    this.requestPermission = requestPermission;
    this.configReader = configReader;
  }

  /**
   * check - Returns a Promise that resolves to true (approved) or false (denied).
   * Blocks orchestrator until the user responds when a prompt is needed.
   */
  async check(toolName: string, args: Record<string, unknown>): Promise<boolean> {
    // 1. Auto-approve when --no-worries-just-vibes is active
    if (this.configReader.isAutoApproveEnabled()) return true;

    const permsConfig = this.configReader.getSnapshot().permissions;
    const mode = permsConfig?.mode ?? 'prompt';

    // 2. allow-all mode: auto-approve everything
    if (mode === 'allow-all') return true;

    const category = this.getCategory(toolName);

    // 3. custom mode: check per-tool setting
    if (mode === 'custom') {
      if (TOOL_CONFIG_KEYS[toolName] !== undefined) {
        const toolKey = TOOL_CONFIG_KEYS[toolName];
        const action: PermissionAction = permsConfig?.tools?.[toolKey] ?? 'prompt';
        if (action === 'allow') return true;
        if (action === 'deny') return false;
        // action === 'prompt': fall through to cache + prompt
      } else {
        // Unknown tool in custom mode: default to 'prompt' behavior
        // Fall through to cache + prompt
      }
    } else {
      // 4. prompt mode: auto-approve read operations
      if (category === 'read') return true;
    }

    // 5. Check session approval cache
    const key = this.getApprovalKey(toolName, args);
    if (this.sessionApprovals.has(key)) {
      return this.sessionApprovals.get(key)!;
    }

    // 6. Prompt user via the shell-owned permission controller
    const decision = await this.requestPermission({
      callId: crypto.randomUUID(),
      tool: toolName,
      args,
      category,
    });
    if (decision.remember) {
      this.sessionApprovals.set(key, decision.approved);
    }
    return decision.approved;
  }

  /** Returns the permission category for a tool name. Unknown tools default to 'delegate'. */
  getCategory(toolName: string): PermissionCategory {
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
}
