/**
 * Execution Plan Manager — tracks live progress for multi-step agent tasks.
 *
 * Plans are stored as JSON at .goodvibes/plans/<id>.json and rendered as
 * markdown for injection into the model's context. Self-contained, no
 * orchestrator dependency.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type PlanItemStatus = 'pending' | 'in_progress' | 'complete' | 'failed' | 'skipped';

export interface PlanItem {
  id: string;
  phase: string;
  description: string;
  status: PlanItemStatus;
  agentId?: string; // set when an agent is assigned
  dependencies?: string[]; // IDs of items that must complete first
}

export interface ExecutionPlan {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: 'draft' | 'active' | 'complete' | 'failed';
  items: PlanItem[];
  specPath?: string; // path to the spec document
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_CHECKBOX: Record<PlanItemStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  complete: '[x]',
  failed: '[!]',
  skipped: '[-]',
};

const STATUS_LABEL: Record<PlanItemStatus, string> = {
  pending: 'PENDING',
  in_progress: 'IN_PROGRESS',
  complete: 'COMPLETE',
  failed: 'FAILED',
  skipped: 'SKIPPED',
};

function parseItemStatus(checkbox: string, label?: string): PlanItemStatus {
  if (label) {
    const upper = label.toUpperCase().trim();
    if (upper === 'COMPLETE' || upper === 'DONE') return 'complete';
    if (upper === 'IN_PROGRESS' || upper === 'IN PROGRESS' || upper === 'ACTIVE') return 'in_progress';
    if (upper === 'FAILED' || upper === 'ERROR') return 'failed';
    if (upper === 'SKIPPED' || upper === 'SKIP') return 'skipped';
  }
  const c = checkbox.trim();
  if (c === '[x]' || c === '[X]') return 'complete';
  if (c === '[~]') return 'in_progress';
  if (c === '[!]') return 'failed';
  if (c === '[-]') return 'skipped';
  return 'pending';
}

function phaseStatus(items: PlanItem[]): string {
  if (items.length === 0) return 'PENDING';
  if (items.every((i) => i.status === 'complete' || i.status === 'skipped')) return 'COMPLETE';
  if (items.some((i) => i.status === 'in_progress')) return 'IN_PROGRESS';
  if (items.some((i) => i.status === 'failed')) return 'FAILED';
  return 'PENDING';
}

// ---------------------------------------------------------------------------
// ExecutionPlanManager
// ---------------------------------------------------------------------------

export class ExecutionPlanManager {
  private readonly plansDir: string;
  private readonly activeFile: string;

  constructor(baseDir?: string) {
    const root = baseDir ?? join(process.cwd(), '.goodvibes', 'plans');
    this.plansDir = root;
    this.activeFile = join(root, 'active.json');
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  /** Load plan from disk (.goodvibes/plans/<id>.json). Returns null if not found. */
  load(planId: string): ExecutionPlan | null {
    const filePath = join(this.plansDir, `${planId}.json`);
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as ExecutionPlan;
    } catch {
      return null;
    }
  }

  /** Save plan to disk. Creates directories as needed. */
  save(plan: ExecutionPlan): void {
    mkdirSync(this.plansDir, { recursive: true });
    const filePath = join(this.plansDir, `${plan.id}.json`);
    writeFileSync(filePath, JSON.stringify(plan, null, 2) + '\n', 'utf-8');
  }

  /** Get the active plan for the current session, if any. */
  getActive(): ExecutionPlan | null {
    if (!existsSync(this.activeFile)) return null;
    try {
      const raw = readFileSync(this.activeFile, 'utf-8');
      const { planId } = JSON.parse(raw) as { planId: string | null };
      if (!planId) return null;
      return this.load(planId);
    } catch {
      return null;
    }
  }

  private setActive(planId: string | null): void {
    mkdirSync(this.plansDir, { recursive: true });
    if (planId === null) {
      if (existsSync(this.activeFile)) {
        // Remove tracking entry when no active plan
        writeFileSync(this.activeFile, JSON.stringify({ planId: null }, null, 2) + '\n', 'utf-8');
      }
      return;
    }
    writeFileSync(this.activeFile, JSON.stringify({ planId }, null, 2) + '\n', 'utf-8');
  }

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  /** Create a new plan and set it as active. */
  create(title: string, items: Omit<PlanItem, 'id' | 'status'>[]): ExecutionPlan {
    const now = new Date().toISOString();
    const plan: ExecutionPlan = {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      status: 'draft',
      items: items.map((item) => ({
        ...item,
        id: randomUUID(),
        status: 'pending',
      })),
    };
    this.save(plan);
    this.setActive(plan.id);
    return plan;
  }

  /** Update a plan item's status (and optionally assign an agent). */
  updateItem(
    planId: string,
    itemId: string,
    status: PlanItemStatus,
    agentId?: string,
  ): void {
    const plan = this.load(planId);
    if (!plan) return;

    const item = plan.items.find((i) => i.id === itemId);
    if (!item) return;

    item.status = status;
    if (agentId !== undefined) item.agentId = agentId;

    // Derive top-level plan status
    const allDone = plan.items.every((i) => i.status === 'complete' || i.status === 'skipped');
    const anyFailed = plan.items.some((i) => i.status === 'failed');
    const anyActive = plan.items.some((i) => i.status === 'in_progress');
    if (allDone) plan.status = 'complete';
    else if (anyFailed) plan.status = 'failed';
    else if (anyActive) plan.status = 'active';

    plan.updatedAt = new Date().toISOString();
    this.save(plan);
  }

  /** List all plans (reads directory, excludes active.json). */
  list(): ExecutionPlan[] {
    if (!existsSync(this.plansDir)) return [];
    const plans: ExecutionPlan[] = [];
    for (const file of readdirSync(this.plansDir)) {
      if (!file.endsWith('.json') || file === 'active.json') continue;
      const id = file.replace(/\.json$/, '');
      const plan = this.load(id);
      if (plan) plans.push(plan);
    }
    return plans.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // --------------------------------------------------------------------------
  // Markdown rendering
  // --------------------------------------------------------------------------

  /**
   * Render plan as markdown for injection into model context.
   *
   * Format:
   *   # Plan Title
   *   ## Phase 1: Setup [COMPLETE]
   *   - [x] Description — COMPLETE (agent-id)
   */
  toMarkdown(plan: ExecutionPlan): string {
    const lines: string[] = [`# ${plan.title}`, ''];

    // Group items by phase (preserve insertion order)
    const phaseOrder: string[] = [];
    const byPhase = new Map<string, PlanItem[]>();
    for (const item of plan.items) {
      if (!byPhase.has(item.phase)) {
        byPhase.set(item.phase, []);
        phaseOrder.push(item.phase);
      }
      byPhase.get(item.phase)!.push(item);
    }

    for (const phase of phaseOrder) {
      const items = byPhase.get(phase)!;
      const ps = phaseStatus(items);
      lines.push(`## ${phase} [${ps}]`);
      for (const item of items) {
        const cb = STATUS_CHECKBOX[item.status];
        const label = STATUS_LABEL[item.status];
        let line = `- ${cb} ${item.description} — ${label}`;
        if (item.agentId) line += ` (${item.agentId})`;
        if (item.dependencies && item.dependencies.length > 0) {
          const depDescs = item.dependencies
            .map((depId) => {
              const dep = plan.items.find((i) => i.id === depId);
              return dep ? dep.description : depId;
            })
            .join(', ');
          line += ` (depends: ${depDescs})`;
        }
        lines.push(line);
      }
      lines.push('');
    }

    return lines.join('\n').trimEnd() + '\n';
  }

  /**
   * Parse a markdown execution plan written by the model into structured format.
   * Robust to minor formatting variations models may produce.
   */
  parseFromMarkdown(markdown: string): Partial<ExecutionPlan> {
    const lines = markdown.split('\n');
    const items: PlanItem[] = [];
    let title = '';
    let currentPhase = '';

    // Phase heading: ## Phase N: Name [STATUS] or ## Name [STATUS] or ## Name
    const phaseRe = /^##\s+(.+?)(?:\s+\[([^\]]+)\])?\s*$/;
    // Checkbox prefix: - [x], - [ ], - [~], - [!], - [-]
    const checkboxRe = /^-\s+(\[[\sxX~!\-]\])\s+(.+)$/;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Title
      if (trimmed.startsWith('# ') && !trimmed.startsWith('## ') && !title) {
        title = trimmed.replace(/^#\s+/, '').trim();
        continue;
      }

      // Phase heading
      const phaseMatch = phaseRe.exec(trimmed);
      if (phaseMatch && trimmed.startsWith('## ')) {
        currentPhase = phaseMatch[1].trim();
        continue;
      }

      // Item
      if (trimmed.startsWith('- ') && currentPhase) {
        const cbMatch = checkboxRe.exec(trimmed);
        if (cbMatch) {
          const [, checkbox, rest] = cbMatch;

          // Split from the RIGHT on ' — ' to separate description from metadata.
          // This handles em-dashes in descriptions (only the last occurrence splits).
          const emDashIdx = rest.lastIndexOf(' \u2014 ');
          let description: string;
          let metaPart: string | undefined;

          if (emDashIdx !== -1) {
            description = rest.slice(0, emDashIdx).trim();
            metaPart = rest.slice(emDashIdx + 3).trim(); // 3 = " — ".length
          } else {
            description = rest.trim();
          }

          let statusLabel: string | undefined;
          let agentId: string | undefined;
          let rawDeps: string | undefined;

          if (metaPart) {
            // Extract trailing (depends: ...) first
            const depsMatch = /\(depends:\s*([^)]+)\)\s*$/.exec(metaPart);
            if (depsMatch) {
              rawDeps = depsMatch[1];
              metaPart = metaPart.slice(0, depsMatch.index).trim();
            }

            // Extract trailing (agent-id)
            const agentMatch = /\(([^)]+)\)\s*$/.exec(metaPart);
            if (agentMatch) {
              const candidate = agentMatch[1].trim();
              if (/^depends:/i.test(candidate)) {
                rawDeps = rawDeps ?? candidate.replace(/^depends:\s*/i, '');
              } else {
                agentId = candidate;
              }
              metaPart = metaPart.slice(0, agentMatch.index).trim();
            }

            // What remains is the status label
            if (metaPart) statusLabel = metaPart;
          }

          const dependencies = rawDeps
            ? rawDeps.split(',').map((d) => d.trim()).filter(Boolean)
            : undefined;

          items.push({
            id: randomUUID(),
            phase: currentPhase,
            description,
            status: parseItemStatus(checkbox, statusLabel),
            ...(agentId ? { agentId } : {}),
            ...(dependencies && dependencies.length > 0 ? { dependencies } : {}),
          });
        } else {
          // Fallback: best-effort parse without status
          const descMatch = /^-\s+(?:\[[\s\w~!-]\]\s+)?(.+)$/.exec(trimmed);
          if (descMatch) {
            items.push({
              id: randomUUID(),
              phase: currentPhase,
              description: descMatch[1].trim(),
              status: 'pending',
            });
          }
        }
      }
    }

    const now = new Date().toISOString();
    return {
      ...(title ? { title } : {}),
      createdAt: now,
      updatedAt: now,
      status: 'draft',
      items,
    };
  }

  // --------------------------------------------------------------------------
  // Query helpers
  // --------------------------------------------------------------------------

  /** Human-readable summary: "Phase 2: Implementation — 1/3 complete" */
  getSummary(plan: ExecutionPlan): string {
    const phaseOrder: string[] = [];
    const byPhase = new Map<string, PlanItem[]>();
    for (const item of plan.items) {
      if (!byPhase.has(item.phase)) {
        byPhase.set(item.phase, []);
        phaseOrder.push(item.phase);
      }
      byPhase.get(item.phase)!.push(item);
    }

    // Find the first non-complete phase
    for (const phase of phaseOrder) {
      const phaseItems = byPhase.get(phase)!;
      const done = phaseItems.filter(
        (i) => i.status === 'complete' || i.status === 'skipped',
      ).length;
      if (done < phaseItems.length) {
        return `${phase}: ${done}/${phaseItems.length} complete`;
      }
    }

    return `${plan.title}: all complete`;
  }

  /** Get next actionable items: dependencies met, status=pending. */
  getNextItems(plan: ExecutionPlan): PlanItem[] {
    const completeIds = new Set(
      plan.items
        .filter((i) => i.status === 'complete' || i.status === 'skipped')
        .map((i) => i.id),
    );

    return plan.items.filter((item) => {
      if (item.status !== 'pending') return false;
      if (!item.dependencies || item.dependencies.length === 0) return true;
      return item.dependencies.every((depId) => completeIds.has(depId));
    });
  }
}
