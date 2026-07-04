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
} from '@pellux/goodvibes-sdk/platform/orchestration';
export type { OrchestrationEngine } from '@pellux/goodvibes-sdk/platform/orchestration';
import { AdaptivePlanner, type DecompositionGate, type PlannerInputs } from '@pellux/goodvibes-sdk/platform/core';
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

/** A not-yet-launched /workstream proposal. See this file's header doc for why it lives here rather than on the engine. */
export interface WorkstreamDraft {
  readonly id: string;
  task: string;
  spec: CreateWorkstreamInput;
  readonly gate: DecompositionGate;
  approved: boolean;
  readonly createdAt: number;
}

/** `ctx.session.workstreamEngine`'s real shape: the live engine plus the draft-proposal bookkeeping the engine itself has no concept of. */
export interface WorkstreamCommandService {
  readonly engine: OrchestrationEngine;
  proposeDraft(task: string): WorkstreamDraft;
  getDraft(id: string): WorkstreamDraft | undefined;
  listDrafts(): WorkstreamDraft[];
  /** Re-derive a held draft's spec from a new task string. Clears any prior approval — an edit must be re-approved. */
  editDraft(id: string, task: string): WorkstreamDraft | undefined;
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

function createWorkstreamCommandService(
  engine: OrchestrationEngine,
  adaptivePlanner: AdaptivePlanner,
  configManager: Pick<ConfigManager, 'get' | 'getCategory'>,
): WorkstreamCommandService {
  const drafts = new Map<string, WorkstreamDraft>();

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
    proposeDraft(task: string): WorkstreamDraft {
      const { gate } = adaptivePlanner.proposeWorkstream(buildPlannerInputs(task));
      const draft: WorkstreamDraft = {
        id: `wsd_${crypto.randomUUID().slice(0, 8)}`,
        task,
        spec: buildSpec(task),
        gate,
        approved: false,
        createdAt: Date.now(),
      };
      drafts.set(draft.id, draft);
      return draft;
    },
    getDraft: (id) => drafts.get(id),
    listDrafts: () => Array.from(drafts.values()).sort((a, b) => a.createdAt - b.createdAt),
    editDraft(id, task) {
      const draft = drafts.get(id);
      if (!draft) return undefined;
      draft.task = task;
      draft.spec = buildSpec(task);
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
 * AgentWorktree(projectRoot) — the same "shared working directory, no real
 * per-item isolation" behavior WrfcController itself uses today (see
 * phase-runner.ts's own REALITY-WINS divergence doc in the SDK).
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
  const workstreamCommands = createWorkstreamCommandService(orchestrationEngine, deps.adaptivePlanner, deps.configManager);
  return { orchestrationEngine, workstreamCommands };
}
