import { PolicyRegistry } from './policy-registry.ts';
import { DivergencePanel } from '../diagnostics/panels/divergence.ts';
import type { PolicyPanelSnapshot } from '../diagnostics/panels/policy.ts';
import { PolicyPanel as PolicyDiagnosticsPanel } from '../diagnostics/panels/policy.ts';
import type { DivergenceDashboard } from './divergence-dashboard.ts';
import type { PermissionCheckResult } from '../../permissions/types.ts';
import { lintPolicyConfig } from './lint.ts';
import type { PolicySimulationSummary } from './simulation-scenarios.ts';
import type { PolicyPreflightReview } from './preflight.ts';

const MAX_PERMISSION_AUDIT = 100;

export interface PermissionAuditEntry {
  readonly callId: string;
  readonly tool: string;
  readonly category: string;
  readonly approved?: boolean;
  readonly sourceLayer?: string;
  readonly reasonCode?: string;
  readonly riskLevel: string;
  readonly classification: string;
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly target?: string;
  readonly host?: string;
  readonly requestedAt: number;
  readonly decidedAt?: number;
  readonly persisted?: boolean;
}

export class PolicyRuntimeState {
  private readonly _registry: PolicyRegistry;
  private _dashboard: DivergenceDashboard | null = null;
  private _divergencePanel: DivergencePanel | null = null;
  private readonly _recentPermissionAudit: PermissionAuditEntry[] = [];
  private _lastSimulationSummary: PolicySimulationSummary | null = null;
  private _lastPreflightReview: PolicyPreflightReview | null = null;
  private readonly _subscribers = new Set<() => void>();

  public constructor(registry: PolicyRegistry = new PolicyRegistry()) {
    this._registry = registry;
  }

  public getRegistry(): PolicyRegistry {
    return this._registry;
  }

  public getDashboard(): DivergenceDashboard | null {
    return this._dashboard;
  }

  public getDivergencePanel(): DivergencePanel | null {
    return this._divergencePanel;
  }

  public setDashboard(dashboard: DivergenceDashboard | null): void {
    this._divergencePanel?.dispose();
    this._dashboard = dashboard;
    this._divergencePanel = dashboard ? new DivergencePanel(dashboard) : null;
    this.notify();
  }

  public recordTrendEntry(): void {
    this._divergencePanel?.recordTrendEntry();
    this.notify();
  }

  public getSnapshot(): PolicyPanelSnapshot {
    const current = this._registry.getCurrent();
    const candidate = this._registry.getCandidate();
    const lintFindings = [
      ...(current ? lintPolicyConfig({ mode: 'custom', rules: current.rules }) : []),
      ...(candidate ? lintPolicyConfig({ mode: 'custom', rules: candidate.rules }) : []),
    ];
    const panel = new PolicyDiagnosticsPanel(
      this._registry,
      this._divergencePanel,
      this._recentPermissionAudit,
      lintFindings,
      this._lastSimulationSummary,
      this._lastPreflightReview,
    );
    return panel.getSnapshot();
  }

  public recordSimulationSummary(summary: PolicySimulationSummary): void {
    this._lastSimulationSummary = summary;
    this.notify();
  }

  public recordPreflightReview(review: PolicyPreflightReview): void {
    this._lastPreflightReview = review;
    this.notify();
  }

  public recordPermissionRequest(params: {
    callId: string;
    tool: string;
    category: string;
    analysis: PermissionCheckResult['analysis'];
  }): void {
    this._upsertPermissionAudit({
      callId: params.callId,
      tool: params.tool,
      category: params.category,
      riskLevel: params.analysis.riskLevel,
      classification: params.analysis.classification,
      summary: params.analysis.summary,
      reasons: params.analysis.reasons,
      target: params.analysis.target,
      host: params.analysis.host,
      requestedAt: Date.now(),
    });
    this.notify();
  }

  public recordPermissionDecision(params: {
    callId: string;
    tool: string;
    category: string;
    result: PermissionCheckResult;
  }): void {
    this._upsertPermissionAudit({
      callId: params.callId,
      tool: params.tool,
      category: params.category,
      approved: params.result.approved,
      sourceLayer: params.result.sourceLayer,
      reasonCode: params.result.reasonCode,
      riskLevel: params.result.analysis.riskLevel,
      classification: params.result.analysis.classification,
      summary: params.result.analysis.summary,
      reasons: params.result.analysis.reasons,
      target: params.result.analysis.target,
      host: params.result.analysis.host,
      requestedAt: Date.now(),
      decidedAt: Date.now(),
      persisted: params.result.persisted,
    });
    this.notify();
  }

  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => {
      this._subscribers.delete(callback);
    };
  }

  public notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch {
        // Panel/runtime subscribers must not break policy state propagation.
      }
    }
  }

  private _upsertPermissionAudit(entry: PermissionAuditEntry): void {
    const existingIndex = this._recentPermissionAudit.findIndex((candidate) => candidate.callId === entry.callId);
    if (existingIndex >= 0) {
      this._recentPermissionAudit[existingIndex] = {
        ...this._recentPermissionAudit[existingIndex]!,
        ...entry,
        requestedAt: this._recentPermissionAudit[existingIndex]!.requestedAt,
      };
    } else {
      this._recentPermissionAudit.unshift(entry);
      if (this._recentPermissionAudit.length > MAX_PERMISSION_AUDIT) {
        this._recentPermissionAudit.length = MAX_PERMISSION_AUDIT;
      }
    }
  }
}

let _policyRuntimeState: PolicyRuntimeState | null = null;

export function getPolicyRuntimeState(): PolicyRuntimeState {
  if (_policyRuntimeState === null) {
    _policyRuntimeState = new PolicyRuntimeState();
  }
  return _policyRuntimeState;
}

export function resetPolicyRuntimeStateForTests(): void {
  _policyRuntimeState = null;
}
