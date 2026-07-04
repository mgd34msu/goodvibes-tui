// ---------------------------------------------------------------------------
// workstream-services.ts — Wave 4 (wo703)
//
// Constructs the TUI's OrchestrationEngine instance (@pellux/goodvibes-sdk/
// platform/orchestration, landed on SDK main as wo701/W4.1) and a thin
// command-facing facade around it. Extracted into its own module rather than
// built inline in services.ts: services.ts sits at the architecture check's
// 800-line cap (scripts/check-architecture.ts), so any new service gets its
// own construction module and a single wiring call there (mirrors
// createWorkflowServices's one-function-bundle shape).
//
// Why a facade, not the bare engine: createOrchestrationEngine() is a pure
// construction call with no auto-start and NO concept of a not-yet-launched
// "proposal" a human can review/edit before anything is spent — its only
// creation entry point, createWorkstream(), immediately materializes a real,
// ticking-eligible Workstream. The /workstream command module
// (input/commands/workstream-runtime.ts) needs a create -> propose -> approve
// -> launch flow (Pillar-3 doctrine: render the plan in the transcript before
// spending anything, mirroring /plan's approve step). REALITY-WINS DIVERGENCE
// from the wo703 design brief: the brief recommended an "engine-owned/
// journal-backed" draft so `/workstream status` could re-render a pending
// proposal after a restart; the real engine (verified against the linked SDK
// build) exposes no pre-creation draft concept at all, so WorkstreamDraft
// below is process-lifetime-only state, owned by this module's facade
// instance (constructed once, threaded onto CommandContext) — never a
// module-level ambient global. A draft that existed only in memory is lost on
// restart, same as an unsent chat draft; that is a real, stated limitation,
// not a bug.
// ---------------------------------------------------------------------------

import {
  createOrchestrationEngine,
  fromChainSpec,
  type CreateWorkstreamInput,
  type OrchestrationEngine,
  type WorkstreamIsolation,
} from '@pellux/goodvibes-sdk/platform/orchestration';
export type { OrchestrationEngine } from '@pellux/goodvibes-sdk/platform/orchestration';
import {
  AdaptivePlanner,
  decomposeGoal,
  type DecompositionGate,
  type DecompositionServiceConfig,
  type DecomposeGoalResult,
  type PlannerInputs,
  type PlanProposal,
} from '@pellux/goodvibes-sdk/platform/core';
import { createAgentManagerDecompositionRunner } from '@pellux/goodvibes-sdk/platform/agents';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { AgentManager } from '@pellux/goodvibes-sdk/platform/tools';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import { calcSessionCost, isModelPriced } from '../export/cost-utils.ts';

export interface WorkstreamServicesDeps {
  readonly agentManager: Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel' | 'registerCancellationSignal' | 'releaseCancellationSignal'>;
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly adaptivePlanner: AdaptivePlanner;
  readonly runtimeBus: RuntimeEventBus;
  readonly projectRoot: string;
}

/**
 * Honest provenance for how a draft's decomposition was produced. Derived from
 * the SDK decomposition service's outcome so the draft render can state plainly
 * whether a planning agent decomposed the goal, or the heuristic path did (and
 * if so, why).
 */
export interface WorkstreamDraftProvenance {
  readonly kind: 'agent' | 'heuristic-configured' | 'gate-declined' | 'fallback';
  readonly itemCount: number;
  readonly agentCostUsd?: number | undefined;
  readonly agentTokens?: number | undefined;
  readonly elapsedMs?: number | undefined;
  readonly fallbackReason?: string | undefined;
}

/** A not-yet-launched /workstream proposal. See this file's header doc for why it lives here rather than on the engine. */
export interface WorkstreamDraft {
  readonly id: string;
  task: string;
  spec: CreateWorkstreamInput;
  readonly gate: DecompositionGate;
  /** The engine-agnostic decomposition proposal (model- or heuristic-produced). */
  proposal: PlanProposal;
  /** How that proposal came to be, for honest rendering. */
  provenance: WorkstreamDraftProvenance;
  approved: boolean;
  readonly createdAt: number;
}

/** `ctx.session.workstreamEngine`'s real shape: the live engine plus the draft-proposal bookkeeping the engine itself has no concept of. */
export interface WorkstreamCommandService {
  readonly engine: OrchestrationEngine;
  /** Spawn a bounded read-only planning agent to decompose the goal (with automatic heuristic fallback), then hold the draft. Async because the planning agent is real. `isolation` omitted ⇒ the engine's own default ('shared'); see CreateWorkstreamInput.isolation (SDK). */
  proposeDraft(task: string, isolation?: WorkstreamIsolation): Promise<WorkstreamDraft>;
  getDraft(id: string): WorkstreamDraft | undefined;
  listDrafts(): WorkstreamDraft[];
  /** Re-derive a held draft's spec + decomposition from a new task string. Clears any prior approval — an edit must be re-approved. `isolation` omitted ⇒ keeps the draft's current choice (an edit that only changes the task text must not silently reset isolation back to shared). */
  editDraft(id: string, task: string, isolation?: WorkstreamIsolation): Promise<WorkstreamDraft | undefined>;
  approveDraft(id: string): WorkstreamDraft | undefined;
  removeDraft(id: string): boolean;
  /** Materialize an approved draft into a real, running Workstream (engine.createWorkstream + start), then drop the draft. Null when the draft is missing or not approved. */
  launchDraft(id: string): { workstreamId: string } | null;
}

export interface WorkstreamServices {
  readonly orchestrationEngine: OrchestrationEngine;
  readonly workstreamCommands: WorkstreamCommandService;
}

/**
 * Placeholder planner inputs until a richer risk/latency signal is wired in.
 * `/workstream create` is inherently a multi-step authoring surface, so
 * isMultiStep is always true; the rest are neutral defaults that let
 * AdaptivePlanner's real scoring run rather than short-circuiting it.
 */
function buildPlannerInputs(task: string): PlannerInputs {
  return {
    riskScore: 0.3,
    latencyBudgetMs: Number.POSITIVE_INFINITY,
    isMultiStep: true,
    remoteAvailable: false,
    backgroundEligible: false,
    taskDescription: task,
  };
}

/**
 * Read the planner decomposition config (mode + bounds) from the config
 * manager, defensively defaulting anything missing or invalid. Real config
 * always supplies the DEFAULT_CONFIG values; these fallbacks matter only for a
 * partially-stubbed config manager, and guarantee finite positive bounds so a
 * planning-agent poll can never loop forever on a NaN deadline.
 */
function readDecompositionConfig(configManager: Pick<ConfigManager, 'get'>): DecompositionServiceConfig {
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  return {
    mode: configManager.get('planner.decomposition') === 'heuristic' ? 'heuristic' : 'agent',
    bounds: {
      maxTurns: num(configManager.get('planner.maxTurns'), 6),
      tokenCeiling: num(configManager.get('planner.tokenCeiling'), 120_000),
      wallTimeoutMs: num(configManager.get('planner.wallTimeoutMs'), 60_000),
    },
  };
}

/** Honest cost estimator: prices the planning agent's tokens only when the
 *  session's default model is one we actually have pricing for; otherwise the
 *  render falls back to a raw token count. Never throws. */
function makeCostEstimator(configManager: Pick<ConfigManager, 'get'>): (usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined }) => number | undefined {
  return (usage) => {
    try {
      const model = configManager.get('provider.model') as unknown as string | undefined;
      if (!model || !isModelPriced(model)) return undefined;
      return calcSessionCost(usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0, model);
    } catch {
      return undefined;
    }
  };
}

function toProvenance(result: DecomposeGoalResult): WorkstreamDraftProvenance {
  const p = result.proposal;
  const kind: WorkstreamDraftProvenance['kind'] =
    result.outcome.kind === 'agent' ? 'agent'
      : result.outcome.kind === 'heuristic-configured' ? 'heuristic-configured'
        : result.outcome.kind === 'gate-declined' ? 'gate-declined'
          : 'fallback';
  return {
    kind,
    itemCount: p.workItems.length,
    ...(p.agentCostUsd !== undefined ? { agentCostUsd: p.agentCostUsd } : {}),
    ...(p.agentUsage ? { agentTokens: p.agentUsage.totalTokens } : {}),
    ...(p.elapsedMs !== undefined ? { elapsedMs: p.elapsedMs } : {}),
    ...(p.fallbackReason ? { fallbackReason: p.fallbackReason } : {}),
  };
}

function createWorkstreamCommandService(
  engine: OrchestrationEngine,
  adaptivePlanner: AdaptivePlanner,
  configManager: Pick<ConfigManager, 'get' | 'getCategory'>,
  agentManager: Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel'>,
  projectRoot: string,
): WorkstreamCommandService {
  const drafts = new Map<string, WorkstreamDraft>();

  /**
   * Run the SDK decomposition service: it spawns a bounded, read-only planning
   * agent (which surfaces in the fleet like any agent — kill/steer reach it,
   * and a kill lands as a 'cancelled' fallback) and validates its structured
   * output, or falls back to the heuristic single-item path on any failure.
   * The returned proposal is engine-agnostic; the launchable `spec` is still
   * derived by `buildSpec` (see below).
   */
  async function decompose(task: string): Promise<DecomposeGoalResult> {
    const runner = createAgentManagerDecompositionRunner({ agentManager });
    return decomposeGoal(
      { goal: task, workingDir: projectRoot, constraints: {} },
      adaptivePlanner,
      buildPlannerInputs(task),
      readDecompositionConfig(configManager),
      runner,
      { estimateCostUsd: makeCostEstimator(configManager) },
    );
  }

  /**
   * fromChainSpec is the SDK's own bridge from "a task string" to a real,
   * launchable engineer -> review CreateWorkstreamInput — the same two-phase
   * shape WrfcController.createChain would otherwise start (see
   * controller-compat.ts). AdaptivePlanner.proposeWorkstream's own
   * PlanProposal is deliberately NOT used for the rendered shape: it always
   * degrades to a fictional single-phase fallback in this wave (nothing yet
   * supplies it a `raw` LLM decomposition — no planning-agent-spawn pipeline
   * exists in the shipped SDK surface this item compiles against), which
   * would silently disagree with what launchDraft actually creates. Showing
   * the real fromChainSpec shape keeps the proposal and the launch
   * byte-for-byte the same plan. proposeWorkstream is still called (below)
   * for its `gate` — the real strategy/reason-code rationale — which stays
   * meaningful even without a raw decomposition.
   */
  function buildSpec(task: string): CreateWorkstreamInput {
    return fromChainSpec({ id: `item-${crypto.randomUUID().slice(0, 8)}`, task }, configManager);
  }

  return {
    engine,
    async proposeDraft(task: string, isolation?: WorkstreamIsolation): Promise<WorkstreamDraft> {
      const result = await decompose(task);
      const spec = buildSpec(task);
      const draft: WorkstreamDraft = {
        id: `wsd_${crypto.randomUUID().slice(0, 8)}`,
        task,
        spec: isolation ? { ...spec, isolation } : spec,
        gate: result.gate,
        proposal: result.proposal,
        provenance: toProvenance(result),
        approved: false,
        createdAt: Date.now(),
      };
      drafts.set(draft.id, draft);
      return draft;
    },
    getDraft: (id) => drafts.get(id),
    listDrafts: () => Array.from(drafts.values()).sort((a, b) => a.createdAt - b.createdAt),
    async editDraft(id, task, isolation) {
      const draft = drafts.get(id);
      if (!draft) return undefined;
      const result = await decompose(task);
      const nextIsolation = isolation ?? draft.spec.isolation;
      draft.task = task;
      draft.spec = { ...buildSpec(task), isolation: nextIsolation };
      draft.proposal = result.proposal;
      draft.provenance = toProvenance(result);
      draft.approved = false;
      return draft;
    },
    approveDraft(id) {
      const draft = drafts.get(id);
      if (!draft) return undefined;
      draft.approved = true;
      return draft;
    },
    removeDraft: (id) => drafts.delete(id),
    launchDraft(id) {
      const draft = drafts.get(id);
      if (!draft || !draft.approved) return null;
      const workstream = engine.createWorkstream(draft.spec);
      engine.start(workstream.id);
      drafts.delete(id);
      return { workstreamId: workstream.id };
    },
  };
}

/**
 * Constructs the TUI's OrchestrationEngine instance and its command-facing
 * facade. `persist` and `createWorktree` are left at the engine's own
 * defaults: journal-backed snapshots under .goodvibes/orchestration/ (so
 * resumeAllFromDisk below has something to resume) and a plain
 * AgentWorktree(projectRoot) for the (default) `shared`-isolation path.
 * A draft's `isolation: 'worktree'` (see /workstream create --isolation
 * worktree, input/commands/workstream-runtime.ts) opts a single workstream
 * into the SDK's per-item git-worktree isolation (WorktreeIsolationManager,
 * engine-side) instead — the engine, not this facade, owns that lifecycle.
 */
export function createWorkstreamServices(deps: WorkstreamServicesDeps): WorkstreamServices {
  const orchestrationEngine = createOrchestrationEngine({
    agentManager: deps.agentManager,
    configManager: deps.configManager,
    runtimeBus: deps.runtimeBus,
    projectRoot: deps.projectRoot,
    priceUsage: (model, usage) => {
      const modelId = model ?? 'unknown';
      if (!isModelPriced(modelId)) return null;
      return calcSessionCost(usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, modelId);
    },
  });
  // Honest resume: a prior process's still-in-flight workstreams pick back up
  // (and reappear in the fleet tree) instead of silently vanishing on
  // restart. Never throws — persistence.ts guards every read/parse and
  // quarantines an unrecognized snapshot rather than propagating.
  orchestrationEngine.resumeAllFromDisk();
  const workstreamCommands = createWorkstreamCommandService(
    orchestrationEngine,
    deps.adaptivePlanner,
    deps.configManager,
    deps.agentManager,
    deps.projectRoot,
  );
  return { orchestrationEngine, workstreamCommands };
}
