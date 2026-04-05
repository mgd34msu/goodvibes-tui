/**
 * AcpManager — Manages the lifecycle of all subagent ACP connections.
 *
 * The TUI orchestrator calls spawn() when it needs to delegate work.
 * The manager tracks active subagents and provides cancel / waitAll.
 */

import { randomUUID } from 'node:crypto';
import { AcpConnection } from './connection.ts';
import type { SubagentInfo, SubagentResult, SubagentTask } from './protocol.ts';
import type { PermissionRequestHandler } from '../permissions/prompt.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import { emitAgentSpawning } from '../runtime/emitters/index.ts';

/**
 * Command used to spawn subagent processes.
 * Defaults to the current Bun binary running the TUI in --acp (headless ACP) mode.
 * Override via ACP_AGENT_CMD env var (space-separated).
 */
function resolveAgentCommand(): string[] {
  const envCmd = process.env.ACP_AGENT_CMD;
  if (envCmd) return envCmd.split(' ');
  // Default: re-launch self in ACP agent mode
  return [process.execPath, 'run', process.argv[1] ?? 'src/main.ts', '--acp'];
}

/**
 * AcpManager — Manages multiple concurrent subagent connections.
 *
 * @example
 * ```ts
 * const mgr = new AcpManager(bus);
 * const id = await mgr.spawn({ description: 'Fix the bug', context: '...', tools: ['read'] });
 * const results = await mgr.waitAll();
 * ```
 */
export class AcpManager {
  private connections = new Map<string, AcpConnection>();
  private pending = new Map<string, Promise<SubagentResult>>();
  private agentCmd: string[];
  private readonly requestPermission?: PermissionRequestHandler;
  private readonly runtimeBus: RuntimeEventBus | null;

  constructor(
    permissionOrLegacyBus?: PermissionRequestHandler | { emit?: unknown },
    runtimeBus: RuntimeEventBus | null = null,
  ) {
    this.agentCmd = resolveAgentCommand();
    this.requestPermission = typeof permissionOrLegacyBus === 'function' ? permissionOrLegacyBus : undefined;
    this.runtimeBus = runtimeBus;
  }

  /**
   * Spawn a new subagent and start running the task.
   * Returns the subagent ID immediately; the task runs in the background.
   */
  async spawn(task: SubagentTask): Promise<string> {
    const id = randomUUID();
    const conn = new AcpConnection(id, task, this.agentCmd, this.requestPermission, this.runtimeBus);
    this.connections.set(id, conn);

    if (this.runtimeBus) {
      emitAgentSpawning(this.runtimeBus, {
        sessionId: 'acp-manager',
        traceId: `acp-manager:${id}`,
        source: 'acp-manager',
      }, {
        agentId: id,
        task: task.description,
      });
    }

    // Start running — store the promise so waitAll() can await it
    const promise = conn.run().finally(() => {
      // Clean up tracking once done
      this.connections.delete(id);
      this.pending.delete(id);
    });
    this.pending.set(id, promise);

    return id;
  }

  /** Returns info snapshots for all active subagents. */
  getActive(): SubagentInfo[] {
    return Array.from(this.connections.values()).map((c) => c.getInfo());
  }

  /** Cancel a specific subagent by ID. No-op if not found. */
  async cancel(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (conn) {
      await conn.cancel();
      this.connections.delete(id);
      this.pending.delete(id);
    }
  }

  /** Cancel all active subagents. */
  async cancelAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.connections.keys()).map((id) => this.cancel(id)),
    );
  }

  /**
   * Wait for all currently active subagents to finish.
   * Returns results in completion order.
   */
  async waitAll(): Promise<SubagentResult[]> {
    const promises = Array.from(this.pending.values());
    if (promises.length === 0) return [];
    const settled = await Promise.allSettled(promises);
    return settled
      .filter((r): r is PromiseFulfilledResult<SubagentResult> => r.status === 'fulfilled')
      .map((r) => r.value);
  }
}
