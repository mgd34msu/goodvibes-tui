import { EventBus } from '../core/event-bus.ts';
import { AgentManager, type AgentRecord } from '../tools/agent/index.ts';
import { type CompletionReport, type ReviewerReport, parseCompletionReport } from './completion-report.ts';
import type { WrfcChain, WrfcState, QualityGateResult } from './wrfc-types.ts';
import { AgentWorktree } from './worktree.ts';
import { configManager } from '../config/index.ts';
import { logger } from '../utils/logger.ts';

/**
 * WrfcController — Event-driven state machine for automated WRFC chains.
 *
 * Lifecycle:
 *   1. Agent spawned without skipWrfc → createChain() → state: engineering
 *   2. Engineer completes → parse report → spawn reviewer → state: reviewing
 *   3. Reviewer completes → check score vs threshold
 *      a. Score >= threshold → run quality gates → state: gating
 *      b. Score < threshold → spawn fixer → state: fixing → back to step 2
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
  pending:     ['engineering'],
  engineering: ['reviewing', 'failed'],
  reviewing:   ['fixing', 'gating', 'failed'],
  fixing:      ['reviewing', 'failed'],
  gating:      ['passed', 'failed', 'committing'],
  committing:  ['passed', 'failed'],
};

// ---------------------------------------------------------------------------
// WrfcController
// ---------------------------------------------------------------------------

export class WrfcController {
  private static instance: WrfcController | null = null;
  private chains = new Map<string, WrfcChain>();
  private eventBus: EventBus;
  private unsubscribers: Array<() => void> = [];

  private constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
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
    const id = this.generateWrfcId();

    const chain: WrfcChain = {
      id,
      state: 'pending',
      task: engineerRecord.task,
      engineerAgentId: engineerRecord.id,
      allAgentIds: [engineerRecord.id],
      fixAttempts: 0,
      reviewCycles: 0,
      createdAt: Date.now(),
    };

    this.chains.set(id, chain);

    // Link the agent record to this chain
    engineerRecord.wrfcId = id;

    // Transition immediately to 'engineering'
    this.transition(chain, 'engineering');

    this.eventBus.emit('wrfc:chain-created', { chainId: id, task: chain.task });

    logger.debug('WrfcController.createChain', { chainId: id, agentId: engineerRecord.id });
    return chain;
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

      chain.reviewerReport = reviewerReport;
      chain.reviewCycles += 1;

      await this.processReview(chain, reviewerReport);
    }
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
      skipWrfc: true,
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
    const maxFixes = configManager.get('wrfc.maxFixAttempts') as number;

    this.eventBus.emit('wrfc:review-complete', {
      chainId: chain.id,
      score: review.score,
      passed: review.passed,
    });

    logger.debug('WrfcController.processReview', {
      chainId: chain.id,
      score: review.score,
      threshold,
      fixAttempts: chain.fixAttempts,
      maxFixes,
    });

    if (review.score >= threshold) {
      await this.runAndProcessGates(chain);
    } else if (chain.fixAttempts < maxFixes) {
      this.startFix(chain, review);
    } else {
      this.failChain(
        chain,
        `Review score ${review.score} below threshold ${threshold} after ${chain.fixAttempts} fix attempts`
      );
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
      skipWrfc: true,
    });

    chain.fixerAgentId = fixerRecord.id;
    chain.allAgentIds.push(fixerRecord.id);
    fixerRecord.wrfcId = chain.id;

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

    const results: QualityGateResult[] = [];
    const GATE_TIMEOUT_MS = 120_000;

    for (const gate of gates) {
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

    if (allPassed) {
      chain.gatesPassed = true;
      if (autoCommit) {
        await this.autoCommit(chain);
      } else {
        this.transition(chain, 'passed');
        this.eventBus.emit('wrfc:chain-passed', { chainId: chain.id });
        chain.completedAt = Date.now();
      }
    } else {
      // Gate(s) failed — this chain's review passed, but we spawn a new engineer
      // chain (without skipWrfc) to address the gate failures.
      this.transition(chain, 'passed');
      this.eventBus.emit('wrfc:chain-passed', { chainId: chain.id });
      chain.completedAt = Date.now();

      const failedGates = results.filter((r) => !r.passed);
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
      const followUpRecord = manager.spawn({
        mode: 'spawn',
        task: followUpTask,
        template: 'engineer',
        // No skipWrfc — gets its own full WRFC chain
      });

      // The new agent will get a new chain via the orchestrator's spawn hook (Phase 10).
      // Record parentage so the UI can show the relationship.
      const followUpChain = this.findChainByAgentId(followUpRecord.id);
      if (followUpChain) {
        followUpChain.parentChainId = chain.id;
      }

      logger.debug('WrfcController.processGateResults: gate failure — spawned follow-up agent', {
        parentChainId: chain.id,
        followUpAgentId: followUpRecord.id,
      });
    }
  }

  private async runAndProcessGates(chain: WrfcChain): Promise<void> {
    const results = await this.runGates(chain);
    await this.processGateResults(chain, results);
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

    const worktree = new AgentWorktree();

    try {
      const merged = await worktree.merge(agentId);

      this.transition(chain, 'passed');
      chain.completedAt = Date.now();

      this.eventBus.emit('wrfc:auto-commit', { chainId: chain.id });
      this.eventBus.emit('wrfc:chain-passed', { chainId: chain.id });

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
    try {
      this.transition(chain, 'failed');
    } catch {
      // Already failed or in a state that can't transition — force it
      chain.state = 'failed';
    }

    chain.error = reason;
    chain.completedAt = Date.now();

    this.eventBus.emit('wrfc:chain-failed', { chainId: chain.id, reason });

    logger.error('WrfcController.failChain', { chainId: chain.id, reason });
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
