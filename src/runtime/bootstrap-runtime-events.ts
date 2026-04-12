import type { ConfigManager } from '../config/manager.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import type { AgentEvent, ProviderEvent, RuntimeEventBus, WorkflowEvent } from './events/index.ts';
import type { createDomainDispatch } from './store/index.ts';
import type { WrfcController } from '../agents/wrfc-controller.ts';
import type { AgentManager } from '../tools/agent/index.ts';

const AGENT_STATUS_INTERVAL_MS = 30_000;

export interface BootstrapRuntimeEventBridgeOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly domainDispatch: ReturnType<typeof createDomainDispatch>;
  readonly getSystemMessageRouter: () => SystemMessageRouter | null;
  readonly requestRender: () => void;
  readonly configManager: ConfigManager;
  readonly agentManager: AgentManager;
  readonly wrfcController: WrfcController;
}

function withRouter(
  getSystemMessageRouter: () => SystemMessageRouter | null,
  action: (router: SystemMessageRouter) => void,
): void {
  const router = getSystemMessageRouter();
  if (router) action(router);
}

function buildCohortReport(agentManager: AgentManager, cohort: string): string {
  const agents = agentManager.listByCohort(cohort);
  if (agents.length === 0) return `[Agents] Cohort '${cohort}' complete (no agents found).`;
  const completed = agents.filter((agent) => agent.status === 'completed').length;
  const failed = agents.filter((agent) => agent.status === 'failed').length;
  const cancelled = agents.filter((agent) => agent.status === 'cancelled').length;
  const lines: string[] = [
    `[Agents] Cohort '${cohort}' complete: ${completed} completed, ${failed} failed, ${cancelled} cancelled (${agents.length} total)`,
  ];
  for (const agent of agents) {
    const durationSeconds = agent.completedAt !== undefined ? Math.round((agent.completedAt - agent.startedAt) / 1000) : 0;
    const icon = agent.status === 'completed' ? '\u2713' : agent.status === 'failed' ? '\u2717' : '~';
    const errorSuffix = agent.error ? ` \u2014 ${agent.error.slice(0, 60)}` : '';
    lines.push(`  ${icon} ${agent.id.slice(-8)}: ${agent.status} in ${durationSeconds}s (${agent.toolCallCount} tool calls)${errorSuffix}`);
  }
  return lines.join('\n');
}

function checkCohortCompletion(
  agentManager: AgentManager,
  wrfcController: WrfcController,
  record: { cohort?: string } | null,
  getSystemMessageRouter: () => SystemMessageRouter | null,
): void {
  if (!record?.cohort) return;
  const cohortAgents = agentManager.listByCohort(record.cohort);
  const allAgentsDone = cohortAgents.every((agent) => agent.status !== 'running' && agent.status !== 'pending');
  if (!allAgentsDone) return;

  const allChains = wrfcController.listChains();
  const cohortAgentIds = new Set(cohortAgents.map((agent) => agent.id));
  const cohortChains = allChains.filter((chain) =>
    (chain.engineerAgentId && cohortAgentIds.has(chain.engineerAgentId))
      || (chain.reviewerAgentId && cohortAgentIds.has(chain.reviewerAgentId))
      || (chain.fixerAgentId && cohortAgentIds.has(chain.fixerAgentId)),
  );
  const terminalStates = new Set(['passed', 'failed']);
  const allChainsDone = cohortChains.every((chain) => terminalStates.has(chain.state));
  if (!allChainsDone) return;

  withRouter(getSystemMessageRouter, (router) => {
    router.low(buildCohortReport(agentManager, record.cohort!));
  });
}

export function registerBootstrapRuntimeEvents(
  options: BootstrapRuntimeEventBridgeOptions,
): { unsubs: Array<() => void>; agentStatusIntervalRef: { value: ReturnType<typeof setInterval> | null } } {
  const {
    runtimeBus,
    domainDispatch,
    getSystemMessageRouter,
    requestRender,
    configManager,
    agentManager,
    wrfcController,
  } = options;
  const unsubs: Array<() => void> = [];

  unsubs.push(runtimeBus.onDomain('turn', (env) => {
    domainDispatch.dispatchTurnEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('agents', (env) => {
    domainDispatch.dispatchAgentEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('orchestration', (env) => {
    domainDispatch.dispatchOrchestrationEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('communication', (env) => {
    domainDispatch.dispatchCommunicationEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('compaction', (env) => {
    domainDispatch.dispatchCompactionEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('transport', (env) => {
    domainDispatch.dispatchTransportEvent(env.payload);
  }));

  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CASCADE_ABORTED' }>>('WORKFLOW_CASCADE_ABORTED', ({ payload }) => {
    withRouter(getSystemMessageRouter, (router) => {
      router.wrfc(`[WRFC] Cascade abort: ${payload.reason} (chain ${payload.chainId})`);
    });
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<ProviderEvent, { type: 'MODEL_FALLBACK' }>>('MODEL_FALLBACK', ({ payload }) => {
    withRouter(getSystemMessageRouter, (router) => {
      router.high(`[Model] ${payload.from} exhausted across all providers. Automatically falling back to ${payload.to} via ${payload.provider}.`);
    });
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_CREATED' }>>('WORKFLOW_CHAIN_CREATED', ({ payload }) => {
    withRouter(getSystemMessageRouter, (router) => {
      router.wrfc(`[WRFC] Chain ${payload.chainId} started: ${payload.task}`);
    });
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_REVIEW_COMPLETED' }>>('WORKFLOW_REVIEW_COMPLETED', ({ payload }) => {
    const icon = payload.passed ? '\u2713' : '\u2717';
    const threshold = configManager.get('wrfc.scoreThreshold') as number;
    const suffix = payload.passed ? '' : ` - Minimum score is ${threshold}/10, spawning a fix agent ...`;
    withRouter(getSystemMessageRouter, (router) => {
      router.wrfc(`[WRFC] ${icon} Review ${payload.chainId.slice(0, 12)}: ${payload.score}/10${suffix}`);
    });
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_PASSED' }>>('WORKFLOW_CHAIN_PASSED', ({ payload }) => {
    withRouter(getSystemMessageRouter, (router) => {
      router.wrfc(`[WRFC] \u2713 Chain ${payload.chainId.slice(0, 12)} PASSED \u2014 all gates clear`);
    });
    const chain = wrfcController.getChain(payload.chainId);
    if (chain?.engineerAgentId) {
      const record = agentManager.getStatus(chain.engineerAgentId);
      checkCohortCompletion(agentManager, wrfcController, record ?? null, getSystemMessageRouter);
    }
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_FAILED' }>>('WORKFLOW_CHAIN_FAILED', ({ payload }) => {
    withRouter(getSystemMessageRouter, (router) => {
      router.wrfc(`[WRFC] \u2717 Chain ${payload.chainId.slice(0, 12)} FAILED: ${payload.reason.slice(0, 80)}`);
    });
    const chain = wrfcController.getChain(payload.chainId);
    if (chain?.engineerAgentId) {
      const record = agentManager.getStatus(chain.engineerAgentId);
      checkCohortCompletion(agentManager, wrfcController, record ?? null, getSystemMessageRouter);
    }
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_AUTO_COMMITTED' }>>('WORKFLOW_AUTO_COMMITTED', ({ payload }) => {
    const suffix = payload.commitHash ? ` (${payload.commitHash.slice(0, 7)})` : '';
    withRouter(getSystemMessageRouter, (router) => {
      router.wrfc(`[WRFC] Auto-committed chain ${payload.chainId.slice(0, 12)}${suffix}`);
    });
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_GATE_RESULT' }>>('WORKFLOW_GATE_RESULT', ({ payload }) => {
    const icon = payload.passed ? '\u2713' : '\u2717';
    withRouter(getSystemMessageRouter, (router) => {
      router.wrfc(`[WRFC]   ${icon} Gate: ${payload.gate} ${payload.passed ? 'passed' : 'FAILED'}`);
    });
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_STREAM_DELTA' }>>('AGENT_STREAM_DELTA', () => {
    requestRender();
  }));
  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_PROGRESS' }>>('AGENT_PROGRESS', () => {
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => {
    const record = agentManager.getStatus(payload.agentId);
    if (record) {
      const durationSeconds = record.completedAt !== undefined ? Math.round((record.completedAt - record.startedAt) / 1000) : 0;
      const taskSnippet = record.task.length > 50 ? `${record.task.slice(0, 50)}\u2026` : record.task;
      withRouter(getSystemMessageRouter, (router) => {
        router.low(`[Agents] \u2713 ${record.template} ${payload.agentId.slice(-8)}: "${taskSnippet}" \u2014 completed in ${durationSeconds}s (${record.toolCallCount} tool calls)`);
      });
    }
    checkCohortCompletion(agentManager, wrfcController, record ?? null, getSystemMessageRouter);
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>('AGENT_FAILED', ({ payload }) => {
    const record = agentManager.getStatus(payload.agentId);
    if (record && record.status !== 'cancelled') {
      const durationSeconds = record.completedAt !== undefined ? Math.round((record.completedAt - record.startedAt) / 1000) : 0;
      const taskSnippet = record.task.length > 50 ? `${record.task.slice(0, 50)}\u2026` : record.task;
      withRouter(getSystemMessageRouter, (router) => {
        router.low(`[Agents] \u2717 ${record.template} ${payload.agentId.slice(-8)}: "${taskSnippet}" \u2014 failed in ${durationSeconds}s: ${payload.error.slice(0, 80)}`);
      });
    }
    checkCohortCompletion(agentManager, wrfcController, record ?? null, getSystemMessageRouter);
    requestRender();
  }));

  const agentStatusIntervalRef: { value: ReturnType<typeof setInterval> | null } = { value: null };
  agentStatusIntervalRef.value = setInterval(() => {
    const running = agentManager.list().filter((agent) => agent.status === 'running');
    if (running.length === 0) return;
    const lines = running.map((agent) => `  ${agent.id.slice(-8)}: ${agent.progress ?? agent.status}`);
    withRouter(getSystemMessageRouter, (router) => {
      router.low(`[Agents] ${running.length} running:\n${lines.join('\n')}`);
    });
    requestRender();
  }, AGENT_STATUS_INTERVAL_MS);

  return { unsubs, agentStatusIntervalRef };
}
