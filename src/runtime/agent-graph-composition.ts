/**
 * agent-graph-composition.ts — the graph that runs agents.
 *
 * Six collaborators that are only meaningful as a set, so they are built as
 * one: a message bus, the archetype loader, the orchestrator that executes a
 * run, the manager that owns the records, the context-accounting holder, and
 * the WRFC controller. Every one of them holds a reference to at least one
 * other, and two of the links are circular — the orchestrator writes
 * conversation snapshots back through the manager, and the manager drives the
 * WRFC controller which was built from the manager. Assembled anywhere but in
 * one place, a half-wired graph looks correct and silently drops either the
 * snapshot bridge or the review loop.
 *
 * It is also the graph whose runs `cancelHostedAgentRuns` cancels at disposal:
 * the manager returned here is the one the runtime hands to the SDK's
 * `cancelAllAgentRuns`.
 */
import { join } from 'node:path';
import { AgentMessageBus, AgentOrchestrator, ArchetypeLoader, WrfcController } from '@pellux/goodvibes-sdk/platform/agents';
import { AgentManager, ContextAccountingHolder } from '@pellux/goodvibes-sdk/platform/tools';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { RuntimeEventBus } from '@/runtime/index.ts';

export interface AgentGraph {
  readonly agentMessageBus: AgentMessageBus;
  readonly archetypeLoader: ArchetypeLoader;
  readonly agentOrchestrator: AgentOrchestrator;
  readonly agentManager: AgentManager;
  readonly contextAccountingHolder: ContextAccountingHolder;
  readonly wrfcController: WrfcController;
}

/** Build the agent-execution graph, fully wired in both directions. */
export function createAgentGraph(options: {
  readonly runtimeBus: RuntimeEventBus;
  readonly workingDirectory: string;
  readonly configManager: ConfigManager;
  readonly providerRegistry: ProviderRegistry;
}): AgentGraph {
  const agentMessageBus = new AgentMessageBus();
  agentMessageBus.setRuntimeBus(options.runtimeBus);
  const archetypeLoader = new ArchetypeLoader(join(options.workingDirectory, '.goodvibes', 'agents'));
  const agentOrchestrator = new AgentOrchestrator({
    messageBus: agentMessageBus,
  });
  agentOrchestrator.setRuntimeBus(options.runtimeBus);
  const agentManager = new AgentManager({
    archetypeLoader,
    messageBus: agentMessageBus,
    executor: agentOrchestrator,
    configManager: options.configManager,
    // The live registry lets a bare model id in a spawn() override resolve
    // through the shared resolver instead of being rejected as unqualified.
    providerRegistry: options.providerRegistry,
  });
  const contextAccountingHolder = new ContextAccountingHolder();
  // Conversation-snapshot bridge (mirrors the SDK's own createRuntimeServices).
  agentOrchestrator.setConversationSink({
    register: (agentId, source) => agentManager.registerConversationSource(agentId, source),
    release: (agentId) => agentManager.releaseConversationSource(agentId),
  });
  agentManager.setRuntimeBus(options.runtimeBus);
  const wrfcController = new WrfcController(options.runtimeBus, agentMessageBus, {
    agentManager,
    configManager: options.configManager,
    projectRoot: options.workingDirectory,
  });
  agentManager.setWrfcController(wrfcController);
  return {
    agentMessageBus,
    archetypeLoader,
    agentOrchestrator,
    agentManager,
    contextAccountingHolder,
    wrfcController,
  };
}
