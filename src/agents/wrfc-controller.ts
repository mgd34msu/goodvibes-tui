import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentMessageBus } from './message-bus.ts';
import { type CompletionReport, type ReviewerReport } from './completion-report.ts';
import {
  buildFixTask,
  buildReviewTask,
  parseEngineerCompletionReport,
  parseReviewerCompletionReport,
} from './wrfc-reporting.ts';
import type { QualityGateResult, QueuedChain, WrfcChain, WrfcState } from './wrfc-types.ts';
import { WrfcWorkmap } from './wrfc-workmap.ts';
import { AgentWorktree } from './worktree.ts';
import { completePlanItemsForAgent } from './wrfc-plan-sync.ts';
import type { ConfigManager } from '../config/manager.ts';
import type { AgentRecord } from '../tools/agent/index.ts';
import { logger } from '../utils/logger.ts';
import type { ExecutionPlanManager } from '../core/execution-plan.ts';
import type { AgentEvent, RuntimeEventBus } from '../runtime/events/index.ts';
import {
  emitWorkflowChainFailed,
  emitWorkflowFixAttempted,
  emitWorkflowReviewCompleted,
} from '../runtime/emitters/index.ts';
import {
  getEnabledWrfcGates,
  getWrfcAutoCommit,
  getWrfcMaxFixAttempts,
  getWrfcScoreThreshold,
  type AgentManagerLike,
} from './wrfc-config.ts';
import {
  completeWrfcOrchestrationNode,
  createWrfcWorkflowContext,
  emitWrfcAutoCommitted,
  emitWrfcCascadeAbort,
  emitWrfcChainCreated,
  emitWrfcChainPassed,
  emitWrfcGateResult,
  emitWrfcGraphCreated,
  emitWrfcStateChanged,
  failWrfcOrchestrationNode,
  startWrfcOrchestrationNode,
} from './wrfc-runtime-events.ts';
import {
  executeGateCommand,
  getSkippedGateReason,
  loadPackageScripts,
} from './wrfc-gates.ts';

export { extractScoreFromText, extractPassedFromText, extractIssuesFromText } from './wrfc-reporting.ts';

const VALID_TRANSITIONS: Partial<Record<WrfcState, WrfcState[]>> = {
  pending: ['engineering'],
  engineering: ['reviewing', 'failed'],
  reviewing: ['fixing', 'awaiting_gates', 'failed'],
  fixing: ['reviewing', 'failed'],
  awaiting_gates: ['gating', 'failed'],
  gating: ['passed', 'failed', 'committing'],
  committing: ['passed', 'failed'],
};

const MAX_ACTIVE_CHAINS = 6;
const CHAIN_CLEANUP_DELAY_MS = 60_000;
type WrfcWorktreeOps = Pick<AgentWorktree, 'merge' | 'cleanup'>;

export class WrfcController {
  private readonly chains = new Map<string, WrfcChain>();
  private chainQueue: QueuedChain[] = [];
  private unsubscribers: Array<() => void> = [];
  private activeChainCount = 0;
  private readonly pendingParentChainIds = new Map<string, string>();
  private readonly sessionId: string;
  private readonly workmap: WrfcWorkmap;
  private runtimeBus: RuntimeEventBus;
  private readonly messageBus: Pick<AgentMessageBus, 'registerAgent'>;
  private planManager: Pick<ExecutionPlanManager, 'getActive' | 'updateItem'> | null = null;
  private readonly agentManager: AgentManagerLike;
  private readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  private readonly createWorktree: () => WrfcWorktreeOps;

  constructor(
    runtimeBus: RuntimeEventBus,
    messageBus: Pick<AgentMessageBus, 'registerAgent'>,
    deps: {
      readonly agentManager: AgentManagerLike;
      readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
      readonly createWorktree?: () => WrfcWorktreeOps;
    },
  ) {
    this.runtimeBus = runtimeBus;
    this.messageBus = messageBus;
    this.agentManager = deps.agentManager;
    this.configManager = deps.configManager;
    this.createWorktree = deps.createWorktree ?? (() => new AgentWorktree());
    this.sessionId = crypto.randomUUID().slice(0, 8);
    this.workmap = new WrfcWorkmap(this.sessionId);
    this.setupListeners();
  }

  createChain(engineerRecord: AgentRecord): WrfcChain {
    logger.info('WrfcController.createChain: called', {
      agentId: engineerRecord.id,
      task: engineerRecord.task.slice(0, 60),
      activeChainCount: this.activeChainCount,
    });

    const chain = this.createBaseChain(engineerRecord);
    if (this.activeChainCount >= MAX_ACTIVE_CHAINS) {
      this.chainQueue.push({ record: engineerRecord, queuedAt: Date.now() });
      logger.debug('WrfcController.createChain: at cap, queued', {
        chainId: chain.id,
        agentId: engineerRecord.id,
        activeCount: this.activeChainCount,
        queueLength: this.chainQueue.length,
      });
      emitWrfcChainCreated(this.runtimeBus, this.sessionId, chain.id, chain.task);
      return chain;
    }

    this.startEngineeringChain(chain, true);
    logger.debug('WrfcController.createChain', { chainId: chain.id, agentId: engineerRecord.id });
    return chain;
  }

  getSessionId(): string { return this.sessionId; }

  getWorkmap(): WrfcWorkmap { return this.workmap; }

  setPlanManager(planManager: Pick<ExecutionPlanManager, 'getActive' | 'updateItem'>): void {
    this.planManager = planManager;
  }

  setRuntimeBus(runtimeBus: RuntimeEventBus): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.runtimeBus = runtimeBus;
    this.setupListeners();
  }

  getChain(chainId: string): WrfcChain | null { return this.chains.get(chainId) ?? null; }

  listChains(): WrfcChain[] { return Array.from(this.chains.values()); }

  dispose(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  private transition(chain: WrfcChain, to: WrfcState): void {
    const allowed = VALID_TRANSITIONS[chain.state];
    if (!allowed || !allowed.includes(to)) {
      logger.error('WrfcController: illegal state transition', {
        chainId: chain.id,
        from: chain.state,
        to,
      });
      throw new Error(`Illegal WRFC transition: ${chain.state} -> ${to} for chain ${chain.id}`);
    }

    const from = chain.state;
    chain.state = to;
    emitWrfcStateChanged(this.runtimeBus, this.sessionId, chain.id, from, to);
    logger.debug('WrfcController.transition', { chainId: chain.id, from, to });
  }

  private setupListeners(): void {
    const unsubComplete = this.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>(
      'AGENT_COMPLETED',
      ({ payload }) => {
        this.onAgentComplete(payload.agentId).catch((error) => {
          logger.error('WrfcController.onAgentComplete unhandled error', {
            agentId: payload.agentId,
            error: String(error),
          });
        });
      },
    );
    const unsubError = this.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>(
      'AGENT_FAILED',
      ({ payload }) => {
        this.onAgentFailed(payload.agentId, payload.error);
      },
    );
    this.unsubscribers.push(unsubComplete, unsubError);
  }

  private async onAgentComplete(agentId: string): Promise<void> {
    const chain = this.findChainByAgentId(agentId);
    if (!chain) return;

    const record = this.agentManager.getStatus(agentId);
    const rawOutput = record?.fullOutput ?? '';

    logger.debug('WrfcController.onAgentComplete', {
      chainId: chain.id,
      agentId,
      state: chain.state,
      outputLength: rawOutput.length,
    });

    if (chain.state === 'pending') {
      chain.bufferedCompletion = { agentId, fullOutput: rawOutput };
      logger.debug('WrfcController.onAgentComplete: chain pending, buffering completion', {
        chainId: chain.id,
        agentId,
      });
      return;
    }

    if (chain.state === 'engineering' || chain.state === 'fixing') {
      const report = parseEngineerCompletionReport(rawOutput, record?.template);
      this.handleEngineerCompletion(chain, agentId, report);
    } else if (chain.state === 'reviewing') {
      const review = parseReviewerCompletionReport(chain.id, rawOutput, getWrfcScoreThreshold(this.configManager));
      chain.reviewerReport = review;
      chain.reviewCycles += 1;
      await this.processReview(chain, review);
    }

    if (this.planManager) {
      completePlanItemsForAgent(agentId, this.planManager);
    }

    if (chain.state === 'gating' || chain.state === 'passed' || chain.state === 'committing') {
      return;
    }
    await this.checkAndRunGatesForAll();
  }

  private onAgentFailed(agentId: string, errorMessage?: string): void {
    const chain = this.findChainByAgentId(agentId);
    if (!chain) return;
    this.failChain(chain, errorMessage ?? `Agent ${agentId} failed`);
  }

  private startReview(chain: WrfcChain, report: CompletionReport): void {
    this.transition(chain, 'reviewing');
    const reviewerRecord = this.spawnWrfcAgent(
      'reviewer',
      buildReviewTask(chain.id, report, getWrfcScoreThreshold(this.configManager)),
      true,
    );

    chain.reviewerAgentId = reviewerRecord.id;
    chain.allAgentIds.push(reviewerRecord.id);
    reviewerRecord.wrfcId = chain.id;
    this.messageBus.registerAgent({
      agentId: reviewerRecord.id,
      role: 'reviewer',
      wrfcId: chain.id,
    });
    chain.currentNodeId = startWrfcOrchestrationNode(
      this.runtimeBus,
      this.sessionId,
      chain.id,
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
    const threshold = getWrfcScoreThreshold(this.configManager);
    this.completeCurrentNode(chain, `Score ${review.score}/10${review.passed ? ' passed' : ' needs fixes'}`);

    emitWorkflowReviewCompleted(this.runtimeBus, createWrfcWorkflowContext(this.sessionId, chain.id), {
      chainId: chain.id,
      score: review.score,
      passed: review.passed,
    });

    this.workmap.append({
      ts: new Date().toISOString(),
      wrfcId: chain.id,
      event: 'review_complete',
      agentId: chain.reviewerAgentId,
      score: review.score,
      passed: review.score >= threshold,
      issues: review.issues?.slice(0, 10).map((issue) => ({
        severity: issue.severity,
        description: issue.description,
        file: issue.file,
      })),
    });

    logger.debug('WrfcController.processReview', {
      chainId: chain.id,
      score: review.score,
      threshold,
      fixAttempts: chain.fixAttempts,
    });

    chain.reviewScores.push(review.score);
    if (review.score >= threshold) {
      this.transition(chain, 'awaiting_gates');
      await this.checkAndRunGatesForAll();
      return;
    }

    const scores = chain.reviewScores;
    if (scores.length >= 3) {
      const initial = scores[0];
      const lastTwo = scores.slice(-2);
      if (lastTwo[0] < initial && lastTwo[1] < initial) {
        emitWrfcCascadeAbort(
          this.runtimeBus,
          this.sessionId,
          chain.id,
          `Score regression warning: initial ${initial}/10, last two ${lastTwo[0]}/10, ${lastTwo[1]}/10 — both below initial. Fix quality may be degrading.`,
        );
      }
    }

    const maxFixAttempts = getWrfcMaxFixAttempts(this.configManager);
    if (chain.fixAttempts >= maxFixAttempts) {
      this.failChain(
        chain,
        `Score ${review.score}/10 below threshold ${threshold}/10 after ${chain.fixAttempts} fix attempt${chain.fixAttempts !== 1 ? 's' : ''} — below threshold`,
      );
      return;
    }

    this.startFix(chain, review);
  }

  private startFix(chain: WrfcChain, review: ReviewerReport): void {
    chain.fixAttempts += 1;
    this.transition(chain, 'fixing');

    const maxAttempts = getWrfcMaxFixAttempts(this.configManager);
    emitWorkflowFixAttempted(this.runtimeBus, createWrfcWorkflowContext(this.sessionId, chain.id), {
      chainId: chain.id,
      attempt: chain.fixAttempts,
      maxAttempts,
    });

    const fixerRecord = this.spawnWrfcAgent(
      'engineer',
      buildFixTask(chain.id, review, getWrfcScoreThreshold(this.configManager), chain.fixAttempts),
      true,
    );

    chain.fixerAgentId = fixerRecord.id;
    chain.allAgentIds.push(fixerRecord.id);
    fixerRecord.wrfcId = chain.id;
    this.messageBus.registerAgent({
      agentId: fixerRecord.id,
      role: 'fixer',
      wrfcId: chain.id,
    });
    chain.currentNodeId = startWrfcOrchestrationNode(
      this.runtimeBus,
      this.sessionId,
      chain.id,
      `fix:${chain.fixAttempts}`,
      'fixer',
      `Fix attempt ${chain.fixAttempts}`,
      fixerRecord.id,
    );

    this.workmap.append({
      ts: new Date().toISOString(),
      wrfcId: chain.id,
      event: 'fix_started',
      agentId: fixerRecord.id,
      attempt: chain.fixAttempts,
    });

    logger.debug('WrfcController.startFix', {
      chainId: chain.id,
      fixerAgentId: fixerRecord.id,
      attempt: chain.fixAttempts,
    });
  }

  private async runGates(chain: WrfcChain): Promise<QualityGateResult[]> {
    this.transition(chain, 'gating');
    chain.currentNodeId = startWrfcOrchestrationNode(
      this.runtimeBus,
      this.sessionId,
      chain.id,
      `gate:${chain.reviewCycles}:${chain.fixAttempts}`,
      'verifier',
      'Quality gates',
    );

    const gates = getEnabledWrfcGates(this.configManager);
    if (gates.length === 0) {
      logger.debug('WrfcController.runGates: no gates configured', { chainId: chain.id });
      return [];
    }

    logger.debug('WrfcController.runGates', {
      chainId: chain.id,
      gateCount: gates.length,
    });

    const cwd = process.cwd();
    const pkgScripts = await loadPackageScripts(cwd);
    const results: QualityGateResult[] = [];

    for (const gate of gates) {
      const skipReason = getSkippedGateReason(gate.name, cwd, pkgScripts);
      if (skipReason !== null) {
        const result: QualityGateResult = {
          gate: gate.name,
          passed: true,
          output: skipReason,
          durationMs: 0,
        };
        results.push(result);
        chain.gateResults = results.slice();
        emitWrfcGateResult(this.runtimeBus, this.sessionId, chain.id, gate.name, true);
        logger.debug('WrfcController.gate-skipped', {
          chainId: chain.id,
          gate: gate.name,
          reason: skipReason,
        });
        continue;
      }

      const startedAt = Date.now();
      const { passed, output } = await executeGateCommand(gate.command);
      const result: QualityGateResult = {
        gate: gate.name,
        passed,
        output,
        durationMs: Date.now() - startedAt,
      };

      results.push(result);
      chain.gateResults = results.slice();
      emitWrfcGateResult(this.runtimeBus, this.sessionId, chain.id, gate.name, passed);

      logger.debug('WrfcController.gate-result', {
        chainId: chain.id,
        gate: gate.name,
        passed,
        durationMs: result.durationMs,
      });
    }

    return results;
  }

  private async processGateResults(chain: WrfcChain, results: QualityGateResult[]): Promise<void> {
    if (!chain.currentNodeId?.includes(':gate:')) {
      chain.currentNodeId = startWrfcOrchestrationNode(
        this.runtimeBus,
        this.sessionId,
        chain.id,
        `gate:${chain.reviewCycles}:${chain.fixAttempts}`,
        'verifier',
        'Quality gates',
      );
    }

    const allPassed = results.length === 0 || results.every((result) => result.passed);
    const autoCommit = getWrfcAutoCommit(this.configManager);
    for (const result of results) {
      this.workmap.append({
        ts: new Date().toISOString(),
        wrfcId: chain.id,
        event: 'gate_result',
        gate: result.gate,
        passed: result.passed,
        gateOutput: result.output.slice(0, 200),
      });
    }
    this.completeCurrentNode(
      chain,
      allPassed
        ? 'All quality gates passed'
        : `${results.filter((result) => !result.passed).length} quality gate(s) failed`,
    );

    if (allPassed) {
      this.workmap.append({ ts: new Date().toISOString(), wrfcId: chain.id, event: 'chain_passed' });
      chain.gatesPassed = true;
      if (autoCommit) {
        await this.autoCommit(chain);
      } else {
        this.completeChainAsPassed(chain);
      }
      return;
    }

    const failedGates = results.filter((result) => !result.passed);
    const fingerprint = failedGates.map((result) => `${result.gate}:${result.output.slice(0, 200)}`).join('|');
    const maxGateRetries = getWrfcMaxFixAttempts(this.configManager);
    chain.gateFailureFingerprint = fingerprint;
    this.completeChainAsPassed(chain);

    if (chain.gateRetryDepth >= maxGateRetries) {
      logger.error('WrfcController.processGateResults: gate retry limit reached, manual intervention required', {
        chainId: chain.id,
        gateRetryDepth: chain.gateRetryDepth,
        maxGateRetries,
      });
      emitWrfcCascadeAbort(
        this.runtimeBus,
        this.sessionId,
        chain.id,
        `Gate failures exceeded max retries (${chain.gateRetryDepth}/${maxGateRetries}). Manual intervention required.`,
      );
      return;
    }

    const gateFailureSummary = failedGates
      .map((result) => `- ${result.gate}: ${result.output.slice(0, 300)}`)
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

    const followUpRecord = this.spawnWrfcAgent('engineer', followUpTask, false);
    const followUpChain = this.findChainByAgentId(followUpRecord.id);
    if (followUpChain) {
      followUpChain.parentChainId = chain.id;
    } else {
      this.pendingParentChainIds.set(followUpRecord.id, chain.id);
    }

    logger.debug('WrfcController.processGateResults: gate failure — spawned follow-up agent', {
      parentChainId: chain.id,
      followUpAgentId: followUpRecord.id,
    });
  }

  private scheduleChainCleanup(chain: WrfcChain): void {
    setTimeout(() => {
      if (chain.state === 'passed' || chain.state === 'failed') {
        this.chains.delete(chain.id);
      }
    }, CHAIN_CLEANUP_DELAY_MS);
  }

  private async checkAndRunGatesForAll(): Promise<void> {
    const allChains = Array.from(this.chains.values()).filter(
      (chain) => chain.state !== 'passed' && chain.state !== 'failed',
    );
    const activeWorkChains = allChains.filter((chain) => (
      chain.state === 'pending'
      || chain.state === 'engineering'
      || chain.state === 'reviewing'
      || chain.state === 'fixing'
    ));

    if (activeWorkChains.length > 0) {
      logger.debug('WrfcController.checkAndRunGatesForAll: waiting for active chains', {
        activeWork: activeWorkChains.length,
        awaitingGates: allChains.filter((chain) => chain.state === 'awaiting_gates').length,
      });
      return;
    }

    const readyChains = allChains.filter((chain) => chain.state === 'awaiting_gates');
    if (readyChains.length === 0) return;

    logger.debug('WrfcController.checkAndRunGatesForAll: all chains ready, running gates', {
      readyCount: readyChains.length,
    });

    const gateRunner = readyChains[0];
    const results = await this.runGates(gateRunner);
    for (const chain of readyChains) {
      if (chain.id !== gateRunner.id) {
        this.transition(chain, 'gating');
        chain.gateResults = results;
      }
      await this.processGateResults(chain, results);
    }
  }

  private async autoCommit(chain: WrfcChain): Promise<void> {
    this.transition(chain, 'committing');

    const agentId = chain.allAgentIds.length > 0
      ? chain.allAgentIds[chain.allAgentIds.length - 1]
      : (chain.fixerAgentId ?? chain.engineerAgentId);
    if (!agentId) {
      this.failChain(chain, 'autoCommit: no agent ID found on chain');
      return;
    }

    if (!existsSync(join(process.cwd(), '.git'))) {
      logger.debug('WrfcController.autoCommit: not a git repo, skipping commit', { chainId: chain.id });
      this.completeChainAsPassed(chain);
      return;
    }

    const worktree = this.createWorktree();
    try {
      const merged = await worktree.merge(agentId);
      emitWrfcAutoCommitted(this.runtimeBus, this.sessionId, chain.id);
      this.completeChainAsPassed(chain);
      logger.debug('WrfcController.autoCommit: success', { chainId: chain.id, agentId, merged });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error('WrfcController.autoCommit: failed', { chainId: chain.id, error: reason });
      this.failChain(chain, `autoCommit failed: ${reason}`);
    } finally {
      for (const id of chain.allAgentIds) {
        worktree.cleanup(id).catch((error) => {
          logger.debug('WrfcController.autoCommit: cleanup error (non-fatal)', {
            agentId: id,
            error: String(error),
          });
        });
      }
    }
  }

  private failChain(chain: WrfcChain, reason: string): void {
    if (chain.state === 'pending') {
      this.chainQueue = this.chainQueue.filter((queued) => queued.record.id !== chain.engineerAgentId);
    }

    const wasActive = chain.state !== 'passed' && chain.state !== 'failed' && chain.state !== 'pending';
    this.failCurrentNode(chain, reason);
    try {
      this.transition(chain, 'failed');
    } catch {
      chain.state = 'failed';
    }

    if (wasActive) {
      this.activeChainCount = Math.max(0, this.activeChainCount - 1);
    }

    chain.error = reason;
    chain.completedAt = Date.now();
    this.workmap.append({ ts: new Date().toISOString(), wrfcId: chain.id, event: 'chain_failed', reason });
    emitWorkflowChainFailed(this.runtimeBus, createWrfcWorkflowContext(this.sessionId, chain.id), { chainId: chain.id, reason });

    logger.error('WrfcController.failChain', { chainId: chain.id, reason });
    this.scheduleChainCleanup(chain);
    this.safeDequeueNext();
  }

  private async dequeueNext(): Promise<void> {
    if (this.chainQueue.length === 0 || this.activeChainCount >= MAX_ACTIVE_CHAINS) return;

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

    if (!chain.bufferedCompletion) return;
    const buffered = chain.bufferedCompletion;
    chain.bufferedCompletion = undefined;
    await this.onAgentComplete(buffered.agentId);
  }

  private findChainByAgentId(agentId: string): WrfcChain | null {
    for (const chain of this.chains.values()) {
      if (chain.allAgentIds.includes(agentId)) return chain;
    }
    return null;
  }

  private generateWrfcId(): string { return `wrfc-${crypto.randomUUID().slice(0, 8)}`; }

  private completeCurrentNode(chain: WrfcChain, summary?: string): void {
    if (!chain.currentNodeId) return;
    completeWrfcOrchestrationNode(this.runtimeBus, this.sessionId, chain.id, chain.currentNodeId, summary);
    chain.currentNodeId = undefined;
  }

  private failCurrentNode(chain: WrfcChain, error: string): void {
    if (!chain.currentNodeId) return;
    failWrfcOrchestrationNode(this.runtimeBus, this.sessionId, chain.id, chain.currentNodeId, error);
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
    emitWrfcGraphCreated(this.runtimeBus, this.sessionId, chain.id, `WRFC: ${engineerRecord.task}`);
    engineerRecord.wrfcId = chain.id;
    this.messageBus.registerAgent({
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
    this.activeChainCount += 1;
    this.transition(chain, 'engineering');
    chain.currentNodeId = startWrfcOrchestrationNode(
      this.runtimeBus,
      this.sessionId,
      chain.id,
      `engineer:${chain.fixAttempts}`,
      'engineer',
      'Engineer implementation',
      chain.engineerAgentId,
    );
    if (emitCreated) {
      emitWrfcChainCreated(this.runtimeBus, this.sessionId, chain.id, chain.task);
    }
  }

  private handleEngineerCompletion(chain: WrfcChain, agentId: string, report: CompletionReport): void {
    this.completeCurrentNode(chain, report.summary);
    if (chain.state === 'engineering') {
      chain.engineerReport = report;
      this.workmap.append({
        ts: new Date().toISOString(),
        wrfcId: chain.id,
        event: 'engineer_complete',
        agentId,
        task: chain.task,
      });
    }
    this.startReview(chain, report);
  }

  private spawnWrfcAgent(
    template: 'engineer' | 'reviewer',
    task: string,
    dangerouslyDisableWrfc: boolean,
  ): AgentRecord {
    return this.agentManager.spawn({
      mode: 'spawn',
      task,
      template,
      ...(dangerouslyDisableWrfc ? { dangerously_disable_wrfc: true } : {}),
    });
  }

  private completeChainAsPassed(chain: WrfcChain): void {
    this.activeChainCount = Math.max(0, this.activeChainCount - 1);
    this.transition(chain, 'passed');
    chain.completedAt = Date.now();
    emitWrfcChainPassed(this.runtimeBus, this.sessionId, chain.id);
    this.scheduleChainCleanup(chain);
    this.safeDequeueNext();
  }

  private safeDequeueNext(): void {
    this.dequeueNext().catch((error) => {
      logger.error('WrfcController.dequeueNext unhandled error', { error: String(error) });
    });
  }
}
