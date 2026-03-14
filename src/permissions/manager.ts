import type { EventBus } from '../core/event-bus.ts';
import { config } from '../config/index.ts';

export type PermissionCategory = 'read' | 'write' | 'execute' | 'delegate';

/**
 * Maps tool names to permission categories.
 * read    - auto-approved; no prompt
 * write   - requires user confirmation
 * execute - requires user confirmation
 * delegate - requires user confirmation
 */
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

/**
 * PermissionManager - Controls tool execution approval.
 *
 * Approval logic (priority order):
 *   1. --no-worries-just-vibes flag -> auto-approve everything
 *   2. Tool category is 'read'     -> auto-approve
 *   3. Session approval cache hit  -> use cached decision
 *   4. Emit 'permission:request' event and block until user responds
 */
export class PermissionManager {
  private sessionApprovals = new Map<string, boolean>();

  constructor(private eventBus: EventBus) {}

  /**
   * check - Returns a Promise that resolves to true (approved) or false (denied).
   * Blocks orchestrator until the user responds when a prompt is needed.
   *
   * Session approvals: when the user selects "Always allow" (remember=true), the
   * decision is cached in `sessionApprovals` for the lifetime of the process.
   * There is no undo mechanism — the approval persists until the process exits.
   */
  async check(toolName: string, args: Record<string, unknown>): Promise<boolean> {
    // 1. Auto-approve when --no-worries-just-vibes is active
    if (config.autoApprove) return true;

    // 2. Auto-approve read operations
    const category = this.getCategory(toolName);
    if (category === 'read') return true;

    // 3. Check session approval cache
    const key = this.getApprovalKey(toolName, args);
    if (this.sessionApprovals.has(key)) {
      return this.sessionApprovals.get(key)!;
    }

    // 4. Prompt user via event bus - blocks until resolve() is called
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
