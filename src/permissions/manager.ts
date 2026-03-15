import type { EventBus } from '../core/event-bus.ts';
import { config } from '../config/index.ts';
import type { PermissionAction, PermissionsToolConfig } from '../config/schema.ts';
export type { PermissionMode } from '../config/schema.ts';

export type PermissionCategory = 'read' | 'write' | 'execute' | 'delegate';

/** Maps tool names to permission categories and config tool keys. */
const TOOL_CATEGORIES: Record<string, PermissionCategory> = {
  // read
  file_read: 'read',
  grep: 'read',
  list_dir: 'read',
  glob: 'read',
  // write
  file_write: 'write',
  file_edit: 'write',
  // execute
  shell_exec: 'execute',
};

/** Maps tool names to their key in PermissionsToolConfig. */
const TOOL_CONFIG_KEYS: Record<string, keyof PermissionsToolConfig> = {
  file_read: 'file_read',
  file_write: 'file_write',
  file_edit: 'file_edit',
  shell_exec: 'shell_exec',
  grep: 'grep',
  list_dir: 'list_dir',
  glob: 'glob',
};

/**
 * PermissionManager - Controls tool execution approval.
 *
 * Approval logic (priority order):
 *   1. --no-worries-just-vibes flag OR mode='allow-all' -> auto-approve everything
 *   2. mode='custom' -> check per-tool config action ('allow'/'prompt'/'deny')
 *   3. mode='prompt' (default) -> auto-approve reads, prompt for writes/execute/delegate
 *   4. Session approval cache hit -> use cached decision
 *   5. Emit 'permission:request' event and block until user responds
 */
export class PermissionManager {
  private sessionApprovals = new Map<string, boolean>();

  constructor(private eventBus: EventBus) {}

  /**
   * check - Returns a Promise that resolves to true (approved) or false (denied).
   * Blocks orchestrator until the user responds when a prompt is needed.
   */
  async check(toolName: string, args: Record<string, unknown>): Promise<boolean> {
    // 1. Auto-approve when --no-worries-just-vibes is active
    if (config.autoApprove) return true;

    const permsConfig = config.permissions;
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

    // 6. Prompt user via event bus - blocks until resolve() is called
    return new Promise<boolean>((resolve) => {
      this.eventBus.emit('permission:request', {
        callId: crypto.randomUUID(),
        tool: toolName,
        args,
        category,
        resolve: (approved: boolean, remember = false) => {
          if (remember) {
            this.sessionApprovals.set(key, approved);
          }
          resolve(approved);
        },
      });
    });
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
