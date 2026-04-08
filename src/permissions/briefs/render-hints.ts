import type { PermissionApprovalBrief } from './types.ts';

export function formatPermissionBriefHint(brief: PermissionApprovalBrief): string {
  return `${brief.risk.headline} · ${brief.subjectLabel.toLowerCase()} review`;
}
