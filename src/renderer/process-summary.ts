export type ProcessSummaryAgent = {
  readonly id: string;
  readonly progress?: string;
};

export type RuntimeProcessSummaryAgent = {
  readonly id: string;
  readonly latestProgress?: string;
};

export type WrfcProcessSummaryChain = {
  readonly state?: string;
  readonly ownerAgentId?: string;
  readonly engineerAgentId?: string;
  readonly reviewerAgentId?: string;
  readonly fixerAgentId?: string;
  readonly allAgentIds?: readonly unknown[];
};

export type RunningAgentSummary = {
  readonly count: number;
  readonly progress?: string;
};

export function summarizeRunningAgents(
  managerAgents: readonly ProcessSummaryAgent[],
  runtimeAgents: readonly RuntimeProcessSummaryAgent[],
  wrfcChains: readonly WrfcProcessSummaryChain[],
): RunningAgentSummary {
  const runningAgentIds = new Set<string>();
  let progress: string | undefined;

  for (const agent of managerAgents) {
    runningAgentIds.add(agent.id);
    if (!progress && agent.progress) progress = agent.progress;
  }

  for (const agent of runtimeAgents) {
    runningAgentIds.add(agent.id);
    if (!progress && agent.latestProgress) progress = agent.latestProgress;
  }

  for (const chain of wrfcChains) {
    if (isTerminalWrfcState(chain.state)) continue;
    const chainAgentIds = collectChainAgentIds(chain);
    const hasVisibleChainWork = Array.from(chainAgentIds).some((id) => runningAgentIds.has(id));
    if (!hasVisibleChainWork || !chain.ownerAgentId) continue;
    runningAgentIds.add(chain.ownerAgentId);
    if (!progress) progress = `WRFC chain ${chain.state ?? 'running'}`;
  }

  return { count: runningAgentIds.size, progress };
}

function isTerminalWrfcState(state: string | undefined): boolean {
  return state === 'passed' || state === 'failed';
}

function collectChainAgentIds(chain: WrfcProcessSummaryChain): Set<string> {
  return new Set([
    chain.ownerAgentId,
    chain.engineerAgentId,
    chain.reviewerAgentId,
    chain.fixerAgentId,
    ...(chain.allAgentIds ?? []),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0));
}
