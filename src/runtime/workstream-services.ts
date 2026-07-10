// ---------------------------------------------------------------------------
// workstream-services.ts — phase/work-item orchestration engine
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
// from the wo703 design brief: the brief recommended an ENGINE-owned draft; the
// real engine (verified against the linked SDK build) exposes no pre-creation
// draft concept at all, so WorkstreamDraft below is TUI-owned state, held on
// this module's facade instance (constructed once, threaded onto
// CommandContext) — never a module-level ambient global. Durability is
// likewise TUI-owned: rather than leaving the brief's restart requirement
// unmet, the facade journals every draft to disk through
// workstream-draft-store.ts (a drafts/ subdirectory ALONGSIDE the engine's own
// workstream snapshots) and reloads them at construction, so a create / reshape
// / approve done before a restart is still here to launch afterward. The engine
// gains no draft concept; the TUI persists its OWN facade state. A journal
// write that fails degrades to in-memory-only for that one draft — never a
// crash — and the store never resurrects a launched draft (its snapshot is
// removed the moment the engine takes ownership).
// ---------------------------------------------------------------------------

import {
  createOrchestrationEngine,
  fromChainSpec,
  fromPlanProposal,
  type CreateWorkstreamInput,
  type OrchestrationEngine,
  type WorkstreamIsolation,
} from '@pellux/goodvibes-sdk/platform/orchestration';
export type { OrchestrationEngine } from '@pellux/goodvibes-sdk/platform/orchestration';
import {
  AdaptivePlanner,
  decomposeGoal,
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
import { editItemBrief, moveItemInSpec, removeItemFromSpec } from './workstream-draft-edits.ts';
import { createWorkstreamDraftStore } from './workstream-draft-store.ts';

export interface WorkstreamServicesDeps {
  readonly agentManager: Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel' | 'registerCancellationSignal' | 'releaseCancellationSignal'>;
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly adaptivePlanner: AdaptivePlanner;
  readonly runtimeBus: RuntimeEventBus;
  readonly projectRoot: string;
}

// WorkstreamDraft + WorkstreamDraftProvenance live in workstream-draft-types.ts
// (so the durable store can persist them without an import cycle) and are
// re-exported here so every existing importer keeps its import site unchanged.
export type { WorkstreamDraft, WorkstreamDraftProvenance } from './workstream-draft-types.ts';
import type { WorkstreamDraft, WorkstreamDraftProvenance } from './workstream-draft-types.ts';

/** `ctx.session.workstreamEngine`'s real shape: the live engine plus the draft-proposal bookkeeping the engine itself has no concept of. */
export interface WorkstreamCommandService {
  readonly engine: OrchestrationEngine;
  /** Spawn a bounded read-only planning agent to decompose the goal (with automatic heuristic fallback), then hold the draft. Async because the planning agent is real. `isolation` omitted ⇒ the engine's own default ('shared'); see CreateWorkstreamInput.isolation (SDK). */
  proposeDraft(task: string, isolation?: WorkstreamIsolation): Promise<WorkstreamDraft>;
  getDraft(id: string): WorkstreamDraft | undefined;
  listDrafts(): WorkstreamDraft[];
  /** Re-derive a held draft's spec + decomposition from a new task string. Clears any prior approval — an edit must be re-approved. `isolation` omitted ⇒ keeps the draft's current choice (an edit that only changes the task text must not silently reset isolation back to shared). */
  editDraft(id: string, task: string, isolation?: WorkstreamIsolation): Promise<WorkstreamDraft | undefined>;
  /**
   * Plan-review-gate item edits over a held draft's launchable spec (see
   * workstream-draft-edits.ts). Each returns the updated draft on success,
   * `{ error }` with an honest user-facing reason on a bad reference/argument,
   * or `undefined` when no draft with that id is held. Every successful edit
   * clears approval — a reshaped plan must be re-approved before launch.
   */
  editItem(id: string, itemRef: string, brief: string): WorkstreamDraft | { error: string } | undefined;
  removeItem(id: string, itemRef: string): WorkstreamDraft | { error: string } | undefined;
  moveItem(id: string, itemRef: string, toPosition: number): WorkstreamDraft | { error: string } | undefined;
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

  // TUI-side draft journal (workstream-draft-store.ts). Load every persisted
  // proposal at construction so a create/reshape/approve done before a restart
  // is still here to launch afterward — the plan-review gate survives restart,
  // exactly as the live-workstream snapshots do via resumeAllFromDisk().
  const store = createWorkstreamDraftStore(projectRoot);
  for (const persisted of store.loadAll()) drafts.set(persisted.id, persisted);

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
   * Derive the launchable CreateWorkstreamInput from the decomposition
   * proposal (BIG-3 — the final stage of the WRFC→orchestration migration).
   *
   * THE BOUNDARY, stated honestly (and in the /workstream help + draft render):
   *  - A genuinely MULTI-ITEM proposal (the planning agent decomposed the goal
   *    into >1 work item) is assembled by the SDK's fromPlanProposal into the
   *    REAL multi-item workstream: one engineer→review-phased item per proposal
   *    item, inter-item dependencies preserved as scheduling constraints, and
   *    workstream-level provenance carried. This is the plan the engine runs —
   *    no flattening.
   *  - A SINGLE-ITEM proposal (the heuristic single-item path, a gate-decline,
   *    or an agent that honestly returned one item) keeps the fromChainSpec
   *    COMPAT path: byte-for-byte the same engineer→review chain
   *    WrfcController.createChain would start. A single item carries no
   *    dependencies and no multi-item structure, so the proposal mapping would
   *    add nothing — the compat path is the honest, unchanged choice.
   *
   * Earlier waves always took the compat path because no planning-agent-spawn
   * pipeline existed to produce a real multi-item decomposition; BIG-2 landed
   * that pipeline, so `result.proposal` can now be a real multi-item plan and
   * this maps it faithfully. The rendered draft shows THIS spec, so the
   * proposal preview and the launch are always the same plan.
   */
  function buildSpec(task: string, proposal: PlanProposal): CreateWorkstreamInput {
    if (proposal.workItems.length > 1) {
      return fromPlanProposal(proposal, configManager);
    }
    return fromChainSpec({ id: `item-${crypto.randomUUID().slice(0, 8)}`, task }, configManager);
  }

  /**
   * Apply a pure item edit (workstream-draft-edits.ts) to a held draft's spec.
   * Threads the three outcomes straight through: `undefined` (no such draft) so
   * the command layer can print its not-found message, `{ error }`
   * (a bad reference/argument) verbatim, or the mutated draft. A successful edit
   * clears approval — a reshaped plan must be re-approved before it can launch.
   */
  function applyItemEdit(
    id: string,
    edit: (spec: CreateWorkstreamInput) => import('./workstream-draft-edits.ts').DraftEditResult,
  ): WorkstreamDraft | { error: string } | undefined {
    const draft = drafts.get(id);
    if (!draft) return undefined;
    const result = edit(draft.spec);
    if ('error' in result) return { error: result.error };
    draft.spec = result.spec;
    draft.approved = false;
    store.save(draft);
    return draft;
  }

  return {
    engine,
    async proposeDraft(task: string, isolation?: WorkstreamIsolation): Promise<WorkstreamDraft> {
      const result = await decompose(task);
      const spec = buildSpec(task, result.proposal);
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
      store.save(draft);
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
      draft.spec = { ...buildSpec(task, result.proposal), isolation: nextIsolation };
      draft.proposal = result.proposal;
      draft.provenance = toProvenance(result);
      draft.approved = false;
      store.save(draft);
      return draft;
    },
    editItem: (id, itemRef, brief) => applyItemEdit(id, (spec) => editItemBrief(spec, itemRef, brief)),
    removeItem: (id, itemRef) => applyItemEdit(id, (spec) => removeItemFromSpec(spec, itemRef)),
    moveItem: (id, itemRef, toPosition) => applyItemEdit(id, (spec) => moveItemInSpec(spec, itemRef, toPosition)),
    approveDraft(id) {
      const draft = drafts.get(id);
      if (!draft) return undefined;
      draft.approved = true;
      store.save(draft); // approval must survive restart too — a resumed approved draft launches straight away
      return draft;
    },
    removeDraft(id) {
      store.remove(id);
      return drafts.delete(id);
    },
    launchDraft(id) {
      const draft = drafts.get(id);
      if (!draft || !draft.approved) return null;
      const workstream = engine.createWorkstream(draft.spec);
      engine.start(workstream.id);
      drafts.delete(id);
      store.remove(id); // launched: the engine now owns it (its own journal), so drop the draft snapshot
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
