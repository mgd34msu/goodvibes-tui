import type { PermissionPromptRequest } from '../prompt.ts';
import { classifyPermissionRiskFamily } from '../../runtime/permissions/risk-model.ts';
import { explainPermissionRiskFamily } from '../../runtime/permissions/risk-language.ts';
import type { PermissionApprovalBrief } from './types.ts';
import type { PermissionRequestAnalysis } from '../types.ts';

export function getDisplayArg(_tool: string, args: Record<string, unknown>): string {
  if (typeof args['path'] === 'string') return args['path'];
  if (typeof args['command'] === 'string') return args['command'];
  if (typeof args['pattern'] === 'string') return args['pattern'];
  const first = Object.values(args)[0];
  return typeof first === 'string' ? first : JSON.stringify(args).slice(0, 60);
}

function fallbackAnalysis(request: PermissionPromptRequest): PermissionRequestAnalysis {
  return request.analysis ?? {
    classification: request.category,
    riskLevel: request.category === 'read' ? 'low' : request.category === 'write' ? 'medium' : 'high',
    summary: `Review ${request.tool} request`,
    reasons: ['Inspect the target and intent before approving this action.'],
    target: getDisplayArg(request.tool, request.args),
    targetKind: 'generic',
  };
}

function subjectLabel(analysis: PermissionRequestAnalysis): string {
  switch (analysis.targetKind) {
    case 'command': return 'Command';
    case 'path': return 'Path';
    case 'url': return 'URL';
    case 'task': return 'Task';
    default: return 'Target';
  }
}

function titleForRisk(decisionModeLabel: string): string {
  const TITLES: Partial<Record<string, string>> = {
    delegation: 'Agent Delegation Approval',
    'shell-read': 'Shell Execution Approval',
    'shell-execution': 'Shell Execution Approval',
    'network-egress': 'Network Access Approval',
    'external-access': 'Network Access Approval',
    'config-mutation': 'Configuration Mutation Approval',
    'mcp-escalation': 'MCP Trust Escalation Approval',
  };
  const mapped = TITLES[decisionModeLabel];
  if (mapped) return mapped;
  const headline = decisionModeLabel.replace(/-/g, ' ');
  return headline.replace(/\b\w/g, (char) => char.toUpperCase()) + ' Approval';
}

function decisionModeLabelForRisk(family: string): string {
  switch (family) {
    case 'shell-read':
    case 'shell-mutation':
    case 'shell-destructive':
      return 'shell-execution';
    case 'network-egress':
      return 'external-access';
    default:
      return family;
  }
}

function checklistForDecision(family: string, decisionModeLabel: string): string {
  switch (decisionModeLabel) {
    case 'shell-execution':
      return explainPermissionRiskFamily('shell-mutation');
    case 'external-access':
      return explainPermissionRiskFamily('network-egress');
    default:
      return explainPermissionRiskFamily(family as Parameters<typeof explainPermissionRiskFamily>[0]);
  }
}

export function buildPermissionApprovalBrief(request: PermissionPromptRequest): PermissionApprovalBrief {
  const analysis = fallbackAnalysis(request);
  const risk = classifyPermissionRiskFamily(request.tool, request.args, analysis);
  const decisionModeLabel = decisionModeLabelForRisk(risk.family);
  return {
    title: titleForRisk(decisionModeLabel),
    subjectLabel: subjectLabel(analysis),
    subjectValue: String(analysis.target ?? getDisplayArg(request.tool, request.args)),
    decisionModeLabel,
    checklist: checklistForDecision(risk.family, decisionModeLabel),
    risk,
  };
}
