/**
 * AcpConnection — Per-subagent ACP connection.
 *
 * Spawns a child process via Bun.spawn and connects to it via ClientSideConnection
 * using ndJsonStream over stdio. Implements the ACP Client interface so the
 * subagent can request permissions and send session updates.
 */

import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type {
  Client,
  Agent,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from './protocol.ts';
import type { SubagentInfo, SubagentResult, SubagentTask } from './protocol.ts';
import type { PermissionCategory } from '../permissions/manager.ts';
import type { PermissionRequestHandler } from '../permissions/prompt.ts';
import { logger } from '../utils/logger.ts';
import { analyzePermissionRequest } from '../permissions/analysis.ts';
import { AcpError } from '../types/errors.ts';
import { VERSION } from '../version.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import {
  emitAgentCancelled,
  emitAgentCompleted,
  emitAgentFailed,
  emitAgentStreamDelta,
  emitTransportAuthenticating,
  emitTransportConnected,
  emitTransportDisconnected,
  emitTransportInitializing,
  emitTransportSyncing,
  emitTransportTerminalFailure,
} from '../runtime/emitters/index.ts';
import type { HookDispatcher } from '../hooks/index.ts';
import type { HookCategory, HookEventPath, HookPhase } from '../hooks/types.ts';
import { summarizeError } from '../utils/error-display.ts';

/** Shape of an agent_message_chunk session update that carries text content. */
interface MessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content?: Array<{ type: string; text?: string }>;
}

/** Runtime type guard for agent_message_chunk updates. */
function isMessageChunk(update: { sessionUpdate?: unknown }): update is MessageChunkUpdate {
  return (
    update.sessionUpdate === 'agent_message_chunk' &&
    ('content' in update)
  );
}

/**
 * AcpConnection manages the lifecycle of a single subagent child process.
 *
 * Lifecycle:
 *   1. Construct with spawn params
 *   2. Call run() — spawns child, performs ACP handshake, starts a session
 *   3. Resolves with SubagentResult when the subagent completes or is cancelled
 *   4. Call cancel() to abort
 */
export class AcpConnection {
  public readonly id: string;
  private info: SubagentInfo;
  private spawnCmd: string[];
  private requestPermission: PermissionRequestHandler;
  private runtimeBus: RuntimeEventBus | null;
  private conn: ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private childProcess: ReturnType<typeof Bun.spawn> | null = null;
  private toolCallsMade = 0;
  private lastProgressText = '';
  private transportClosed = false;
  private readonly hookDispatcher: Pick<HookDispatcher, 'fire'> | null;

  constructor(
    id: string,
    private task: SubagentTask,
    spawnCmd: string[],
    requestPermission: PermissionRequestHandler = async () => ({ approved: false, remember: false }),
    runtimeBus: RuntimeEventBus | null = null,
    hookDispatcher: Pick<HookDispatcher, 'fire'> | null = null,
  ) {
    this.id = id;
    this.spawnCmd = spawnCmd;
    this.requestPermission = requestPermission;
    this.runtimeBus = runtimeBus;
    this.hookDispatcher = hookDispatcher;
    this.info = {
      id,
      task: task.description,
      status: 'running',
      startedAt: Date.now(),
    };
  }

  /** Current info snapshot. */
  getInfo(): SubagentInfo {
    return { ...this.info };
  }

  /**
   * Spawn the child process, perform the ACP handshake, and run the prompt.
   * Resolves with SubagentResult when the subagent completes or errors.
   */
  async run(): Promise<SubagentResult> {
    const startedAt = this.info.startedAt;

    try {
      this.transportClosed = false;
      this.emitTransportInitializing();

      // 1. Spawn child process with piped stdio
      this.childProcess = Bun.spawn(this.spawnCmd, {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // 2. Build ndJsonStream from child stdio.
      //
      // In Bun, childProcess.stdin is a FileSink (not a Web WritableStream).
      // ndJsonStream requires a Web WritableStream<Uint8Array> so it can call
      // .getWriter() internally.  Wrap the FileSink in a WritableStream adapter.
      if (!this.childProcess.stdin) {
        throw new AcpError('ACP subprocess stdin not available — was it spawned with stdin: "pipe"?');
      }
      const bunStdin = this.childProcess.stdin as import('bun').FileSink;
      const stdinStream = new WritableStream<Uint8Array>({
        write(chunk) {
          bunStdin.write(chunk);
        },
        close() {
          bunStdin.end();
        },
        abort() {
          bunStdin.end();
        },
      });

      const stream = ndJsonStream(
        stdinStream,
        // Bun's piped stdout is ReadableStream-compatible at runtime — getReader() works
        // correctly. The double-cast is safe here because Bun's ReadStream implements the
        // same interface, unlike stdin (FileSink) which lacks getWriter().
        this.childProcess.stdout as unknown as ReadableStream<Uint8Array>,
      );

      // 3. Build the Client implementation that handles agent callbacks
      const clientImpl: Client = this.buildClientImpl();

      // 4. Create the ClientSideConnection (TUI = ACP client, child = ACP agent)
      this.conn = new ClientSideConnection((_agent: Agent) => clientImpl, stream);

      // 5. ACP handshake: initialize (protocolVersion is a number)
      this.emitTransportAuthenticating();
      await this.conn.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'goodvibes-tui', version: VERSION },
        clientCapabilities: {},
      });

      // 6. Create a session (cwd is required, mcpServers is required)
      const sessionResp = await this.conn.newSession({
        cwd: this.task.workingDirectory,
        mcpServers: [],
      });
      this.sessionId = sessionResp.sessionId;
      this.emitTransportConnected();
      this.emitTransportSyncing();

      // 7. Send the prompt (uses 'prompt' field with ContentBlock array)
      const promptResp = await this.conn.prompt({
        sessionId: this.sessionId,
        prompt: [
          {
            type: 'text' as const,
            text: this.buildPromptText(),
          },
        ],
      });

      const output = this.lastProgressText || `Completed with stop reason: ${promptResp.stopReason}`;
      const result: SubagentResult = {
        id: this.id,
        success: promptResp.stopReason !== 'cancelled',
        output,
        toolCallsMade: this.toolCallsMade,
        duration: Date.now() - startedAt,
      };

      this.info.status = result.success ? 'complete' : 'error';
      if (this.runtimeBus) {
        emitAgentCompleted(this.runtimeBus, this.emitterContext(), {
          agentId: this.id,
          durationMs: result.duration,
          output: result.output,
          toolCallsMade: result.toolCallsMade,
        });
      }
      this.emitTransportDisconnected('ACP session completed', false);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(summarizeError(err));
      this.info.status = 'error';
      if (this.runtimeBus) {
        emitAgentFailed(this.runtimeBus, this.emitterContext(), {
          agentId: this.id,
          error: error.message,
          durationMs: Date.now() - startedAt,
        });
      }
      this.emitTransportTerminalFailure(error.message);
      return {
        id: this.id,
        success: false,
        output: error.message,
        toolCallsMade: this.toolCallsMade,
        duration: Date.now() - startedAt,
      };
    } finally {
      this.cleanup();
    }
  }

  /** Cancel the running subagent. */
  async cancel(): Promise<void> {
    if (this.conn && this.sessionId) {
      try {
        await this.conn.cancel({ sessionId: this.sessionId });
      } catch (err) {
        // Best-effort — kill the child if cancel fails
        logger.error('AcpConnection.cancel: failed to send cancel to subagent', { id: this.id, err: summarizeError(err) });
      }
    }
    this.info.status = 'cancelled';
    if (this.runtimeBus) {
      emitAgentCancelled(this.runtimeBus, this.emitterContext(), {
        agentId: this.id,
        reason: 'ACP session cancelled',
      });
    }
    this.emitTransportDisconnected('ACP session cancelled', false);
    this.cleanup();
  }

  private emitterContext(): import('../runtime/emitters/index.ts').EmitterContext {
    return {
      sessionId: 'acp-connection',
      traceId: `acp-connection:${this.id}`,
      source: 'acp-connection',
    };
  }

  private transportId(): string {
    return `acp:${this.id}`;
  }

  private transportEndpoint(): string {
    return `stdio://subagent/${this.id}`;
  }

  private emitTransportInitializing(): void {
    if (!this.runtimeBus) return;
    emitTransportInitializing(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      protocol: 'acp-stdio',
    });
    void this.fireTransportHook('initializing', {
      transportId: this.transportId(),
      protocol: 'acp-stdio',
    });
  }

  private emitTransportAuthenticating(): void {
    if (!this.runtimeBus) return;
    emitTransportAuthenticating(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
    });
    void this.fireTransportHook('authenticating', {
      transportId: this.transportId(),
    });
  }

  private emitTransportConnected(): void {
    if (!this.runtimeBus) return;
    emitTransportConnected(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      endpoint: this.transportEndpoint(),
    });
    void this.fireTransportHook('connected', {
      transportId: this.transportId(),
      endpoint: this.transportEndpoint(),
    });
  }

  private emitTransportSyncing(): void {
    if (!this.runtimeBus) return;
    emitTransportSyncing(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
    });
    void this.fireTransportHook('syncing', {
      transportId: this.transportId(),
    });
  }

  private emitTransportDisconnected(reason: string, willRetry: boolean): void {
    if (!this.runtimeBus || this.transportClosed) return;
    this.transportClosed = true;
    emitTransportDisconnected(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      reason,
      willRetry,
    });
    void this.fireTransportHook('disconnected', {
      transportId: this.transportId(),
      reason,
      willRetry,
    });
  }

  private emitTransportTerminalFailure(error: string): void {
    if (!this.runtimeBus || this.transportClosed) return;
    this.transportClosed = true;
    emitTransportTerminalFailure(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      error,
    });
    void this.fireTransportHook('failed', {
      transportId: this.transportId(),
      error,
    });
  }

  private async fireTransportHook(specific: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.hookDispatcher) return;
    try {
      await this.hookDispatcher.fire({
        path: `Lifecycle:transport:${specific}` as HookEventPath,
        phase: 'Lifecycle' as HookPhase,
        category: 'transport' as HookCategory,
        specific,
        sessionId: 'acp-connection',
        timestamp: Date.now(),
        payload,
      });
    } catch {
      // Transport hooks are best-effort and must not break ACP transport.
    }
  }

  private cleanup(): void {
    try {
      this.childProcess?.kill();
    } catch (err) {
      logger.error('AcpConnection.cleanup: failed to kill child process', { id: this.id, err: summarizeError(err) });
    }
    this.childProcess = null;
    this.conn = null;
    this.sessionId = null;
  }

  private buildClientImpl(): Client {
    return {
      /** Forward permission requests through the shell-owned permission controller. */
      requestPermission: (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const category: PermissionCategory = 'delegate';
        const callId = `acp-${this.id}-${Date.now()}`;
        const toolTitle = params.toolCall?.title ?? 'unknown';
        const approveOptionId = params.options[0]?.optionId ?? 'allow';

        return this.requestPermission({
          callId,
          tool: toolTitle,
          args: (params.toolCall?.rawInput as Record<string, unknown>) ?? {},
          category,
          analysis: analyzePermissionRequest(
            toolTitle,
            (params.toolCall?.rawInput as Record<string, unknown>) ?? {},
            category,
          ),
        }).then(({ approved }) => {
          if (approved) {
            return {
              outcome: {
                outcome: 'selected',
                optionId: approveOptionId,
              },
            } as RequestPermissionResponse;
          }
          return {
            outcome: { outcome: 'cancelled' },
          } as RequestPermissionResponse;
        });
      },

      /** Handle session update notifications from the subagent. */
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        const update = params.update;

        // Count tool calls
        if (update.sessionUpdate === 'tool_call') {
          this.toolCallsMade++;
        }

        // Collect streamed text chunks as progress
        if (isMessageChunk(update)) {
          const text = update.content
            ?.filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('') ?? '';
          if (text) {
            this.lastProgressText = (this.lastProgressText + text).slice(-1000);
            this.info.progress = this.lastProgressText.slice(-200);
            if (this.runtimeBus) {
              emitAgentStreamDelta(this.runtimeBus, this.emitterContext(), {
                agentId: this.id,
                content: text,
                accumulated: this.lastProgressText,
              });
            }
          }
        }
      },
    };
  }

  private buildPromptText(): string {
    const parts: string[] = [`Task: ${this.task.description}`];

    if (this.task.context) {
      parts.push(`Context:\n${this.task.context}`);
    }

    if (this.task.tools.length > 0) {
      parts.push(`Available tools: ${this.task.tools.join(', ')}`);
    }

    if (this.task.model) {
      parts.push(`Use model: ${this.task.model}`);
    }

    return parts.join('\n\n');
  }
}
