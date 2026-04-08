import type { PermissionRiskFamily } from './risk-model.ts';

const CHECKLISTS: Record<PermissionRiskFamily, string> = {
  delegation: 'Confirm delegated scope, review objective, tool ceiling, and whether fan-out is justified.',
  'shell-read': 'Confirm the command is read-only and does not expose credentials or unexpected process output.',
  'shell-mutation': 'Confirm shell side effects, write scope, and whether the command changes project state.',
  'shell-destructive': 'Confirm destructive impact, rollback path, and whether the command can affect unrelated state.',
  'dependency-install': 'Confirm dependency provenance, lockfile impact, install scripts, and trusted runtime changes.',
  'file-mutation': 'Confirm target path, write intent, and whether the file contains critical or secret-bearing state.',
  'config-mutation': 'Confirm configuration blast radius, startup/auth impact, and whether this change alters future runtime behavior.',
  'notebook-edit': 'Confirm notebook cell intent, hidden output safety, and execution metadata impact.',
  'network-egress': 'Confirm host trust, egress scope, and whether remote content should enter session context.',
  'remote-dispatch': 'Confirm remote target, trust class, capability ceiling, and whether work should leave the local runtime.',
  'agent-spawn': 'Confirm spawned agent scope, tool ceiling, recursion depth, and whether fan-out is justified.',
  'sandbox-policy-change': 'Confirm isolation-mode impact and whether this weakens a security boundary.',
  'mcp-escalation': 'Confirm server identity, trust justification, host/path scope, and why constrained modes are insufficient.',
  'plugin-lifecycle': 'Confirm package provenance, capability impact, install or update scope, and trusted extension posture.',
  'hook-execution': 'Confirm hook source, execution mode, deny/mutate authority, and blocking behavior.',
  generic: 'Confirm scope, target, and expected side effects before approving.',
};

export function explainPermissionRiskFamily(family: PermissionRiskFamily): string {
  return CHECKLISTS[family];
}
