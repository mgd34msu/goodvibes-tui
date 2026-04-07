export type PermissionCategory = 'read' | 'write' | 'execute' | 'delegate';

export type PermissionRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type PermissionDecisionSource =
  | 'config_policy'
  | 'managed_policy'
  | 'safety_check'
  | 'runtime_mode'
  | 'session_override'
  | 'user_prompt';

export type PermissionDecisionReasonCode =
  | 'config_allow'
  | 'config_deny'
  | 'managed_policy_allow'
  | 'managed_policy_deny'
  | 'safety_guardrail'
  | 'mode_allow_all'
  | 'mode_denied'
  | 'session_cached_allow'
  | 'session_cached_deny'
  | 'user_approved'
  | 'user_denied';

export type PermissionAnalysisTargetKind = 'command' | 'path' | 'url' | 'task' | 'generic';
export type PermissionAnalysisSurface = 'filesystem' | 'shell' | 'network' | 'orchestration' | 'platform' | 'generic';
export type PermissionBlastRadius = 'local' | 'project' | 'external' | 'delegated' | 'platform';

export interface PermissionRequestAnalysis {
  readonly classification: string;
  readonly riskLevel: PermissionRiskLevel;
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly target?: string;
  readonly targetKind?: PermissionAnalysisTargetKind;
  readonly surface?: PermissionAnalysisSurface;
  readonly blastRadius?: PermissionBlastRadius;
  readonly sideEffects?: readonly string[];
  readonly host?: string;
}

export interface PermissionCheckResult {
  readonly approved: boolean;
  readonly persisted: boolean;
  readonly sourceLayer: PermissionDecisionSource;
  readonly reasonCode: PermissionDecisionReasonCode;
  readonly analysis: PermissionRequestAnalysis;
}
