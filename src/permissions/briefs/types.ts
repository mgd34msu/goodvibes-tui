import type { PermissionRiskDescriptor } from '../../runtime/permissions/risk-model.ts';

export interface PermissionApprovalBrief {
  readonly title: string;
  readonly subjectLabel: string;
  readonly subjectValue: string;
  readonly decisionModeLabel: string;
  readonly checklist: string;
  readonly risk: PermissionRiskDescriptor;
}

