import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WrfcWorkmap } from './wrfc-workmap.ts';
import { AgentMessageBus } from './message-bus.ts';
import { AgentManager, type AgentRecord } from '../tools/agent/index.ts';
import { type CompletionReport, type ReviewerReport, parseCompletionReport } from './completion-report.ts';
import type { WrfcChain, WrfcState, QualityGateResult, QueuedChain } from './wrfc-types.ts';
import { AgentWorktree } from './worktree.ts';
import { configManager } from '../config/index.ts';
import { logger } from '../utils/logger.ts';
import { planManager } from '../core/plan-manager-instance.ts';
import type { AgentEvent, RuntimeEventBus } from '../runtime/events/index.ts';
import {
  emitOrchestrationGraphCreated,
  emitOrchestrationNodeAdded,
  emitOrchestrationNodeCompleted,
  emitOrchestrationNodeFailed,
  emitOrchestrationNodeStarted,
  emitWorkflowAutoCommitted,
  emitWorkflowCascadeAborted,
  emitWorkflowChainCreated,
  emitWorkflowChainFailed,
  emitWorkflowChainPassed,
  emitWorkflowFixAttempted,
  emitWorkflowGateResult,
  emitWorkflowReviewCompleted,
  emitWorkflowStateChanged,
} from '../runtime/emitters/index.ts';

type AgentManagerLike = Pick<AgentManager, 'spawn' | 'getStatus' | 'list' | 'cancel' | 'listByCohort' | 'clear'>;
type WrfcConfigLike = {
  scoreThreshold: number;
  maxFixAttempts: number;
  autoCommit: boolean;
  gates: Array<{ name: string; command: string; enabled: boolean }>;
};

let agentManagerResolver: () => AgentManagerLike = () => AgentManager.getInstance();
let wrfcConfigResolver: () => WrfcConfigLike = () => {
  const wrfcConfig = configManager.getCategory('wrfc') as Partial<WrfcConfigLike> | undefined;
  return {
    scoreThreshold:
      typeof configManager.get('wrfc.scoreThreshold') === 'number'
        ? (configManager.get('wrfc.scoreThreshold') as number)
        : wrfcConfig?.scoreThreshold ?? 9.9,
    maxFixAttempts:
      typeof configManager.get('wrfc.maxFixAttempts') === 'number'
        ? (configManager.get('wrfc.maxFixAttempts') as number)
        : wrfcConfig?.maxFixAttempts ?? 3,
    autoCommit:
      typeof configManager.get('wrfc.autoCommit') === 'boolean'
        ? (configManager.get('wrfc.autoCommit') as boolean)
        : wrfcConfig?.autoCommit ?? false,
    gates: Array.isArray(wrfcConfig?.gates) ? wrfcConfig.gates : [],
  };
};

export function _setWrfcAgentManagerResolverForTest(
  resolver: (() => AgentManagerLike) | null,
): void {
  agentManagerResolver = resolver ?? (() => AgentManager.getInstance());
}

export function _setWrfcConfigResolverForTest(
  resolver: (() => WrfcConfigLike) | null,
): void {
  wrfcConfigResolver = resolver ?? (() => {
    const wrfcConfig = configManager.getCategory('wrfc') as Partial<WrfcConfigLike> | undefined;
    return {
      scoreThreshold:
        typeof configManager.get('wrfc.scoreThreshold') === 'number'
          ? (configManager.get('wrfc.scoreThreshold') as number)
          : wrfcConfig?.scoreThreshold ?? 9.9,
      maxFixAttempts:
        typeof configManager.get('wrfc.maxFixAttempts') === 'number'
          ? (configManager.get('wrfc.maxFixAttempts') as number)
          : wrfcConfig?.maxFixAttempts ?? 3,
      autoCommit:
        typeof configManager.get('wrfc.autoCommit') === 'boolean'
          ? (configManager.get('wrfc.autoCommit') as boolean)
          : wrfcConfig?.autoCommit ?? false,
      gates: Array.isArray(wrfcConfig?.gates) ? wrfcConfig.gates : [],
    };
  });
}

/**
 * WrfcController — Event-driven state machine for automated WRFC chains.
 *
 * Lifecycle:
 *   1. Agent spawned without dangerously_disable_wrfc → createChain() → state: engineering
 *   2. Engineer completes → parse report → spawn reviewer → state: reviewing
 *   3. Reviewer completes → check score vs threshold
 *      a. Score >= threshold → state: awaiting_gates (wait for all sibling chains to finish)
 *      b. Score < threshold → spawn fixer → state: fixing → back to step 2
 *   3b. All active chains reach awaiting_gates → run gates ONCE → state: gating
 *   4. Gates pass → auto-commit → state: passed
 *   5. Gates fail → spawn new chain for gate failures (current chain: passed)
 *
 * Max fix attempts per review cycle: configurable (wrfc.maxFixAttempts)
 * Score threshold: configurable (wrfc.scoreThreshold)
 */

// ---------------------------------------------------------------------------
// Score extraction helpers — used when reviewers don't emit structured JSON
// ---------------------------------------------------------------------------

/**
 * Extract a numeric score from unstructured reviewer text.
 * Tries multiple patterns commonly used by LLMs when writing reviews.
 * Returns null if no score found.
 */
export function extractScoreFromText(text: string): number | null {
  // Pattern 1: "Score: X.X/10" or "Score: X/10" (with optional markdown bold)
  const scorePattern = /\*{0,2}(?:overall\s+)?score\s*:?\s*\*{0,2}\s*(\d+(?:\.\d+)?)\s*\/\s*10/i;
  const m1 = text.match(scorePattern);
  if (m1) {
    const val = parseFloat(m1[1]);
    if (val <= 10) return val;
  }

  // Pattern 2: "X.X/10" or "X/10" standalone (common in review summaries)
  const slashPattern = /(\d+(?:\.\d+)?)\s*\/\s*10/;
  const m2 = text.match(slashPattern);
  if (m2) {
    const val = parseFloat(m2[1]);
    if (val <= 10) return val;
  }

  // Pattern 3: "rated X.X" or "scored X.X" or "rating: X.X"
  const ratedPattern = /\b(?:rated|scored|rating)\s*:?\s*(\d+(?:\.\d+)?)/i;
  const m3 = text.match(ratedPattern);
  if (m3) {
    const val = parseFloat(m3[1]);
    if (val <= 10) return val;
  }

  return null;
}

/**
 * Determine if a review passed based on text language and the score vs threshold.
 * Defaults to score-based check, but explicit "passed"/"approved" language overrides.
 */
export function extractPassedFromText(text: string, score: number, threshold: number): boolean {
  if (score >= threshold) return true;
  // Check for explicit pass language absent of fail language
  if (/\bpass(ed|es|ing)?\b/i.test(text) && !/\bfail/i.test(text)) return true;
  if (/\bapproved?\b/i.test(text)) return true;
  return false;
}

/**
 * Extract a list of issues from unstructured reviewer text.
 * Matches numbered or bulleted items with severity markers.
 */
export function extractIssuesFromText(text: string): ReviewerReport['issues'] {
  const issues: ReviewerReport['issues'] = [];
  const issuePattern = /(?:^|\n)\s*(?:\d+\.\s*|-\s*|\*\s*)?(?:\*{1,2})?\[?\(?(critical|major|minor|suggestion)\)?\]?(?:\*{1,2})?[\s:*]*(.+)/gi;
  let match;
  while ((match = issuePattern.exec(text)) !== null) {
    const sev = match[1].toLowerCase() as 'critical' | 'major' | 'minor' | 'suggestion';
    issues.push({
      severity: sev,
      description: match[2].trim(),
      pointValue: sev === 'critical' ? 3 : sev === 'major' ? 2 : 1,
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Partial<Record<WrfcState, WrfcState[]>> = {
  pending:        ['engineering'],
  engineering:    ['reviewing', 'failed'],
  reviewing:      ['fixing', 'awaiting_gates', 'failed'],
  fixing:         ['reviewing', 'failed'],
  awaiting_gates: ['gating', 'failed'],
  gating:         ['passed', 'failed', 'committing'],
  committing:     ['passed', 'failed'],
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of concurrently active (non-terminal) WRFC chains. */
const MAX_ACTIVE_CHAINS = 6;
const CHAIN_CLEANUP_DELAY_MS = 60_000;
const GATE_TIMEOUT_MS = 120_000;

type WorkflowContext = { sessionId: string; traceId: string; source: string };
type RuntimeEventSource = Extract<AgentEvent['type'], 'AGENT_COMPLETED' | 'AGENT_FAILED'>;
type WrfcNodeRole = 'engineer' | 'reviewer' | 'fixer' | 'verifier';

// ---------------------------------------------------------------------------
// WrfcController
// ---------------------------------------------------------------------------

export class WrfcController {
  private static instance: WrfcController | null = null;
  private chains = new Map<string, WrfcChain>();
  private chainQueue: QueuedChain[] = [];
  private unsubscribers: Array<() => void> = [];
  /** Counter of currently active (non-terminal) chains — avoids linear scan on every spawn. */
  private activeChainCount = 0;
  /** Pending parent chain IDs for follow-up agents: agentId → parentChainId. */
  private pendingParentChainIds = new Map<string, string>();
  private sessionId: string;
  private workmap: WrfcWorkmap;
  private runtimeBus: RuntimeEventBus;

  private constructor(runtimeBus: RuntimeEventBus) {
    this.runtimeBus = runtimeBus;
    this.sessionId = crypto.randomUUID().slice(0, 8);
    this.workmap = new WrfcWorkmap(this.sessionId);
    this.setupListeners();
  }

  // ---------------------------------------------------------------------------
  // Singleton
  // ---------------------------------------------------------------------------

  static initialize(runtimeBus: RuntimeEventBus): WrfcController {
    if (!WrfcController.instance) {
      WrfcController.instance = new WrfcController(runtimeBus);
    } else {
      WrfcController.instance.setRuntimeBus(runtimeBus);
    }
    return WrfcController.instance;
  }

  static getInstance(): WrfcController {
    if (!WrfcController.instance) {
      throw new Error('WrfcController must be initialized before use');
    }
    return WrfcController.instance;
  }

  static resetInstance(): void {
    if (WrfcController.instance) {
      WrfcController.instance.dispose();
    }
    WrfcController.instance = null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create a new WRFC chain for the given engineer agent record.
   * Sets chain state to 'engineering' and links the record.
   */
  createChain(engineerRecord: AgentRecord): WrfcChain {
    logger.info('WrfcController.createChain: called', {
      agentId: engineerRecord.id,
      task: engineerRecord.task.slice(0, 60),
      activeChainCount: this.activeChainCount,
    });
    // Check active chain cap — queue if at limit
    const activeCount = this.activeChainCount;

    if (activeCount >= MAX_ACTIVE_CHAINS) {
      const chain = this.createBaseChain(engineerRecord);
      this.chainQueue.push({ record: engineerRecord, queuedAt: Date.now() });

      logger.debug('WrfcController.createChain: at cap, queued', {
        chainId: chain.id,
        agentId: engineerRecord.id,
        activeCount,
        queueLength: this.chainQueue.length,
      });

      this.emitChainCreated(chain.id, chain.task);
      return chain;
    }

    const chain = this.createBaseChain(engineerRecord);
    this.startEngineeringChain(chain, true);

    logger.debug('WrfcController.createChain', { chainId: chain.id, agentId: engineerRecord.id });
    return chain;
  }

  getSessionId(): string { return this.sessionId; }

  getWorkmap(): WrfcWorkmap { return this.workmap; }

  setRuntimeBus(runtimeBus: RuntimeEventBus): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.runtimeBus = runtimeBus;
    this.setupListeners();
  }

  getChain(chainId: string): WrfcChain | null {
    return this.chains.get(chainId) ?? null;
  }

  listChains(): WrfcChain[] {
    return Array.from(this.chains.values());
  }

  dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  // ---------------------------------------------------------------------------
  // State machine
  // ---------------------------------------------------------------------------

  private transition(chain: WrfcChain, to: WrfcState): void {
    const allowed = VALID_TRANSITIONS[chain.state];
    if (!allowed || !allowed.includes(to)) {
      logger.error('WrfcController: illegal state transition', {
        chainId: chain.id,
        from: chain.state,
        to,
      });
      throw new Error(
        `Illegal WRFC transition: ${chain.state} -> ${to} for chain ${chain.id}`
      );
    }

    const from = chain.state;
    chain.state = to;

    emitWorkflowStateChanged(this.runtimeBus, this.workflowContext(chain.id), { chainId: chain.id, from, to });
    logger.debug('WrfcController.transition', { chainId: chain.id, from, to });
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private setupListeners(): void {
    const onComplete = (agentId: string) => {
      this.onAgentComplete(agentId).catch((err) => {
        logger.error('WrfcController.onAgentComplete unhandled error', {
          agentId,
          error: String(err),
        });
      });
    };

    const onError = (agentId: string, errorMessage: string) => {
      this.onAgentFailed(agentId, errorMessage);
    };

    const unsubComplete = this.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => {
      onComplete(payload.agentId);
    });
    const unsubError = this.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>('AGENT_FAILED', ({ payload }) => {
      onError(payload.agentId, payload.error);
    });

    this.unsubscribers.push(unsubComplete, unsubError);
  }

  private async onAgentComplete(agentId: string): Promise<void> {
    const chain = this.findChainByAgentId(agentId);
    if (!chain) {
      // Not a WRFC-tracked agent — ignore
      return;
    }

    // Get the full output from AgentManager
    const record = agentManagerResolver().getStatus(agentId);
    const rawOutput = record?.fullOutput ?? '';

    logger.debug('WrfcController.onAgentComplete', {
      chainId: chain.id,
      agentId,
      state: chain.state,
      outputLength: rawOutput.length,
    });

    if (chain.state === 'pending') {
      // Agent completed while chain was still queued — buffer the result for when it's dequeued
      chain.bufferedCompletion = { agentId, fullOutput: rawOutput };
      logger.debug('WrfcController.onAgentComplete: chain pending, buffering completion', {
        chainId: chain.id,
        agentId,
      });
      return;
    }

    if (chain.state === 'engineering' || chain.state === 'fixing') {
      const report = this.parseEngineerCompletionReport(rawOutput, record?.template);
      this.handleEngineerCompletion(chain, agentId, report);
    } else if (chain.state === 'reviewing') {
      const narrowedReport = this.parseReviewerCompletionReport(chain, rawOutput);
      chain.reviewerReport = narrowedReport;
      chain.reviewCycles += 1;

      await this.processReview(chain, narrowedReport);
    }

    // Auto-update plan items referencing this agent ID to 'complete'.
    const activePlan = planManager.getActive();
    if (activePlan) {
      const matchingItems = activePlan.items.filter(
        item => item.agentId === agentId && item.status !== 'complete' && item.status !== 'failed'
      );
      for (const item of matchingItems) {
        try {
          planManager.updateItem(activePlan.id, item.id, 'complete', agentId);
        } catch (err) {
          logger.warn('WrfcController: failed to auto-update plan item', {
            planId: activePlan.id,
            itemId: item.id,
            agentId,
            error: String(err),
          });
        }
      }
    }

    // After any agent completion, re-check if all chains are now ready for gates.
    // This covers the case where a fixer finishes and all siblings are already awaiting_gates.
    // Skip redundant check if chain already moved past awaiting_gates.
    if (chain && (chain.state === 'gating' || chain.state === 'passed' || chain.state === 'committing')) {
      return;
    }
    await this.checkAndRunGatesForAll();
  }

  private onAgentFailed(agentId: string, errorMessage?: string): void {
    const chain = this.findChainByAgentId(agentId);
    if (!chain) return;

    this.failChain(chain, errorMessage ?? `Agent ${agentId} failed`);
  }

  // ---------------------------------------------------------------------------
  // Review lifecycle
  // ---------------------------------------------------------------------------

  private startReview(chain: WrfcChain, report: CompletionReport): void {
    this.transition(chain, 'reviewing');
    const reviewerRecord = this.spawnWrfcAgent('reviewer', this.buildReviewTask(chain, report), true);

    chain.reviewerAgentId = reviewerRecord.id;
    chain.allAgentIds.push(reviewerRecord.id);
    reviewerRecord.wrfcId = chain.id;
    AgentMessageBus.getInstance().registerAgent({
      agentId: reviewerRecord.id,
      role: 'reviewer',
      wrfcId: chain.id,
    });
    this.startOrchestrationNode(
      chain,
      `review:${chain.reviewCycles + 1}`,
      'reviewer',
      'Reviewer assessment',
      reviewerRecord.id,
    );

    logger.debug('WrfcController.startReview', {
      chainId: chain.id,
      reviewerAgentId: reviewerRecord.id,
    });
  }

  private async processReview(chain: WrfcChain, review: ReviewerReport): Promise<void> {
    const threshold = this.getWrfcScoreThreshold();
    this.completeCurrentNode(
      chain,
      `Score ${review.score}/10${review.passed ? ' passed' : ' needs fixes'}`,
    );

    emitWorkflowReviewCompleted(this.runtimeBus, this.workflowContext(chain.id), {
      chainId: chain.id,
      score: review.score,
      passed: review.passed,
    });

    this.workmap.append({
      ts: new Date().toISOString(), wrfcId: chain.id, event: 'review_complete',
      agentId: chain.reviewerAgentId, score: review.score, passed: review.score >= threshold,
      issues: review.issues?.slice(0, 10).map(i => ({ severity: i.severity, description: i.description, file: i.file })),
    });

    logger.debug('WrfcController.processReview', {
      chainId: chain.id,
      score: review.score,
      threshold,
      fixAttempts: chain.fixAttempts,
    });

    // Track scores for regression detection
    chain.reviewScores.push(review.score);

    if (review.score >= threshold) {
      this.transition(chain, 'awaiting_gates');
      await this.checkAndRunGatesForAll();
    } else {
      // Regression warning: 2 consecutive scores below the initial score
      const scores = chain.reviewScores;
      if (scores.length >= 3) {
        const initial = scores[0];
        const last2 = scores.slice(-2);
        if (last2[0] < initial && last2[1] < initial) {
          this.emitCascadeAbort(
            chain.id,
            `Score regression warning: initial ${initial}/10, last two ${last2[0]}/10, ${last2[1]}/10 — both below initial. Fix quality may be degrading.`,
          );
        }
      }

      // Check if max fix attempts exhausted before starting another fix
      const maxFixAttempts = this.getWrfcMaxFixAttempts();
      if (chain.fixAttempts >= maxFixAttempts) {
        this.failChain(
          chain,
          `Score ${review.score}/10 below threshold ${threshold}/10 after ${chain.fixAttempts} fix attempt${chain.fixAttempts !== 1 ? 's' : ''} — below threshold`,
        );
        return;
      }

      this.startFix(chain, review);
    }
  }

  // ---------------------------------------------------------------------------
  // Fix lifecycle
  // ---------------------------------------------------------------------------

  private startFix(chain: WrfcChain, review: ReviewerReport): void {
    chain.fixAttempts += 1;
    this.transition(chain, 'fixing');

    const maxAttempts = this.getWrfcMaxFixAttempts();
    emitWorkflowFixAttempted(this.runtimeBus, this.workflowContext(chain.id), {
      chainId: chain.id,
      attempt: chain.fixAttempts,
      maxAttempts,
    });

    const fixerRecord = this.spawnWrfcAgent('engineer', this.buildFixTask(chain, review), true);

    chain.fixerAgentId = fixerRecord.id;
    chain.allAgentIds.push(fixerRecord.id);
    fixerRecord.wrfcId = chain.id;
    AgentMessageBus.getInstance().registerAgent({
      agentId: fixerRecord.id,
      role: 'fixer',
      wrfcId: chain.id,
    });
    this.startOrchestrationNode(
      chain,
      `fix:${chain.fixAttempts}`,
      'fixer',
      `Fix attempt ${chain.fixAttempts}`,
      fixerRecord.id,
    );

    this.workmap.append({ ts: new Date().toISOString(), wrfcId: chain.id, event: 'fix_started', agentId: fixerRecord.id, attempt: chain.fixAttempts });

    logger.debug('WrfcController.startFix', {
      chainId: chain.id,
      fixerAgentId: fixerRecord.id,
      attempt: chain.fixAttempts,
    });
  }

  // ---------------------------------------------------------------------------
  // Quality gates
  // ---------------------------------------------------------------------------

  private async runGates(chain: WrfcChain): Promise<QualityGateResult[]> {
    this.transition(chain, 'gating');
    this.startOrchestrationNode(chain, `gate:${chain.reviewCycles}:${chain.fixAttempts}`, 'verifier', 'Quality gates');

    const gates = this.getEnabledGates();

    if (gates.length === 0) {
      logger.debug('WrfcController.runGates: no gates configured', {
        chainId: chain.id,
      });
      return [];
    }

    logger.debug('WrfcController.runGates', {
      chainId: chain.id,
      gateCount: gates.length,
    });

    // Read package.json once for script-based gate checks
    const cwd = process.cwd();
    const pkgScripts = await this.loadPackageScripts(cwd);

    const results: QualityGateResult[] = [];

    for (const gate of gates) {
      const skipReason = this.getSkippedGateReason(gate.name, cwd, pkgScripts);

      if (skipReason !== null) {
        const result: QualityGateResult = {
          gate: gate.name,
          passed: true,
          output: skipReason,
          durationMs: 0,
        };
        results.push(result);
        chain.gateResults = results.slice();
        this.emitGateResult(chain.id, gate.name, true);
        logger.debug('WrfcController.gate-skipped', {
          chainId: chain.id,
          gate: gate.name,
          reason: skipReason,
        });
        continue;
      }

      const startedAt = Date.now();
      let passed = false;
      let output = '';

      ({ passed, output } = await this.executeGateCommand(gate.command));

      const durationMs = Date.now() - startedAt;
      const result: QualityGateResult = {
        gate: gate.name,
        passed,
        output,
        durationMs,
      };

      results.push(result);
      chain.gateResults = results.slice();

      this.emitGateResult(chain.id, gate.name, passed);

      logger.debug('WrfcController.gate-result', {
        chainId: chain.id,
        gate: gate.name,
        passed,
        durationMs,
      });
    }

    return results;
  }

  private async processGateResults(
    chain: WrfcChain,
    results: QualityGateResult[]
  ): Promise<void> {
    if (!chain.currentNodeId?.includes(':gate:')) {
      this.startOrchestrationNode(chain, `gate:${chain.reviewCycles}:${chain.fixAttempts}`, 'verifier', 'Quality gates');
    }
    const allPassed = results.length === 0 || results.every((r) => r.passed);
    const autoCommit = this.getWrfcAutoCommit();

    for (const r of results) {
      this.workmap.append({ ts: new Date().toISOString(), wrfcId: chain.id, event: 'gate_result', gate: r.gate, passed: r.passed, gateOutput: r.output.slice(0, 200) });
    }
    this.completeCurrentNode(
      chain,
      allPassed
        ? 'All quality gates passed'
        : `${results.filter((r) => !r.passed).length} quality gate(s) failed`,
    );

      if (allPassed) {
        this.workmap.append({ ts: new Date().toISOString(), wrfcId: chain.id, event: 'chain_passed' });
        chain.gatesPassed = true;
        if (autoCommit) {
          await this.autoCommit(chain);
        } else {
        this.completeChainAsPassed(chain);
        }
    } else {
      // Gate(s) failed — this chain's review passed, but we spawn a new engineer
      // chain (without dangerously_disable_wrfc) to address the gate failures.

      const failedGates = results.filter((r) => !r.passed);

      // Build fingerprint from failed gate names + first 200 chars of each output
      const fingerprint = failedGates
        .map((r) => `${r.gate}:${r.output.slice(0, 200)}`) 
        .join('|');

      // Use stored depth — no ancestry walk needed (ancestors may be cleaned up after 60s)
      const maxGateRetries = this.getWrfcMaxFixAttempts();

      // Store fingerprint on current chain before transitioning
      chain.gateFailureFingerprint = fingerprint;

      this.completeChainAsPassed(chain);

      if (chain.gateRetryDepth >= maxGateRetries) {
        // Hard cap on gate retries reached — fail, don't spawn more agents
        logger.error(
          'WrfcController.processGateResults: gate retry limit reached, manual intervention required',
          { chainId: chain.id, gateRetryDepth: chain.gateRetryDepth, maxGateRetries }
        );
        this.emitCascadeAbort(
          chain.id,
          `Gate failures exceeded max retries (${chain.gateRetryDepth}/${maxGateRetries}). Manual intervention required.`,
        );
        return;
      }

      const gateFailureSummary = failedGates
        .map((r) => `- ${r.gate}: ${r.output.slice(0, 300)}`)
        .join('\n');

      const followUpTask = [
        `WRFC Gate Failure Fix`,
        `Parent Chain ID: ${chain.id}`,
        ``,
        `The following quality gates failed after review passed:`,
        gateFailureSummary,
        ``,
        `Original task: ${chain.task}`,
        ``,
        `Instructions:`,
        `1. Fix all gate failures listed above.`,
        `2. Ensure typecheck, lint, and test gates pass.`,
        `3. Return a structured EngineerReport in your final response.`,
      ].join('\n');

      const parentChainIdForFollowUp = chain.id;
      const followUpRecord = this.spawnWrfcAgent('engineer', followUpTask, false);

      // If createChain was called synchronously during spawn, the chain already exists.
      // Otherwise, pre-register so createChain will pick up the parent when called.
      const followUpChain = this.findChainByAgentId(followUpRecord.id);
      if (followUpChain) {
        followUpChain.parentChainId = parentChainIdForFollowUp;
      } else {
        this.pendingParentChainIds.set(followUpRecord.id, parentChainIdForFollowUp);
      }

      logger.debug('WrfcController.processGateResults: gate failure — spawned follow-up agent', {
        parentChainId: chain.id,
        followUpAgentId: followUpRecord.id,
      });
    }
  }

  /**
   * Check whether all active work chains (engineering/reviewing/fixing) have finished.
   * If so, transition all awaiting_gates chains to gating and run gates once for all of them.
   */
  private scheduleChainCleanup(chain: WrfcChain): void {
    setTimeout(() => {
      if (chain.state === 'passed' || chain.state === 'failed') {
        this.chains.delete(chain.id);
      }
    }, CHAIN_CLEANUP_DELAY_MS);
  }

  private async checkAndRunGatesForAll(): Promise<void> {
    // Exclude terminal chains from the scan to keep it bounded
    const allChains = Array.from(this.chains.values()).filter(
      (c) => c.state !== 'passed' && c.state !== 'failed'
    );

    // Any chain still doing active work (including pending/queued)? If yes, bail — not time yet.
    const activeWorkChains = allChains.filter((c) =>
      c.state === 'pending' || c.state === 'engineering' || c.state === 'reviewing' || c.state === 'fixing'
    );

    if (activeWorkChains.length > 0) {
      logger.debug('WrfcController.checkAndRunGatesForAll: waiting for active chains', {
        activeWork: activeWorkChains.length,
        awaitingGates: allChains.filter((c) => c.state === 'awaiting_gates').length,
      });
      return;
    }

    // Collect all chains ready for gates
    const readyChains = allChains.filter((c) => c.state === 'awaiting_gates');

    if (readyChains.length === 0) return;

    logger.debug('WrfcController.checkAndRunGatesForAll: all chains ready, running gates', {
      readyCount: readyChains.length,
    });

    // Use first ready chain as the gate runner (gates are project-wide)
    const gateRunner = readyChains[0];
    const results = await this.runGates(gateRunner);

    // Transition all sibling chains from awaiting_gates → gating, then process
    for (const chain of readyChains) {
      if (chain.id !== gateRunner.id) {
        this.transition(chain, 'gating');
        chain.gateResults = results;
      }
      await this.processGateResults(chain, results);
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-commit
  // ---------------------------------------------------------------------------

  private async autoCommit(chain: WrfcChain): Promise<void> {
    this.transition(chain, 'committing');

    // Use the last agent's worktree: prefer fixer, fall back to engineer
    const agentId = chain.allAgentIds.length > 0
      ? chain.allAgentIds[chain.allAgentIds.length - 1]
      : (chain.fixerAgentId ?? chain.engineerAgentId);

    if (!agentId) {
      this.failChain(chain, 'autoCommit: no agent ID found on chain');
      return;
    }

    // Check if project is a git repo before attempting worktree operations
    if (!existsSync(join(process.cwd(), '.git'))) {
      logger.debug('WrfcController.autoCommit: not a git repo, skipping commit', { chainId: chain.id });
      // No actual commit — intentionally skip wrfc:auto-commit event (commit didn't happen)
      this.completeChainAsPassed(chain);
      return;
    }

    const worktree = new AgentWorktree();

    try {
      const merged = await worktree.merge(agentId);

      this.emitAutoCommitted(chain.id);
      this.completeChainAsPassed(chain);

      logger.debug('WrfcController.autoCommit: success', {
        chainId: chain.id,
        agentId,
        merged,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error('WrfcController.autoCommit: failed', { chainId: chain.id, error: reason });
      this.failChain(chain, `autoCommit failed: ${reason}`);
    } finally {
      // Best-effort cleanup — clean all agent worktrees involved in this chain
      for (const id of chain.allAgentIds) {
        worktree.cleanup(id).catch((err) => {
          logger.debug('WrfcController.autoCommit: cleanup error (non-fatal)', {
            agentId: id,
            error: String(err),
          });
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Failure
  // ---------------------------------------------------------------------------

  private failChain(chain: WrfcChain, reason: string): void {
    // Remove from queue if chain was pending (never started)
    if (chain.state === 'pending') {
      this.chainQueue = this.chainQueue.filter(q => q.record.id !== chain.engineerAgentId);
    }

    const wasActive = chain.state !== 'passed' && chain.state !== 'failed' && chain.state !== 'pending';
    this.failCurrentNode(chain, reason);
    try {
      this.transition(chain, 'failed');
    } catch {
      // Already failed or in a state that can't transition — force it
      chain.state = 'failed';
    }

    if (wasActive) {
      this.activeChainCount = Math.max(0, this.activeChainCount - 1);
    }

    chain.error = reason;
    chain.completedAt = Date.now();

    this.workmap.append({ ts: new Date().toISOString(), wrfcId: chain.id, event: 'chain_failed', reason });

    emitWorkflowChainFailed(this.runtimeBus, this.workflowContext(chain.id), { chainId: chain.id, reason });

    logger.error('WrfcController.failChain', { chainId: chain.id, reason });

    this.scheduleChainCleanup(chain);
    this.safeDequeueNext();
  }

  // ---------------------------------------------------------------------------
  // Queue management
  // ---------------------------------------------------------------------------

  /**
   * Dequeue the next waiting chain and start it, if the active cap allows.
   * Called whenever a chain reaches a terminal state (passed or failed).
   */
  private async dequeueNext(): Promise<void> {
    if (this.chainQueue.length === 0) return;

    if (this.activeChainCount >= MAX_ACTIVE_CHAINS) return;

    const queued = this.chainQueue.shift()!;
    const chain = this.chains.get(queued.record.wrfcId ?? '');

    if (!chain) {
      logger.warn('WrfcController.dequeueNext: queued chain not found, discarding', {
        agentId: queued.record.id,
      });
      return;
    }

    logger.debug('WrfcController.dequeueNext: starting queued chain', {
      chainId: chain.id,
      agentId: queued.record.id,
      waitedMs: Date.now() - queued.queuedAt,
    });

    this.startEngineeringChain(chain, false);

    // Process any buffered completion from while the chain was queued
    if (chain.bufferedCompletion) {
      const buffered = chain.bufferedCompletion;
      chain.bufferedCompletion = undefined;
      await this.onAgentComplete(buffered.agentId);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private findChainByAgentId(agentId: string): WrfcChain | null {
    for (const chain of this.chains.values()) {
      if (chain.allAgentIds.includes(agentId)) {
        return chain;
      }
    }
    return null;
  }

  private generateWrfcId(): string {
    return `wrfc-${crypto.randomUUID().slice(0, 8)}`;
  }

  private workflowContext(chainId: string): WorkflowContext {
    return {
      sessionId: this.sessionId,
      traceId: `${this.sessionId}:workflow:${chainId}`,
      source: 'wrfc-controller',
    };
  }

  private orchestrationGraphId(chainId: string): string {
    return `wrfc:${chainId}`;
  }

  private startOrchestrationNode(
    chain: WrfcChain,
    suffix: string,
    role: WrfcNodeRole,
    title: string,
    agentId?: string,
  ): void {
    const nodeId = `${chain.id}:${suffix}`;
    const context = {
      sessionId: this.sessionId,
      traceId: `${this.sessionId}:orchestration:${chain.id}:${suffix}`,
      source: 'wrfc-controller',
      ...(agentId !== undefined ? { agentId } : {}),
    };
    emitOrchestrationNodeAdded(this.runtimeBus, context, {
      graphId: this.orchestrationGraphId(chain.id),
      nodeId,
      title,
      role,
      ...(agentId !== undefined ? { agentId } : {}),
    });
    emitOrchestrationNodeStarted(this.runtimeBus, context, {
      graphId: this.orchestrationGraphId(chain.id),
      nodeId,
      ...(agentId !== undefined ? { agentId } : {}),
    });
    chain.currentNodeId = nodeId;
  }

  private completeCurrentNode(chain: WrfcChain, summary?: string): void {
    if (!chain.currentNodeId) return;
    emitOrchestrationNodeCompleted(this.runtimeBus, {
      sessionId: this.sessionId,
      traceId: `${this.sessionId}:orchestration:${chain.currentNodeId}:complete`,
      source: 'wrfc-controller',
    }, {
      graphId: this.orchestrationGraphId(chain.id),
      nodeId: chain.currentNodeId,
      ...(summary !== undefined ? { summary } : {}),
    });
    chain.currentNodeId = undefined;
  }

  private failCurrentNode(chain: WrfcChain, error: string): void {
    if (!chain.currentNodeId) return;
    emitOrchestrationNodeFailed(this.runtimeBus, {
      sessionId: this.sessionId,
      traceId: `${this.sessionId}:orchestration:${chain.currentNodeId}:fail`,
      source: 'wrfc-controller',
    }, {
      graphId: this.orchestrationGraphId(chain.id),
      nodeId: chain.currentNodeId,
      error,
    });
    chain.currentNodeId = undefined;
  }

  private createBaseChain(engineerRecord: AgentRecord): WrfcChain {
    const chain: WrfcChain = {
      id: this.generateWrfcId(),
      state: 'pending',
      task: engineerRecord.task,
      engineerAgentId: engineerRecord.id,
      allAgentIds: [engineerRecord.id],
      fixAttempts: 0,
      reviewCycles: 0,
      gateRetryDepth: 0,
      reviewScores: [],
      createdAt: Date.now(),
    };
    this.chains.set(chain.id, chain);
    emitOrchestrationGraphCreated(this.runtimeBus, this.workflowContext(chain.id), {
      graphId: this.orchestrationGraphId(chain.id),
      title: `WRFC: ${engineerRecord.task}`,
      mode: 'review-loop',
    });
    engineerRecord.wrfcId = chain.id;
    AgentMessageBus.getInstance().registerAgent({
      agentId: engineerRecord.id,
      template: engineerRecord.template,
      wrfcId: chain.id,
    });
    this.attachPendingParentChain(chain, engineerRecord.id);
    return chain;
  }

  private attachPendingParentChain(chain: WrfcChain, agentId: string): void {
    const pendingParentId = this.pendingParentChainIds.get(agentId);
    if (!pendingParentId) return;
    chain.parentChainId = pendingParentId;
    const parent = this.chains.get(pendingParentId);
    if (parent) {
      chain.gateRetryDepth = parent.gateRetryDepth + (parent.gateFailureFingerprint ? 1 : 0);
    }
    this.pendingParentChainIds.delete(agentId);
  }

  private startEngineeringChain(chain: WrfcChain, emitCreated: boolean): void {
    this.activeChainCount++;
    this.transition(chain, 'engineering');
    this.startOrchestrationNode(
      chain,
      `engineer:${chain.fixAttempts}`,
      'engineer',
      'Engineer implementation',
      chain.engineerAgentId,
    );
    if (emitCreated) {
      this.emitChainCreated(chain.id, chain.task);
    }
  }

  private parseEngineerCompletionReport(rawOutput: string, template?: string): CompletionReport {
    const report = parseCompletionReport(rawOutput);
    if (report) return report;
    return {
      version: 1,
      archetype: template ?? 'engineer',
      summary: rawOutput.slice(0, 500) || '(no output)',
      gatheredContext: [],
      plannedActions: [],
      appliedChanges: [],
      result: rawOutput,
    } as CompletionReport;
  }

  private parseReviewerCompletionReport(chain: WrfcChain, rawOutput: string): ReviewerReport {
    const reviewerReport = parseCompletionReport(rawOutput);
    if (reviewerReport && reviewerReport.archetype === 'reviewer') {
      return reviewerReport as ReviewerReport;
    }
    const extractedScore = extractScoreFromText(rawOutput);
    const threshold = this.getWrfcScoreThreshold();
    const extractedPassed = extractedScore !== null
      ? extractPassedFromText(rawOutput, extractedScore, threshold)
      : false;
    const extractedIssues = extractIssuesFromText(rawOutput);

    logger.warn('WrfcController: no structured ReviewerReport found, extracting from text', {
      chainId: chain.id,
      extractedScore,
    });
    if (extractedScore === null) {
      logger.warn('WrfcController: score extraction returned null, defaulting to 0', { chainId: chain.id });
    }
    return {
      version: 1,
      archetype: 'reviewer',
      summary: rawOutput.slice(0, 500) || '(no reviewer output)',
      score: extractedScore ?? 0,
      passed: extractedPassed,
      dimensions: [],
      issues: extractedIssues,
    };
  }

  private handleEngineerCompletion(chain: WrfcChain, agentId: string, report: CompletionReport): void {
    this.completeCurrentNode(chain, report.summary);
    if (chain.state === 'engineering') {
      chain.engineerReport = report;
      this.workmap.append({ ts: new Date().toISOString(), wrfcId: chain.id, event: 'engineer_complete', agentId, task: chain.task });
    }
    this.startReview(chain, report);
  }

  private buildReviewTask(chain: WrfcChain, report: CompletionReport): string {
    const threshold = this.getWrfcScoreThreshold();
    return [
      `WRFC Review Request`,
      `Chain ID: ${chain.id}`,
      ``,
      `Engineer completion report:`,
      `\`\`\`json`,
      JSON.stringify(report, null, 2),
      `\`\`\``,
      ``,
      `Instructions:`,
      `1. Read all files listed in the engineer report (filesCreated, filesModified).`,
      `2. Inspect the engineer's gatheredContext, plannedActions, and appliedChanges for discipline and coherence.`,
      `3. Verify the implementation meets all stated requirements.`,
      `4. Score the implementation using the 10-dimension review rubric.`,
      `5. The passing score threshold is ${threshold}/10.`,
      `6. Return a structured ReviewerReport JSON block in your final response.`,
      ``,
      `The ReviewerReport must include:`,
      `- version: 1`,
      `- archetype: "reviewer"`,
      `- score: <number 0-10>`,
      `- passed: <boolean>`,
      `- dimensions: array of { name, score, maxScore, issues[] }`,
      `- issues: array of { severity, description, file?, line?, pointValue }`,
    ].join('\n');
  }

  private buildFixTask(chain: WrfcChain, review: ReviewerReport): string {
    const threshold = this.getWrfcScoreThreshold();
    const issueList = review.issues
      .map((issue) => {
        const location = issue.file ? ` (${issue.file}${issue.line ? `:${issue.line}` : ''})` : '';
        return `- [${issue.severity.toUpperCase()}] ${issue.description}${location} (-${issue.pointValue} pts)`;
      })
      .join('\n');
    return [
      `WRFC Fix Request`,
      `Chain ID: ${chain.id}`,
      ``,
      `Review score: ${review.score}/10 (threshold: ${threshold}/10)`,
      `Fix attempt: ${chain.fixAttempts}`,
      ``,
      `Issues to address:`,
      issueList || '(no structured issues — see review summary)',
      ``,
      `Review summary: ${review.summary}`,
      ``,
      `Instructions:`,
      `1. Address ALL issues listed above, prioritizing critical and major items.`,
      `2. Fix each issue completely — partial fixes will reduce your score.`,
      `3. Re-run Gather, Plan, Apply explicitly before writing your final answer.`,
      `4. Return a structured EngineerReport JSON block including gatheredContext, plannedActions, and appliedChanges in your final response.`,
    ].join('\n');
  }

  private spawnWrfcAgent(
    template: 'engineer' | 'reviewer',
    task: string,
    dangerouslyDisableWrfc: boolean,
  ): AgentRecord {
    return agentManagerResolver().spawn({
      mode: 'spawn',
      task,
      template,
      ...(dangerouslyDisableWrfc ? { dangerously_disable_wrfc: true } : {}),
    });
  }

  private getEnabledGates() {
    return wrfcConfigResolver().gates.filter((gate) => gate.enabled);
  }

  private getWrfcConfig(): {
    scoreThreshold?: number;
    maxFixAttempts?: number;
    autoCommit?: boolean;
    gates?: Array<{ name: string; command: string; enabled: boolean }>;
  } {
    return wrfcConfigResolver();
  }

  private getWrfcScoreThreshold(): number {
    const wrfcConfig = this.getWrfcConfig();
    if (typeof wrfcConfig.scoreThreshold === 'number') {
      return wrfcConfig.scoreThreshold;
    }
    return 9.9;
  }

  private getWrfcMaxFixAttempts(): number {
    const wrfcConfig = this.getWrfcConfig();
    if (typeof wrfcConfig.maxFixAttempts === 'number') {
      return wrfcConfig.maxFixAttempts;
    }
    return 3;
  }

  private getWrfcAutoCommit(): boolean {
    const wrfcConfig = this.getWrfcConfig();
    if (typeof wrfcConfig.autoCommit === 'boolean') {
      return wrfcConfig.autoCommit;
    }
    return false;
  }

  private async loadPackageScripts(cwd: string): Promise<Record<string, string>> {
    const pkgPath = join(cwd, 'package.json');
    if (!existsSync(pkgPath)) return {};
    try {
      const pkgJson = JSON.parse(await Bun.file(pkgPath).text()) as { scripts?: Record<string, string> };
      return pkgJson.scripts ?? {};
    } catch {
      return {};
    }
  }

  private getSkippedGateReason(
    gateName: string,
    cwd: string,
    pkgScripts: Record<string, string>,
  ): string | null {
    if (gateName === 'typecheck' && !existsSync(join(cwd, 'tsconfig.json'))) {
      return 'Skipped: no tsconfig.json found';
    }
    if (gateName === 'lint') {
      const lintConfigs = [
        'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
        '.eslintrc.json', '.eslintrc.js', '.eslintrc.yml', '.eslintrc.yaml', '.eslintrc',
      ];
      if (!lintConfigs.some((file) => existsSync(join(cwd, file)))) {
        return 'Skipped: no ESLint config found';
      }
    }
    if (gateName === 'test' && !pkgScripts['test']) return 'Skipped: no test script in package.json';
    if (gateName === 'build' && !pkgScripts['build']) return 'Skipped: no build script in package.json';
    return null;
  }

  private async executeGateCommand(command: string): Promise<{ passed: boolean; output: string }> {
    try {
      const proc = Bun.spawn(['/bin/sh', '-c', command], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timer = setTimeout(() => {
        try { proc.kill(); } catch {}
      }, GATE_TIMEOUT_MS);
      let exitCode: number;
      try {
        exitCode = await proc.exited;
        clearTimeout(timer);
      } catch (err) {
        clearTimeout(timer);
        try { proc.kill(); } catch {}
        throw err;
      }
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return {
        passed: exitCode === 0,
        output: [stdout, stderr].filter(Boolean).join('\n').trim(),
      };
    } catch (err) {
      return {
        passed: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private completeChainAsPassed(chain: WrfcChain): void {
    this.activeChainCount = Math.max(0, this.activeChainCount - 1);
    this.transition(chain, 'passed');
    chain.completedAt = Date.now();
    this.emitChainPassed(chain.id);
    this.scheduleChainCleanup(chain);
    this.safeDequeueNext();
  }

  private safeDequeueNext(): void {
    this.dequeueNext().catch((err) => {
      logger.error('WrfcController.dequeueNext unhandled error', { error: String(err) });
    });
  }

  private emitChainCreated(chainId: string, task: string): void {
    emitWorkflowChainCreated(this.runtimeBus, this.workflowContext(chainId), { chainId, task });
  }

  private emitGateResult(chainId: string, gate: string, passed: boolean): void {
    emitWorkflowGateResult(this.runtimeBus, this.workflowContext(chainId), { chainId, gate, passed });
  }

  private emitChainPassed(chainId: string): void {
    emitWorkflowChainPassed(this.runtimeBus, this.workflowContext(chainId), { chainId });
  }

  private emitAutoCommitted(chainId: string, commitHash?: string): void {
    emitWorkflowAutoCommitted(this.runtimeBus, this.workflowContext(chainId), { chainId, commitHash });
  }

  private emitCascadeAbort(chainId: string, reason: string): void {
    emitWorkflowCascadeAborted(this.runtimeBus, this.workflowContext(chainId), { chainId, reason });
  }
}
