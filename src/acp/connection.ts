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
import type { EventBus } from '../core/event-bus.ts';
import type { SubagentInfo, SubagentResult, SubagentTask } from './protocol.ts';
import type { PermissionCategory } from '../permissions/manager.ts';
import { logger } from '../utils/logger.ts';
import { VERSION } from '../version.ts';

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
  private conn: ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private childProcess: ReturnType<typeof Bun.spawn> | null = null;
  private toolCallsMade = 0;
  private lastProgressText = '';

  constructor(
    id: string,
    private task: SubagentTask,
    private bus: EventBus,
    /** Command + args to spawn the agent process. */
    private spawnCmd: string[],
  ) {
    this.id = id;
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
        throw new Error('ACP subprocess stdin not available — was it spawned with stdin: "pipe"?');
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
      await this.conn.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'goodvibes-tui', version: VERSION },
        clientCapabilities: {},
      });

      // 6. Create a session (cwd is required, mcpServers is required)
      const sessionResp = await this.conn.newSession({
        cwd: process.cwd(),
        mcpServers: [],
      });
      this.sessionId = sessionResp.sessionId;

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
      this.bus.emit('subagent:complete', { id: this.id, result });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.info.status = 'error';
      this.bus.emit('subagent:error', { id: this.id, error });
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
        logger.error('AcpConnection.cancel: failed to send cancel to subagent', { id: this.id, err: String(err) });
      }
    }
    this.info.status = 'cancelled';
    this.cleanup();
  }

  private cleanup(): void {
    try {
      this.childProcess?.kill();
    } catch (err) {
      logger.error('AcpConnection.cleanup: failed to kill child process', { id: this.id, err: String(err) });
    }
    this.childProcess = null;
    this.conn = null;
    this.sessionId = null;
  }

  private buildClientImpl(): Client {
    return {
      /**
       * Forward permission requests to the TUI's EventBus.
       * The permission manager resolves the promise via the 'permission:request' event.
       */
      requestPermission: (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        return new Promise((resolve) => {
          const category: PermissionCategory = 'delegate';
          const callId = `acp-${this.id}-${Date.now()}`;

          // Extract a human-readable tool name from the tool call
          const toolTitle = params.toolCall?.title ?? 'unknown';

          // Pick the first available option ID to use when approved
          const approveOptionId = params.options[0]?.optionId ?? 'allow';

          this.bus.emit('permission:request', {
            callId,
            tool: toolTitle,
            args: (params.toolCall?.rawInput as Record<string, unknown>) ?? {},
            category,
            resolve: (approved: boolean) => {
              if (approved) {
                resolve({
                  outcome: {
                    outcome: 'selected',
                    optionId: approveOptionId,
                  },
                } as RequestPermissionResponse);
              } else {
                resolve({
                  outcome: { outcome: 'cancelled' },
                } as RequestPermissionResponse);
              }
            },
          });
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
          }
        }

        this.bus.emit('subagent:update', { id: this.id, update: params });
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
