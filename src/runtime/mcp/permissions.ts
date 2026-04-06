/**
 * MCP per-server permission and trust-level management.
 *
 * McpPermissionManager tracks trust levels and per-tool allow/deny overrides
 * for every registered MCP server.
 */
import type {
  McpTrustLevel,
  McpTrustMode,
  McpServerRole,
  McpCapabilityClass,
  McpAttackPathFinding,
  McpAttackPathReview,
  McpSecuritySnapshot,
  McpCoherenceAssessment,
  McpDecisionRecord,
  McpPermission,
  McpToolPermission,
  McpServerPermissions,
} from './types.ts';
import { logger } from '../../utils/logger.ts';

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Trust level assigned to newly registered servers. */
const DEFAULT_TRUST_LEVEL: McpTrustLevel = 'standard';
const DEFAULT_TRUST_MODE: McpTrustMode = 'ask-on-risk';
const DEFAULT_SERVER_ROLE: McpServerRole = 'general';
const MAX_DECISION_HISTORY = 50;

function modeFromLegacyTrust(level: McpTrustLevel): McpTrustMode {
  switch (level) {
    case 'trusted':
      return 'allow-all';
    case 'restricted':
      return 'constrained';
    case 'blocked':
      return 'blocked';
    case 'standard':
    default:
      return 'ask-on-risk';
  }
}

function riskForCapability(capability: McpCapabilityClass): import('./types.ts').McpRiskLevel {
  switch (capability) {
    case 'metadata':
    case 'generic':
      return 'low';
    case 'read_fs':
    case 'network_read':
      return 'medium';
    case 'write_fs':
    case 'exec':
    case 'network_write':
    case 'spawn_agent':
    case 'config_mutation':
      return 'high';
    case 'secret_read':
    case 'system_mutation':
      return 'critical';
  }
}

function inferCapability(toolName: string, args: Record<string, unknown>): McpCapabilityClass {
  const lower = toolName.toLowerCase();
  const path = typeof args['path'] === 'string' ? args['path'].toLowerCase() : '';
  const url = typeof args['url'] === 'string' ? args['url'].toLowerCase() : '';

  if (lower.includes('secret') || path.includes('.ssh') || path.includes('.env')) return 'secret_read';
  if (lower.includes('write') || lower.includes('edit') || lower.includes('save') || lower.includes('patch')) return 'write_fs';
  if (lower.includes('read') || lower.includes('list') || lower.includes('grep') || lower.includes('search')) return 'read_fs';
  if (lower.includes('exec') || lower.includes('shell') || lower.includes('run') || lower.includes('command')) return 'exec';
  if (lower.includes('spawn') || lower.includes('delegate') || lower.includes('agent')) return 'spawn_agent';
  if (lower.includes('config') || lower.includes('settings')) return 'config_mutation';
  if (lower.includes('git') && (lower.includes('commit') || lower.includes('push') || lower.includes('merge'))) return 'system_mutation';
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return lower.includes('post') || lower.includes('send') || lower.includes('submit')
      ? 'network_write'
      : 'network_read';
  }
  return 'generic';
}

function roleAllowsCapability(role: McpServerRole, capability: McpCapabilityClass): boolean {
  switch (role) {
    case 'docs':
      return capability === 'metadata' || capability === 'network_read' || capability === 'read_fs' || capability === 'generic';
    case 'filesystem':
      return capability === 'metadata' || capability === 'read_fs' || capability === 'write_fs' || capability === 'generic';
    case 'git':
      return capability === 'metadata' || capability === 'read_fs' || capability === 'write_fs' || capability === 'system_mutation' || capability === 'generic';
    case 'database':
      return capability === 'metadata' || capability === 'network_read' || capability === 'network_write' || capability === 'generic';
    case 'browser':
      return capability === 'metadata' || capability === 'network_read' || capability === 'network_write' || capability === 'generic';
    case 'automation':
      return capability !== 'secret_read';
    case 'ops':
    case 'remote':
    case 'general':
    default:
      return true;
  }
}

function pathInScope(allowedPaths: string[], args: Record<string, unknown>): boolean {
  if (allowedPaths.length === 0) return true;
  const raw = typeof args['path'] === 'string' ? args['path'] : typeof args['file'] === 'string' ? args['file'] : '';
  if (!raw) return true;
  return allowedPaths.some((prefix) => raw.startsWith(prefix));
}

function hostInScope(allowedHosts: string[], args: Record<string, unknown>): boolean {
  if (allowedHosts.length === 0) return true;
  const raw = typeof args['url'] === 'string' ? args['url'] : '';
  if (!raw) return true;
  try {
    const host = new URL(raw).hostname;
    return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

function scopeLabel(items: readonly string[]): string {
  if (items.length === 0) return 'unbounded';
  if (items.length === 1) return items[0]!;
  return `${items.length} scopes`;
}

function severityForPosture(
  trustMode: McpTrustMode,
  schemaFreshness: import('./types.ts').SchemaFreshness,
  allowedPaths: readonly string[],
  allowedHosts: readonly string[],
): import('./types.ts').McpRiskLevel {
  if (schemaFreshness === 'quarantined' || trustMode === 'blocked') return 'critical';
  if (trustMode === 'allow-all') {
    if (allowedPaths.length === 0 || allowedHosts.length === 0) return 'critical';
    return 'high';
  }
  if (trustMode === 'ask-on-risk') {
    if (allowedPaths.length === 0 || allowedHosts.length === 0) return 'high';
    return 'medium';
  }
  if (allowedPaths.length === 0 || allowedHosts.length === 0) return 'medium';
  return 'low';
}

function verdictForPosture(
  trustMode: McpTrustMode,
  schemaFreshness: import('./types.ts').SchemaFreshness,
): import('./types.ts').McpCoherenceVerdict {
  if (schemaFreshness === 'quarantined' || trustMode === 'blocked') return 'deny';
  if (trustMode === 'allow-all') return 'allow';
  if (trustMode === 'ask-on-risk') return 'ask';
  return 'allow';
}

function reasonForPosture(
  serverName: string,
  role: McpServerRole,
  trustMode: McpTrustMode,
  schemaFreshness: import('./types.ts').SchemaFreshness,
  allowedPaths: readonly string[],
  allowedHosts: readonly string[],
  quarantineReason?: import('./types.ts').QuarantineReason,
  quarantineDetail?: string,
): string {
  if (schemaFreshness === 'quarantined') {
    return `schema for server '${serverName}' is quarantined${quarantineReason ? ` (${quarantineReason})` : ''}${quarantineDetail ? `: ${quarantineDetail}` : ''}`;
  }
  if (trustMode === 'blocked') {
    return `server '${serverName}' is blocked`;
  }
  if (trustMode === 'allow-all' && (allowedPaths.length === 0 || allowedHosts.length === 0)) {
    return `server '${serverName}' exposes an unbounded attack surface for ${role}`;
  }
  if (trustMode === 'allow-all') {
    return `server '${serverName}' is elevated to allow-all`;
  }
  if (trustMode === 'ask-on-risk' && (allowedPaths.length === 0 || allowedHosts.length === 0)) {
    return `server '${serverName}' requires approval and still exposes broad scope`;
  }
  if (trustMode === 'ask-on-risk') {
    return `server '${serverName}' requires approval for risky actions`;
  }
  if (allowedPaths.length === 0 || allowedHosts.length === 0) {
    return `server '${serverName}' is constrained but still has an open scope boundary`;
  }
  return `server '${serverName}' is constrained and scoped`;
}

function postureRoute(
  serverName: string,
  role: McpServerRole,
  trustMode: McpTrustMode,
  allowedPaths: readonly string[],
  allowedHosts: readonly string[],
  schemaFreshness: import('./types.ts').SchemaFreshness,
): string {
  return `${serverName} -> role:${role} -> trust:${trustMode} -> paths:${scopeLabel(allowedPaths)} -> hosts:${scopeLabel(allowedHosts)} -> schema:${schemaFreshness}`;
}

function sortFindings(a: McpAttackPathFinding, b: McpAttackPathFinding): number {
  const severityRank: Record<import('./types.ts').McpRiskLevel, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  const severityDelta = severityRank[b.severity] - severityRank[a.severity];
  if (severityDelta !== 0) return severityDelta;
  if (a.kind !== b.kind) return a.kind === 'server-posture' ? -1 : 1;
  return a.serverName.localeCompare(b.serverName);
}

// ── Manager ───────────────────────────────────────────────────────────────────

/**
 * Manages per-server permission state.
 *
 * Lifecycle:
 *   1. `registerServer(name)` — called when a server transitions to configured/connecting.
 *   2. `setTrustLevel(name, level)` — adjust trust at runtime.
 *   3. `allowTool(name, tool)` / `denyTool(name, tool)` — explicit overrides.
 *   4. `isToolAllowed(name, tool)` — checked before every tool invocation.
 *   5. `removeServer(name)` — called on permanent disconnection.
 */
export class McpPermissionManager {
  private readonly permissions = new Map<string, McpServerPermissions>();
  private readonly recentDecisions: McpDecisionRecord[] = [];

  // ── Registration ─────────────────────────────────────────────────────────

  /**
   * Register a new server with default trust level `standard`.
   * Idempotent — calling again for an already-registered server is a no-op.
   *
   * @param serverName - Server identifier
   * @param trustLevel - Initial trust level (defaults to `standard`)
   */
  registerServer(
    serverName: string,
    trustLevel: McpTrustLevel = DEFAULT_TRUST_LEVEL,
    profile?: Partial<McpServerPermissions['profile']>,
  ): void {
    if (this.permissions.has(serverName)) return;
    this.permissions.set(serverName, {
      serverName,
      trustLevel,
      profile: {
        serverName,
        role: profile?.role ?? DEFAULT_SERVER_ROLE,
        mode: profile?.mode ?? modeFromLegacyTrust(trustLevel),
        allowedPaths: profile?.allowedPaths ?? [],
        allowedHosts: profile?.allowedHosts ?? [],
        allowedCapabilities: profile?.allowedCapabilities ?? [],
        ...(profile?.notes ? { notes: profile.notes } : {}),
        lastModifiedAt: Date.now(),
      },
      toolOverrides: new Map(),
      lastModifiedAt: Date.now(),
    });
    logger.debug('McpPermissionManager: server registered', { serverName, trustLevel });
  }

  /**
   * Remove all permission state for a server.
   *
   * @param serverName - Server identifier
   */
  removeServer(serverName: string): void {
    if (this.permissions.delete(serverName)) {
      logger.debug('McpPermissionManager: server removed', { serverName });
    }
  }

  // ── Trust level ───────────────────────────────────────────────────────────

  /**
   * Update the trust level for a registered server.
   *
   * @param serverName - Server identifier
   * @param level      - New trust level
   * @throws {Error} If the server is not registered
   */
  setTrustLevel(serverName: string, level: McpTrustLevel): void {
    const record = this._getRequired(serverName);
    record.trustLevel = level;
    record.lastModifiedAt = Date.now();
    logger.debug('McpPermissionManager: trust level updated', { serverName, level });
  }

  /**
   * Return the current trust level for a server, or `null` if not registered.
   *
   * @param serverName - Server identifier
   */
  getTrustLevel(serverName: string): McpTrustLevel | null {
    return this.permissions.get(serverName)?.trustLevel ?? null;
  }

  setTrustMode(serverName: string, mode: McpTrustMode): void {
    const record = this._getRequired(serverName);
    record.profile.mode = mode;
    record.lastModifiedAt = Date.now();
    record.profile.lastModifiedAt = record.lastModifiedAt;
  }

  getTrustMode(serverName: string): McpTrustMode | null {
    return this.permissions.get(serverName)?.profile.mode ?? null;
  }

  setServerRole(serverName: string, role: McpServerRole): void {
    const record = this._getRequired(serverName);
    record.profile.role = role;
    record.lastModifiedAt = Date.now();
    record.profile.lastModifiedAt = record.lastModifiedAt;
  }

  listProfiles(): Array<McpServerPermissions['profile']> {
    return Array.from(this.permissions.values()).map((record) => ({ ...record.profile }));
  }

  // ── Tool overrides ────────────────────────────────────────────────────────

  /**
   * Explicitly allow a tool on a server, overriding any deny.
   *
   * @param serverName - Server identifier
   * @param toolName   - Tool name on the server (not qualified)
   * @param note       - Optional reason for the override
   * @throws {Error} If the server is not registered
   */
  allowTool(serverName: string, toolName: string, note?: string): void {
    const record = this._getRequired(serverName);
    record.toolOverrides.set(toolName, { toolName, verdict: 'allow', note });
    record.lastModifiedAt = Date.now();
    logger.debug('McpPermissionManager: tool allowed', { serverName, toolName });
  }

  /**
   * Explicitly deny a tool on a server, overriding trust-level default.
   *
   * @param serverName - Server identifier
   * @param toolName   - Tool name on the server (not qualified)
   * @param note       - Optional reason for the denial
   * @throws {Error} If the server is not registered
   */
  denyTool(serverName: string, toolName: string, note?: string): void {
    const record = this._getRequired(serverName);
    record.toolOverrides.set(toolName, { toolName, verdict: 'deny', note });
    record.lastModifiedAt = Date.now();
    logger.debug('McpPermissionManager: tool denied', { serverName, toolName });
  }

  /**
   * Remove a per-tool override, reverting to the trust-level default.
   *
   * @param serverName - Server identifier
   * @param toolName   - Tool name on the server
   */
  clearToolOverride(serverName: string, toolName: string): void {
    const record = this.permissions.get(serverName);
    if (record?.toolOverrides.delete(toolName)) {
      record.lastModifiedAt = Date.now();
      logger.debug('McpPermissionManager: tool override cleared', { serverName, toolName });
    }
  }

  // ── Permission check ──────────────────────────────────────────────────────

  /**
   * Determine whether a tool call is permitted for the given server.
   *
   * Resolution order:
   *   1. Server not registered → deny
   *   2. Trust level `blocked`  → deny
   *   3. Per-tool override exists → honour override
   *   4. Trust level `restricted` with no allow override → deny
   *   5. Trust level `standard` or `trusted` → allow
   *
   * @param serverName - Server identifier
   * @param toolName   - Tool name on the server (not qualified)
   */
  isToolAllowed(serverName: string, toolName: string): McpPermission {
    const record = this.permissions.get(serverName);

    if (!record) {
      return { allowed: false, reason: `server '${serverName}' is not registered` };
    }

    if (record.trustLevel === 'blocked') {
      return { allowed: false, reason: `server '${serverName}' is blocked`, verdict: 'deny', profileMode: record.profile.mode };
    }

    const override = record.toolOverrides.get(toolName);
    if (override) {
      const allowed = override.verdict === 'allow';
      return {
        allowed,
        reason: allowed
          ? `tool '${toolName}' explicitly allowed${override.note ? ': ' + override.note : ''}`
          : `tool '${toolName}' explicitly denied${override.note ? ': ' + override.note : ''}`,
        verdict: allowed ? 'allow' : 'deny',
        profileMode: record.profile.mode,
      };
    }

    if (record.trustLevel === 'restricted') {
      return {
        allowed: false,
        reason: `tool '${toolName}' not in allow-list for restricted server '${serverName}'`,
        verdict: 'deny',
        profileMode: record.profile.mode,
      };
    }

    // standard or trusted — allow
    return { allowed: true, reason: `trust level '${record.trustLevel}'`, verdict: 'allow', profileMode: record.profile.mode };
  }

  evaluateToolCall(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): McpPermission {
    const record = this.permissions.get(serverName);
    if (!record) {
      return { allowed: false, reason: `server '${serverName}' is not registered`, verdict: 'deny' };
    }
    if (record.profile.mode === 'blocked') {
      return { allowed: false, reason: `server '${serverName}' is blocked`, verdict: 'deny', profileMode: record.profile.mode };
    }

    const override = record.toolOverrides.get(toolName);
    if (override) {
      const allow = override.verdict === 'allow';
      return {
        allowed: allow,
        reason: allow ? `tool '${toolName}' explicitly allowed` : `tool '${toolName}' explicitly denied`,
        verdict: allow ? 'allow' : 'deny',
        profileMode: record.profile.mode,
      };
    }

    const capability = inferCapability(toolName, args);
    const riskLevel = riskForCapability(capability);
    const capabilityAllowed = record.profile.allowedCapabilities.length === 0 || record.profile.allowedCapabilities.includes(capability);
    const coherentRole = roleAllowsCapability(record.profile.role, capability);
    const pathScoped = pathInScope(record.profile.allowedPaths, args);
    const hostScoped = hostInScope(record.profile.allowedHosts, args);
    const incoherent = !coherentRole || !capabilityAllowed || !pathScoped || !hostScoped;

    let assessment: McpCoherenceAssessment;
    if (record.profile.mode === 'allow-all') {
      assessment = {
        verdict: 'allow',
        riskLevel,
        capability,
        incoherent,
        reason: incoherent
          ? `server '${serverName}' is elevated to allow-all; request bypassed coherence concerns`
          : `server '${serverName}' is elevated to allow-all`,
      };
    } else if (record.profile.mode === 'constrained') {
      if (incoherent || riskLevel === 'high' || riskLevel === 'critical') {
        assessment = {
          verdict: 'deny',
          riskLevel,
          capability,
          incoherent,
          reason: incoherent
            ? `request is incoherent for ${record.profile.role} server '${serverName}'`
            : `capability '${capability}' exceeds constrained trust for server '${serverName}'`,
        };
      } else if (riskLevel === 'medium') {
        assessment = {
          verdict: 'ask',
          riskLevel,
          capability,
          incoherent,
          reason: `capability '${capability}' requires approval in constrained mode`,
        };
      } else {
        assessment = {
          verdict: 'allow',
          riskLevel,
          capability,
          incoherent,
          reason: `capability '${capability}' allowed in constrained mode`,
        };
      }
    } else {
      if (incoherent && (riskLevel === 'high' || riskLevel === 'critical')) {
        assessment = {
          verdict: 'deny',
          riskLevel,
          capability,
          incoherent,
          reason: `request is incoherent for ${record.profile.role} server '${serverName}'`,
        };
      } else if (incoherent || riskLevel === 'high' || riskLevel === 'critical') {
        assessment = {
          verdict: 'ask',
          riskLevel,
          capability,
          incoherent,
          reason: incoherent
            ? `request exceeds the normal envelope for ${record.profile.role} server '${serverName}'`
            : `capability '${capability}' requires approval`,
        };
      } else {
        assessment = {
          verdict: 'allow',
          riskLevel,
          capability,
          incoherent,
          reason: `capability '${capability}' allowed for ${record.profile.role} server '${serverName}'`,
        };
      }
    }

    const permission = {
      allowed: assessment.verdict === 'allow',
      reason: assessment.reason,
      verdict: assessment.verdict,
      riskLevel: assessment.riskLevel,
      capability: assessment.capability,
      incoherent: assessment.incoherent,
      profileMode: record.profile.mode,
    };
    this._recordDecision({
      serverName,
      toolName,
      verdict: assessment.verdict,
      riskLevel: assessment.riskLevel,
      capability: assessment.capability,
      incoherent: assessment.incoherent,
      reason: assessment.reason,
      profileMode: record.profile.mode,
      evaluatedAt: Date.now(),
    });
    return permission;
  }

  // ── Inspection ────────────────────────────────────────────────────────────

  /**
   * Return a snapshot of permission state for a server, or `null` if not registered.
   *
   * @param serverName - Server identifier
   */
  getServerPermissions(serverName: string): McpServerPermissions | null {
    return this.permissions.get(serverName) ?? null;
  }

  listRecentDecisions(limit = 10): McpDecisionRecord[] {
    return this.recentDecisions.slice(0, Math.max(0, limit));
  }

  buildAttackPathReview(servers: readonly McpSecuritySnapshot[], recentDecisions: readonly McpDecisionRecord[] = []): McpAttackPathReview {
    return buildMcpAttackPathReview({ servers, recentDecisions });
  }

  /** All registered server names. */
  get serverNames(): string[] {
    return Array.from(this.permissions.keys());
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _getRequired(serverName: string): McpServerPermissions {
    const record = this.permissions.get(serverName);
    if (!record) {
      throw new Error(`McpPermissionManager: server '${serverName}' is not registered`);
    }
    return record;
  }

  private _recordDecision(record: McpDecisionRecord): void {
    this.recentDecisions.unshift(record);
    if (this.recentDecisions.length > MAX_DECISION_HISTORY) {
      this.recentDecisions.length = MAX_DECISION_HISTORY;
    }
  }
}

export function buildMcpAttackPathReview(params: {
  servers: readonly McpSecuritySnapshot[];
  recentDecisions?: readonly McpDecisionRecord[];
}): McpAttackPathReview {
  const findings: McpAttackPathFinding[] = [];
  let allowAllServers = 0;
  let askOnRiskServers = 0;
  let constrainedServers = 0;
  let blockedServers = 0;
  let quarantinedServers = 0;

  for (const server of params.servers) {
    if (server.trustMode === 'allow-all') allowAllServers += 1;
    else if (server.trustMode === 'ask-on-risk') askOnRiskServers += 1;
    else if (server.trustMode === 'constrained') constrainedServers += 1;
    else if (server.trustMode === 'blocked') blockedServers += 1;

    if (server.schemaFreshness === 'quarantined') quarantinedServers += 1;

    const severity = severityForPosture(server.trustMode, server.schemaFreshness, server.allowedPaths, server.allowedHosts);
    const verdict = verdictForPosture(server.trustMode, server.schemaFreshness);
    const incoherent = server.schemaFreshness === 'quarantined'
      || server.trustMode === 'allow-all'
      || server.allowedPaths.length === 0
      || server.allowedHosts.length === 0;
    findings.push({
      kind: 'server-posture',
      serverName: server.name,
      route: postureRoute(server.name, server.role, server.trustMode, server.allowedPaths, server.allowedHosts, server.schemaFreshness),
      verdict,
      severity,
      incoherent,
      reason: reasonForPosture(
        server.name,
        server.role,
        server.trustMode,
        server.schemaFreshness,
        server.allowedPaths,
        server.allowedHosts,
        server.quarantineReason,
        server.quarantineDetail,
      ),
      evidence: [
        `role=${server.role}`,
        `trustMode=${server.trustMode}`,
        `paths=${scopeLabel(server.allowedPaths)}`,
        `hosts=${scopeLabel(server.allowedHosts)}`,
        `schema=${server.schemaFreshness}`,
        ...(server.quarantineReason ? [`quarantine=${server.quarantineReason}`] : []),
        ...(server.quarantineDetail ? [`detail=${server.quarantineDetail}`] : []),
        ...(server.connected !== undefined ? [`connected=${server.connected}`] : []),
      ],
    });
  }

  let incoherentFindings = 0;
  for (const decision of params.recentDecisions ?? []) {
    const finding: McpAttackPathFinding = {
      kind: 'recent-decision',
      serverName: decision.serverName,
      toolName: decision.toolName,
      capability: decision.capability,
      evaluatedAt: decision.evaluatedAt,
      route: `${decision.serverName}:${decision.toolName} -> ${decision.capability} -> ${decision.profileMode}`,
      verdict: decision.verdict,
      severity: decision.riskLevel,
      incoherent: decision.incoherent,
      reason: decision.reason,
      evidence: [
        `capability=${decision.capability}`,
        `risk=${decision.riskLevel}`,
        `verdict=${decision.verdict}`,
        `mode=${decision.profileMode}`,
        `incoherent=${decision.incoherent}`,
      ],
    };
    if (decision.incoherent) incoherentFindings += 1;
    findings.push(finding);
  }

  findings.sort(sortFindings);
  const criticalFindings = findings.filter((finding) => finding.severity === 'high' || finding.severity === 'critical').length;
  const summary = findings.length === 0
    ? 'No MCP attack-path findings yet.'
    : `${criticalFindings} high-risk findings across ${params.servers.length} servers${incoherentFindings > 0 ? `, including ${incoherentFindings} incoherent decision${incoherentFindings === 1 ? '' : 's'}` : ''}.`;

  return {
    reviewedAt: Date.now(),
    totalServers: params.servers.length,
    connectedServers: params.servers.filter((server) => server.connected).length,
    allowAllServers,
    askOnRiskServers,
    constrainedServers,
    blockedServers,
    quarantinedServers,
    incoherentFindings,
    criticalFindings,
    findings,
    summary,
  };
}
