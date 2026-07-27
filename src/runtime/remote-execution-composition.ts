/**
 * remote-execution-composition.ts — running work somewhere other than here.
 *
 * Four collaborators that only make sense together, so they are built together
 * rather than as four unrelated lines in the middle of the runtime composition:
 *
 *   - RemoteRunnerRegistry knows which remote runners exist and how to reach
 *     them; RemoteSupervisor drives them and is meaningless without it.
 *
 *   - SandboxSessionRegistry owns the sandboxes a tool call can be confined to,
 *     and McpRegistry is the thing that confines them — an MCP server started
 *     without the sandbox registry runs its tools directly on the host.
 *
 * The pairing in each case is the point: handing the supervisor a registry it
 * did not build, or the MCP registry a sandbox runtime it does not share with
 * the session registry, produces a runtime that looks wired and quietly is not.
 */
import { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import {
  RemoteRunnerRegistry,
  RemoteSupervisor,
  SandboxSessionRegistry,
  type RuntimeEventBus,
} from '@/runtime/index.ts';
import type { AgentManager } from '@pellux/goodvibes-sdk/platform/tools';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks';

export interface RemoteExecutionServices {
  readonly remoteRunnerRegistry: RemoteRunnerRegistry;
  readonly remoteSupervisor: RemoteSupervisor;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
  readonly mcpRegistry: McpRegistry;
}

/**
 * Build the remote-execution and sandboxing seam.
 *
 * Constructing these opens no connection and starts no server: a runner is
 * reached when something asks for it, and an MCP server starts when a session
 * requests it. Composing a runtime in a test therefore executes nothing.
 */
export function createRemoteExecutionServices(options: {
  readonly agentManager: AgentManager;
  readonly workingDirectory: string;
  readonly hookDispatcher: HookDispatcher;
  readonly configManager: ConfigManager;
  readonly runtimeBus: RuntimeEventBus;
}): RemoteExecutionServices {
  const remoteRunnerRegistry = new RemoteRunnerRegistry(options.agentManager);
  const remoteSupervisor = new RemoteSupervisor(remoteRunnerRegistry);
  const sandboxSessionRegistry = new SandboxSessionRegistry(options.workingDirectory);
  const mcpRegistry = new McpRegistry({
    hookDispatcher: options.hookDispatcher,
    sandboxSessions: sandboxSessionRegistry,
  });
  mcpRegistry.setRuntimeBus(options.runtimeBus);
  // The SAME sandbox registry the session registry above owns, so a tool call
  // confined by one is confined by the other.
  mcpRegistry.setSandboxRuntime(options.configManager, sandboxSessionRegistry);
  return { remoteRunnerRegistry, remoteSupervisor, sandboxSessionRegistry, mcpRegistry };
}
