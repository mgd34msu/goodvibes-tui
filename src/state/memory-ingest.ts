import type { MemoryAddOptions, ProvenanceLink } from './memory-store.ts';
import type { ForensicsBundle } from '@pellux/goodvibes-sdk/platform/runtime/forensics/types';
import type { PolicyPreflightReview } from '../runtime/permissions/preflight.ts';
import type { PluginStatus } from '../plugins/manager.ts';

export interface McpSecurityCapture {
  readonly name: string;
  readonly role: string;
  readonly trustMode: string;
  readonly connected: boolean;
  readonly allowedPaths: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly schemaFreshness: string;
  readonly quarantineReason?: string;
  readonly quarantineDetail?: string;
  readonly quarantineApprovedBy?: string;
}

export function buildIncidentMemoryAddOptions(bundle: ForensicsBundle): MemoryAddOptions {
  const provenance: ProvenanceLink[] = [];
  if (bundle.report.sessionId) provenance.push({ kind: 'session', ref: bundle.report.sessionId });
  if (bundle.report.turnId) provenance.push({ kind: 'turn', ref: bundle.report.turnId });
  if (bundle.report.taskId) provenance.push({ kind: 'task', ref: bundle.report.taskId });

  const details = [
    `classification=${bundle.report.classification}`,
    bundle.evidence.rootCause ? `rootCause=${bundle.evidence.rootCause}` : undefined,
    bundle.evidence.terminalPhase ? `terminalPhase=${bundle.evidence.terminalPhase}` : undefined,
    bundle.evidence.terminalOutcome ? `terminalOutcome=${bundle.evidence.terminalOutcome}` : undefined,
    `deniedPermissions=${bundle.evidence.deniedPermissionCount}`,
    `budgetBreaches=${bundle.evidence.budgetBreachCount}`,
    `replayMismatches=${bundle.replay.mismatchCount}`,
  ].filter((value): value is string => Boolean(value));

  const tags = [
    'forensics',
    bundle.report.classification,
    ...(bundle.report.stopReason ? [bundle.report.stopReason] : []),
    ...(bundle.evidence.slowPhases.length > 0 ? ['slow-phase'] : []),
  ];

  return {
    cls: 'incident',
    summary: bundle.report.summary,
    detail: details.join('\n'),
    tags,
    provenance,
    review: {
      state: 'fresh',
      confidence: 90,
    },
  };
}

export function buildPolicyPreflightMemoryAddOptions(review: PolicyPreflightReview): MemoryAddOptions {
  return {
    cls: review.status === 'pass' ? 'fact' : 'risk',
    summary: `Policy preflight: ${review.summary}`,
    detail: review.issues
      .map((issue) => `${issue.severity}:${issue.source}${issue.serverName ? `:${issue.serverName}` : ''} ${issue.message}`)
      .join('\n'),
    tags: [
      'security',
      'policy',
      'preflight',
      review.status,
    ],
    provenance: [],
    review: {
      state: 'fresh',
      confidence: review.status === 'pass' ? 80 : 75,
    },
  };
}

export function buildMcpSecurityMemoryAddOptions(server: McpSecurityCapture): MemoryAddOptions {
  const isRisk = server.schemaFreshness === 'quarantined' || server.trustMode === 'allow-all';
  return {
    cls: isRisk ? 'risk' : 'fact',
    summary: `MCP security posture: ${server.name} (${server.role}) ${server.trustMode}`,
    detail: [
      `connected=${server.connected}`,
      `schemaFreshness=${server.schemaFreshness}`,
      `allowedPaths=${server.allowedPaths.length > 0 ? server.allowedPaths.join(',') : 'unbounded'}`,
      `allowedHosts=${server.allowedHosts.length > 0 ? server.allowedHosts.join(',') : 'unbounded'}`,
      server.quarantineReason ? `quarantineReason=${server.quarantineReason}` : undefined,
      server.quarantineDetail ? `quarantineDetail=${server.quarantineDetail}` : undefined,
      server.quarantineApprovedBy ? `quarantineApprovedBy=${server.quarantineApprovedBy}` : undefined,
    ].filter((value): value is string => Boolean(value)).join('\n'),
    tags: [
      'security',
      'mcp',
      server.role,
      server.trustMode,
      server.schemaFreshness,
    ],
    provenance: [],
    review: {
      state: 'fresh',
      confidence: isRisk ? 65 : 75,
    },
  };
}

export function buildPluginSecurityMemoryAddOptions(
  plugin: PluginStatus,
  quarantineReason?: string,
): MemoryAddOptions {
  const isRisk = plugin.quarantined || plugin.trustTier === 'untrusted';
  return {
    cls: isRisk ? 'risk' : 'fact',
    summary: `Plugin security posture: ${plugin.name} ${plugin.trustTier}${plugin.quarantined ? ' quarantined' : ''}`,
    detail: [
      `enabled=${plugin.enabled}`,
      `active=${plugin.active}`,
      `trustTier=${plugin.trustTier}`,
      `quarantined=${plugin.quarantined}`,
      quarantineReason ? `quarantineReason=${quarantineReason}` : undefined,
    ].filter((value): value is string => Boolean(value)).join('\n'),
    tags: [
      'security',
      'plugin',
      plugin.trustTier,
      ...(plugin.quarantined ? ['quarantined'] : []),
    ],
    provenance: [],
    review: {
      state: 'fresh',
      confidence: isRisk ? 60 : 70,
    },
  };
}
