import type { GoodVibesConfig, DeepReadonly } from '../../config/index.ts';
import type { PolicyLintFinding } from '@pellux/goodvibes-sdk/platform/runtime/permissions/lint';
import type { McpServerRole, McpTrustMode } from '@pellux/goodvibes-sdk/platform/runtime/mcp/types';

export type PolicyPreflightStatus = 'pass' | 'warn' | 'block';

export interface PolicyPreflightServer {
  readonly serverName: string;
  readonly trustMode: McpTrustMode;
  readonly role: McpServerRole;
  readonly allowedPaths: readonly string[];
  readonly allowedHosts: readonly string[];
}

export interface PolicyPreflightIssue {
  readonly severity: 'info' | 'warn' | 'error';
  readonly source: 'policy' | 'runtime' | 'mcp';
  readonly message: string;
  readonly detail?: string;
  readonly serverName?: string;
}

export interface PolicyPreflightReview {
  readonly generatedAt: string;
  readonly status: PolicyPreflightStatus;
  readonly summary: string;
  readonly issueCount: number;
  readonly issues: readonly PolicyPreflightIssue[];
}

function summarize(status: PolicyPreflightStatus, issues: readonly PolicyPreflightIssue[]): string {
  if (issues.length === 0) {
    return 'No blocking or warning conditions detected for the current policy state.';
  }
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.filter((issue) => issue.severity === 'warn').length;
  if (status === 'block') {
    return `${errors} blocking issue${errors === 1 ? '' : 's'} and ${warnings} warning${warnings === 1 ? '' : 's'} require attention before high-risk runs.`;
  }
  return `${warnings} warning${warnings === 1 ? '' : 's'} detected in the current policy posture.`;
}

export function buildPolicyPreflightReview(params: {
  config: DeepReadonly<GoodVibesConfig>;
  lintFindings: readonly PolicyLintFinding[];
  mcpServers: readonly PolicyPreflightServer[];
}): PolicyPreflightReview {
  const issues: PolicyPreflightIssue[] = [];

  for (const finding of params.lintFindings) {
    issues.push({
      severity: finding.severity === 'error' ? 'error' : finding.severity === 'warn' ? 'warn' : 'info',
      source: 'policy',
      message: finding.message,
      detail: finding.ruleId ? `rule=${finding.ruleId}` : undefined,
    });
  }

  if (params.config.permissions.mode === 'allow-all') {
    issues.push({
      severity: 'error',
      source: 'runtime',
      message: 'Permission mode is allow-all.',
      detail: 'All runtime permission checks are bypassed for local tools.',
    });
  }

  for (const server of params.mcpServers) {
    if (server.trustMode === 'allow-all') {
      issues.push({
        severity: 'error',
        source: 'mcp',
        serverName: server.serverName,
        message: `MCP server "${server.serverName}" is in allow-all mode.`,
        detail: `role=${server.role} paths=${server.allowedPaths.length} hosts=${server.allowedHosts.length}`,
      });
    } else if (server.trustMode === 'ask-on-risk') {
      issues.push({
        severity: 'warn',
        source: 'mcp',
        serverName: server.serverName,
        message: `MCP server "${server.serverName}" requires approval for risky actions.`,
        detail: `role=${server.role} paths=${server.allowedPaths.length} hosts=${server.allowedHosts.length}`,
      });
    }
  }

  const status: PolicyPreflightStatus = issues.some((issue) => issue.severity === 'error')
    ? 'block'
    : issues.some((issue) => issue.severity === 'warn')
      ? 'warn'
      : 'pass';

  return {
    generatedAt: new Date().toISOString(),
    status,
    summary: summarize(status, issues),
    issueCount: issues.length,
    issues,
  };
}
