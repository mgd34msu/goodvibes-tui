import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WrfcWorkmap } from './wrfc-workmap.ts';
import { EventBus } from '../core/event-bus.ts';
import { AgentManager, type AgentRecord } from '../tools/agent/index.ts';
import { type CompletionReport, type ReviewerReport, parseCompletionReport } from './completion-report.ts';
import type { WrfcChain, WrfcState, QualityGateResult, QueuedChain } from './wrfc-types.ts';
import { AgentWorktree } from './worktree.ts';
import { configManager } from '../config/index.ts';
import { logger } from '../utils/logger.ts';
import { planManager } from '../core/plan-manager-instance.ts';

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

// ---------------------------------------------------------------------------
// WrfcController
// ---------------------------------------------------------------------------

export class WrfcController {
  private static instance: WrfcController | null = null;
  private chains = new Map<string, WrfcChain>();
  private chainQueue: QueuedChain[] = [];
  private eventBus: EventBus;
  private unsubscribers: Array<() => void> = [];
  /** Counter of currently active (non-terminal) chains — avoids linear scan on every spawn. */
  private activeChainCount = 0;
  /** Pending parent chain IDs for follow-up agents: agentId → parentChainId. */
  private pendingParentChainIds = new Map<string, string>();
  private sessionId: string;
  private workmap: WrfcWorkmap;

  private constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
    this.sessionId = crypto.randomUUID().slice(0, 8);
    this.workmap = new WrfcWorkmap(this.sessionId);
    this.setupListeners();
  }

  // ---------------------------------------------------------------------------
  // Singleton
  // ---------------------------------------------------------------------------

  static getInstance(eventBus?: EventBus): WrfcController {
    if (!WrfcController.instance) {
      if (!eventBus) throw new Error('WrfcController requires EventBus on first initialization');
      WrfcController.instance = new WrfcController(eventBus);
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
      // Enqueue and return a placeholder pending chain
      const id = this.generateWrfcId();
      const chain: WrfcChain = {
        id,
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
      this.chains.set(id, chain);
      engineerRecord.wrfcId = id;

      // Check if a parent chain was pre-registered for this agent
      const pendingParentId = this.pendingParentChainIds.get(engineerRecord.id);
      if (pendingParentId) {
        chain.parentChainId = pendingParentId;
        const parent = this.chains.get(pendingParentId);
        if (parent) chain.gateRetryDepth = parent.gateRetryDepth + (parent.gateFailureFingerprint ? 1 : 0);
        this.pendingParentChainIds.delete(engineerRecord.id);
      }

      this.chainQueue.push({ record: engineerRecord, queuedAt: Date.now() });

      logger.debug('WrfcController.createChain: at cap, queued', {
        chainId: id,
        agentId: engineerRecord.id,
        activeCount,
        queueLength: this.chainQueue.length,
      });

      this.eventBus.emit('wrfc:chain-created', { chainId: id, task: chain.task });
      return chain;
    }

    const id = this.generateWrfcId();

    const chain: WrfcChain = {
      id,
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

    this.chains.set(id, chain);

    // Link the agent record to this chain
    engineerRecord.wrfcId = id;

    // Check if a parent chain was pre-registered for this agent
    const pendingParentId = this.pendingParentChainIds.get(engineerRecord.id);
    if (pendingParentId) {
      chain.parentChainId = pendingParentId;
      const parent = this.chains.get(pendingParentId);
      if (parent) chain.gateRetryDepth = parent.gateRetryDepth + (parent.gateFailureFingerprint ? 1 : 0);
      this.pendingParentChainIds.delete(engineerRecord.id);
    }

    // Transition immediately to 'engineering'
    this.activeChainCount++;
    this.transition(chain, 'engineering');

    this.eventBus.emit('wrfc:chain-created', { chainId: id, task: chain.task });

    logger.debug('WrfcController.createChain', { chainId: id, agentId: engineerRecord.id });
    return chain;
  }

  getSessionId(): string { return this.sessionId; }

  getWorkmap(): WrfcWorkmap { return this.workmap; }

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

    this.eventBus.emit('wrfc:state-changed', { chainId: chain.id, from, to });
    logger.debug('WrfcController.transition', { chainId: chain.id, from, to });
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private setupListeners(): void {
    const onComplete = ({ id }: { id: string; result: unknown }) => {
      this.onAgentComplete(id).catch((err) => {
        logger.error('WrfcController.onAgentComplete unhandled error', {
          agentId: id,
          error: String(err),
        });
      });
    };

    const onError = ({ id, error }: { id: string; error: Error }) => {
      this.onAgentFailed(id, error.message);
    };

    const unsubComplete = this.eventBus.on('subagent:complete', onComplete);
    const unsubError = this.eventBus.on('subagent:error', onError);

    this.unsubscribers.push(unsubComplete, unsubError);
  }

  private async onAgentComplete(agentId: string): Promise<void> {
    const chain = this.findChainByAgentId(agentId);
    if (!chain) {
      // Not a WRFC-tracked agent — ignore
      return;
    }

    // Get the full output from AgentManager
    const record = AgentManager.getInstance().getStatus(agentId);
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
      // Engineer or fixer completed — parse report and start review
      let report = parseCompletionReport(rawOutput);

      if (!report) {
        // Construct a minimal GenericReport from raw output
        report = {
          version: 1,
          archetype: record?.template ?? 'engineer',
          summary: rawOutput.slice(0, 500) || '(no output)',
          result: rawOutput,
        } as CompletionReport;
      }

      if (chain.state === 'engineering') {
        chain.engineerReport = report;
        this.workmap.append({ ts: new Date().toISOString(), wrfcId: chain.id, event: 'engineer_complete', agentId, task: chain.task });
      }

      this.startReview(chain, report);
    } else if (chain.state === 'reviewing') {
      // Reviewer completed — parse review report and process
      let reviewerReport = parseCompletionReport(rawOutput);

      if (!reviewerReport || reviewerReport.archetype !== 'reviewer') {
        // Construct a minimal passing ReviewerReport if none found
        logger.warn('WrfcController: no structured ReviewerReport found, constructing minimal', {
          chainId: chain.id,
        });
        reviewerReport = {
          version: 1,
          archetype: 'reviewer',
          summary: rawOutput.slice(0, 500) || '(no reviewer output)',
          score: 0,
          passed: false,
          dimensions: [],
          issues: [],
        };
      }

      const narrowedReport = reviewerReport as ReviewerReport;
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

    const threshold = configManager.get('wrfc.scoreThreshold') as number;

    const reviewTask = [
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
      `2. Verify the implementation meets all stated requirements.`,
      `3. Score the implementation using the 10-dimension review rubric.`,
      `4. The passing score threshold is ${threshold}/10.`,
      `5. Return a structured ReviewerReport JSON block in your final response.`,
      ``,
      `The ReviewerReport must include:`,
      `- version: 1`,
      `- archetype: "reviewer"`,
      `- score: <number 0-10>`,
      `- passed: <boolean>`,
      `- dimensions: array of { name, score, maxScore, issues[] }`,
      `- issues: array of { severity, description, file?, line?, pointValue }`,
    ].join('\n');

    const manager = AgentManager.getInstance();
    const reviewerRecord = manager.spawn({
      mode: 'spawn',
      task: reviewTask,
      template: 'reviewer',
      dangerously_disable_wrfc: true,
    });

    chain.reviewerAgentId = reviewerRecord.id;
    chain.allAgentIds.push(reviewerRecord.id);
    reviewerRecord.wrfcId = chain.id;

    logger.debug('WrfcController.startReview', {
      chainId: chain.id,
      reviewerAgentId: reviewerRecord.id,
    });
  }

  private async processReview(chain: WrfcChain, review: ReviewerReport): Promise<void> {
    const threshold = configManager.get('wrfc.scoreThreshold') as number;

    this.eventBus.emit('wrfc:review-complete', {
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
          this.eventBus.emit('wrfc:cascade-abort', {
            chainId: chain.id,
            reason: `Score regression warning: initial ${initial}/10, last two ${last2[0]}/10, ${last2[1]}/10 — both below initial. Fix quality may be degrading.`,
          });
        }
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

    const threshold = configManager.get('wrfc.scoreThreshold') as number;

    this.eventBus.emit('wrfc:fix-attempt', {
      chainId: chain.id,
      attempt: chain.fixAttempts,
      maxAttempts: configManager.get('wrfc.maxFixAttempts') as number,
    });

    const issueList = review.issues
      .map((issue) => {
        const location = issue.file ? ` (${issue.file}${issue.line ? `:${issue.line}` : ''})` : '';
        return `- [${issue.severity.toUpperCase()}] ${issue.description}${location} (-${issue.pointValue} pts)`;
      })
      .join('\n');

    const fixTask = [
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
      `3. Return a structured EngineerReport JSON block in your final response.`,
    ].join('\n');

    const manager = AgentManager.getInstance();
    const fixerRecord = manager.spawn({
      mode: 'spawn',
      task: fixTask,
      template: 'engineer',
      dangerously_disable_wrfc: true,
    });

    chain.fixerAgentId = fixerRecord.id;
    chain.allAgentIds.push(fixerRecord.id);
    fixerRecord.wrfcId = chain.id;

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

    const wrfcConfig = configManager.getCategory('wrfc');
    const gates = (wrfcConfig.gates ?? []).filter((g) => g.enabled);

    logger.debug('WrfcController.runGates', {
      chainId: chain.id,
      gateCount: gates.length,
    });

    // Read package.json once for script-based gate checks
    const cwd = process.cwd();
    let pkgScripts: Record<string, string> = {};
    const pkgPath = join(cwd, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkgJson = JSON.parse(await Bun.file(pkgPath).text()) as { scripts?: Record<string, string> };
        pkgScripts = pkgJson.scripts ?? {};
      } catch {
        // Malformed package.json — treat as no scripts
      }
    }

    const results: QualityGateResult[] = [];
    const GATE_TIMEOUT_MS = 120_000;

    for (const gate of gates) {
      // Gate auto-detection: skip gates whose required config files are absent
      let skipReason: string | null = null;

      if (gate.name === 'typecheck') {
        if (!existsSync(join(cwd, 'tsconfig.json'))) {
          skipReason = 'Skipped: no tsconfig.json found';
        }
      } else if (gate.name === 'lint') {
        const lintConfigs = [
          'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
          '.eslintrc.json', '.eslintrc.js', '.eslintrc.yml', '.eslintrc.yaml', '.eslintrc',
        ];
        if (!lintConfigs.some((f) => existsSync(join(cwd, f)))) {
          skipReason = 'Skipped: no ESLint config found';
        }
      } else if (gate.name === 'test') {
        if (!pkgScripts['test']) {
          skipReason = 'Skipped: no test script in package.json';
        }
      } else if (gate.name === 'build') {
        if (!pkgScripts['build']) {
          skipReason = 'Skipped: no build script in package.json';
        }
      }

      if (skipReason !== null) {
        const result: QualityGateResult = {
          gate: gate.name,
          passed: true,
          output: skipReason,
          durationMs: 0,
        };
        results.push(result);
        chain.gateResults = results.slice();
        this.eventBus.emit('wrfc:gate-result', {
          chainId: chain.id,
          gate: gate.name,
          passed: true,
        });
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

      try {
        const proc = Bun.spawn(['sh', '-c', gate.command], {
          stdout: 'pipe',
          stderr: 'pipe',
        });

        // Timeout: kill process after 120s
        const timer = setTimeout(() => {
          try { proc.kill(); } catch { /* already exited */ }
        }, GATE_TIMEOUT_MS);

        let exitCode: number;
        try {
          exitCode = await proc.exited;
          clearTimeout(timer);
        } catch (err) {
          clearTimeout(timer);
          try { proc.kill(); } catch { /* already dead */ }
          throw err;
        }

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        output = [stdout, stderr].filter(Boolean).join('\n').trim();

        passed = exitCode === 0;
      } catch (err) {
        output = err instanceof Error ? err.message : String(err);
        passed = false;
      }

      const durationMs = Date.now() - startedAt;
      const result: QualityGateResult = {
        gate: gate.name,
        passed,
        output,
        durationMs,
      };

      results.push(result);
      chain.gateResults = results.slice();

      this.eventBus.emit('wrfc:gate-result', {
        chainId: chain.id,
        gate: gate.name,
        passed,
      });

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
    const allPassed = results.length === 0 || results.every((r) => r.passed);
    const autoCommit = configManager.get('wrfc.autoCommit') as boolean;

    for (const r of results) {
      this.workmap.append({ ts: new Date().toISOString(), wrfcId: chain.id, event: 'gate_result', gate: r.gate, passed: r.passed, gateOutput: r.output.slice(0, 200) });
    }

    if (allPassed) {
      this.workmap.append({ ts: new Date().toISOString(), wrfcId: chain.id, event: 'chain_passed' });
      chain.gatesPassed = true;
      if (autoCommit) {
        await this.autoCommit(chain);
      } else {
        this.activeChainCount = Math.max(0, this.activeChainCount - 1);
        this.transition(chain, 'passed');
        this.eventBus.emit('wrfc:chain-passed', { chainId: chain.id });
        chain.completedAt = Date.now();
        this.scheduleChainCleanup(chain);
        this.dequeueNext().catch((err) => {
          logger.error('WrfcController.dequeueNext unhandled error', { error: String(err) });
        });
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
      const maxGateRetries = configManager.get('wrfc.maxFixAttempts') as number;

      // Store fingerprint on current chain before transitioning
      chain.gateFailureFingerprint = fingerprint;

      this.activeChainCount = Math.max(0, this.activeChainCount - 1);
      this.transition(chain, 'passed');
      this.eventBus.emit('wrfc:chain-passed', { chainId: chain.id });
      chain.completedAt = Date.now();
      this.scheduleChainCleanup(chain);
      this.dequeueNext().catch((err) => {
        logger.error('WrfcController.dequeueNext unhandled error', { error: String(err) });
      });

      if (chain.gateRetryDepth >= maxGateRetries) {
        // Hard cap on gate retries reached — fail, don't spawn more agents
        logger.error(
          'WrfcController.processGateResults: gate retry limit reached, manual intervention required',
          { chainId: chain.id, gateRetryDepth: chain.gateRetryDepth, maxGateRetries }
        );
        this.eventBus.emit('wrfc:cascade-abort', {
          chainId: chain.id,
          reason: `Gate failures exceeded max retries (${chain.gateRetryDepth}/${maxGateRetries}). Manual intervention required.`,
        });
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

      const manager = AgentManager.getInstance();
      // Register parent chain ID — handles both sync createChain (during spawn) and async createChain (after spawn)
      const parentChainIdForFollowUp = chain.id;

      // We don't know the follow-up record's ID yet — register after spawn
      const followUpRecord = manager.spawn({
        mode: 'spawn',
        task: followUpTask,
        template: 'engineer',
        // No dangerously_disable_wrfc — gets its own full WRFC chain
      });

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
    }, 60_000);
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
      this.activeChainCount = Math.max(0, this.activeChainCount - 1);
      // No actual commit — intentionally skip wrfc:auto-commit event (commit didn't happen)
      this.transition(chain, 'passed');
      chain.completedAt = Date.now();
      this.eventBus.emit('wrfc:chain-passed', { chainId: chain.id });
      this.scheduleChainCleanup(chain);
      this.dequeueNext().catch((err) => {
        logger.error('WrfcController.dequeueNext unhandled error', { error: String(err) });
      });
      return;
    }

    const worktree = new AgentWorktree();

    try {
      const merged = await worktree.merge(agentId);

      this.activeChainCount = Math.max(0, this.activeChainCount - 1);
      this.transition(chain, 'passed');
      chain.completedAt = Date.now();
      this.scheduleChainCleanup(chain);

      this.eventBus.emit('wrfc:auto-commit', { chainId: chain.id });
      this.eventBus.emit('wrfc:chain-passed', { chainId: chain.id });
      this.dequeueNext().catch((err) => {
        logger.error('WrfcController.dequeueNext unhandled error', { error: String(err) });
      });

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

    this.eventBus.emit('wrfc:chain-failed', { chainId: chain.id, reason });

    logger.error('WrfcController.failChain', { chainId: chain.id, reason });

    this.scheduleChainCleanup(chain);

    this.dequeueNext().catch((err) => {
      logger.error('WrfcController.dequeueNext unhandled error', { error: String(err) });
    });
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

    this.activeChainCount++;
    this.transition(chain, 'engineering');

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
}
