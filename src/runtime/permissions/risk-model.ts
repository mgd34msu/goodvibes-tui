import type { PermissionRequestAnalysis, PermissionRiskLevel } from '../../permissions/types.ts';

export type PermissionRiskFamily =
  | 'delegation'
  | 'shell-read'
  | 'shell-mutation'
  | 'shell-destructive'
  | 'dependency-install'
  | 'file-mutation'
  | 'config-mutation'
  | 'notebook-edit'
  | 'network-egress'
  | 'remote-dispatch'
  | 'agent-spawn'
  | 'sandbox-policy-change'
  | 'mcp-escalation'
  | 'plugin-lifecycle'
  | 'hook-execution'
  | 'generic';

export interface PermissionRiskDescriptor {
  readonly family: PermissionRiskFamily;
  readonly level: PermissionRiskLevel;
  readonly headline: string;
}

function configLikePath(path: string): boolean {
  return /(^|\/)(\.env(\.|$)|package\.json$|tsconfig(\.[^.]+)?\.json$|bunfig\.toml$|\.npmrc$|\.bashrc$|\.zshrc$|settings\.json$|config\.[^.]+$)/i.test(path);
}

function notebookPath(path: string): boolean {
  return path.toLowerCase().endsWith('.ipynb');
}

function dependencyInstall(command: string): boolean {
  return /\b(npm|pnpm|yarn|bun)\s+(install|add|update|upgrade)\b/i.test(command);
}

export function classifyPermissionRiskFamily(
  toolName: string,
  args: Record<string, unknown>,
  analysis: PermissionRequestAnalysis,
): PermissionRiskDescriptor {
  const target = String(analysis.target ?? '');
  const command = typeof args.command === 'string' ? args.command : '';

  if (toolName === 'mcp' && args.mode === 'set-trust' && args.trustMode === 'allow-all') {
    return { family: 'mcp-escalation', level: 'critical', headline: 'MCP trust escalation' };
  }
  if ((toolName === 'remote' || toolName === 'remote_trigger') || (toolName === 'agent' && typeof args.template === 'string' && String(args.template).includes('remote'))) {
    return { family: 'remote-dispatch', level: 'high', headline: 'Remote dispatch' };
  }
  if (toolName === 'agent') {
    if (typeof args.mode === 'string' && (args.mode === 'spawn' || args.mode === 'batch-spawn')) {
      return { family: 'agent-spawn', level: 'high', headline: 'Agent spawn' };
    }
    return { family: 'delegation', level: analysis.riskLevel, headline: 'Agent delegation' };
  }
  if (toolName === 'workflow' && (typeof args.eventPath === 'string' || typeof args.hookName === 'string' || typeof args.chainName === 'string')) {
    return { family: 'hook-execution', level: 'high', headline: 'Hook execution' };
  }
  if (/(^|\/)\.goodvibes\/(plugins|skills|hooks|policies)\b/.test(target) || (toolName === 'write' && /(^|\/)(plugins|skills|hooks|policies)\//.test(target))) {
    return { family: 'plugin-lifecycle', level: analysis.riskLevel, headline: 'Plugin or ecosystem lifecycle change' };
  }
  if (/sandbox\.(replIsolation|mcpIsolation|windowsMode|vmBackend)/.test(target) || /(^|\/)(sandbox|vm)-/.test(target)) {
    return { family: 'sandbox-policy-change', level: 'high', headline: 'Sandbox policy change' };
  }
  if (analysis.targetKind === 'url') {
    return { family: 'network-egress', level: analysis.riskLevel, headline: 'External network access' };
  }
  if (analysis.targetKind === 'path' && notebookPath(target)) {
    return { family: 'notebook-edit', level: analysis.riskLevel, headline: 'Notebook edit' };
  }
  if (analysis.targetKind === 'path' && configLikePath(target)) {
    return { family: 'config-mutation', level: analysis.riskLevel, headline: 'Configuration mutation' };
  }
  if (analysis.targetKind === 'path' && analysis.classification === 'write') {
    return { family: 'file-mutation', level: analysis.riskLevel, headline: 'File mutation' };
  }
  if (analysis.classification === 'destructive') {
    return { family: 'shell-destructive', level: analysis.riskLevel, headline: 'Destructive shell command' };
  }
  if (dependencyInstall(command)) {
    return { family: 'dependency-install', level: analysis.riskLevel, headline: 'Dependency install' };
  }
  if (analysis.surface === 'shell') {
    if (analysis.classification === 'read') return { family: 'shell-read', level: analysis.riskLevel, headline: 'Read-only shell command' };
    return { family: 'shell-mutation', level: analysis.riskLevel, headline: 'Shell command with side effects' };
  }
  return { family: 'generic', level: analysis.riskLevel, headline: analysis.summary };
}
