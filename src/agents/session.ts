import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { ConversationManager } from '../core/conversation.ts';
import { KVState } from '@pellux/goodvibes-sdk/platform/state/kv-state';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

export interface AgentSessionPaths {
  readonly sessionsDir: string;
  readonly stateDir: string;
}

function resolveAgentSessionPaths(paths: AgentSessionPaths): AgentSessionPaths {
  if (!paths.sessionsDir || paths.sessionsDir.trim().length === 0) {
    throw new Error('AgentSession requires a non-empty sessionsDir');
  }
  if (!paths.stateDir || paths.stateDir.trim().length === 0) {
    throw new Error('AgentSession requires a non-empty stateDir');
  }
  return paths;
}

/**
 * AgentSession — Isolated session context for a spawned agent.
 *
 * Each agent gets its own ConversationManager, KVState namespace,
 * and JSONL message log file.
 */
export class AgentSession {
  /** The agent's unique identifier. */
  readonly agentId: string;

  /** Guard to ensure session directory is only created once. */
  private dirCreated = false;

  /** Isolated conversation history for this agent. */
  readonly conversation: ConversationManager;

  /** KV state namespaced under agentId. */
  readonly kvState: KVState;

  /** Path to the agent's JSONL message log. */
  readonly sessionFile: string;

  constructor(agentId: string, model: string, provider: string, paths: AgentSessionPaths) {
    this.agentId = agentId;
    const resolvedPaths = resolveAgentSessionPaths(paths);

    // Own ConversationManager — not shared with main session
    this.conversation = new ConversationManager();

    // KV state namespaced to this agent
    this.kvState = new KVState({ sessionId: agentId, stateDir: resolvedPaths.stateDir });

    // JSONL log path
    this.sessionFile = join(resolvedPaths.sessionsDir, `${agentId}.jsonl`);

    // Write a session-start entry
    this._ensureSessionDir();
    this.appendMessage({
      type: 'meta',
      agentId,
      model,
      provider,
      title: '',
      timestamp: Date.now(),
    });

    logger.debug('AgentSession created', { agentId, model, provider });
  }

  /**
   * Append a message record to the agent's JSONL log.
   * Each record is written as a single JSON line.
   */
  appendMessage(msg: Record<string, unknown>): void {
    try {
      if (!this.dirCreated) {
        this._ensureSessionDir();
      }
      appendFileSync(this.sessionFile, JSON.stringify(msg) + '\n', 'utf-8');
    } catch (err) {
      logger.error('AgentSession.appendMessage failed', { agentId: this.agentId, error: summarizeError(err) });
    }
  }

  /**
   * Clean up resources held by this session.
   * Flushes and disposes the KV state.
   */
  async dispose(): Promise<void> {
    try {
      await this.kvState.dispose();
    } catch (err) {
      logger.error('AgentSession.dispose failed', { agentId: this.agentId, error: summarizeError(err) });
    }
    logger.debug('AgentSession disposed', { agentId: this.agentId });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _ensureSessionDir(): void {
    mkdirSync(dirname(this.sessionFile), { recursive: true });
    this.dirCreated = true;
  }
}
