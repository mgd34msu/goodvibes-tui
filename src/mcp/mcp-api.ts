import type { RegisteredTool } from './registry.ts';
import type { McpDecisionRecord, McpServerRole, McpTrustMode, QuarantineReason, SchemaFreshness } from '../runtime/mcp/types.ts';

export interface McpServerRecord {
  readonly name: string;
  readonly connected: boolean;
}

export interface McpServerSecurityRecord {
  readonly name: string;
  readonly connected: boolean;
  readonly role: McpServerRole;
  readonly trustMode: McpTrustMode;
  readonly allowedPaths: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly schemaFreshness: SchemaFreshness;
  readonly quarantineReason?: QuarantineReason;
  readonly quarantineDetail?: string;
  readonly quarantineApprovedBy?: string;
}

export interface McpSandboxBindingRecord {
  readonly name: string;
  readonly sessionId?: string;
  readonly profileId?: 'mcp-shared' | 'mcp-per-server';
  readonly state?: import('../runtime/sandbox/types.ts').SandboxSessionState;
  readonly backend?: import('../runtime/sandbox/types.ts').SandboxResolvedBackend | import('../runtime/sandbox/types.ts').SandboxVmBackend;
  readonly startupStatus?: 'verified' | 'planned' | 'failed';
}

export interface McpApi {
  listServerNames(): readonly string[];
  listServers(): readonly McpServerRecord[];
  listServerSecurity(): readonly McpServerSecurityRecord[];
  listSandboxBindings(): readonly McpSandboxBindingRecord[];
  listRecentSecurityDecisions(limit?: number): readonly McpDecisionRecord[];
  listAllTools(): Promise<readonly RegisteredTool[]>;
  setServerTrustMode(serverName: string, mode: McpTrustMode): void;
  setServerRole(serverName: string, role: McpServerRole): void;
  quarantineSchema(serverName: string, reason: QuarantineReason, detail?: string): void;
  approveSchemaQuarantine(serverName: string, operatorId: string): void;
}

export interface McpApiRegistry {
  readonly serverNames: readonly string[];
  listServers(): readonly McpServerRecord[];
  listServerSecurity(): readonly McpServerSecurityRecord[];
  listServerSandboxBindings(): readonly McpSandboxBindingRecord[];
  listRecentSecurityDecisions(limit?: number): readonly McpDecisionRecord[];
  listAllTools(): Promise<readonly RegisteredTool[]>;
  setServerTrustMode(serverName: string, mode: McpTrustMode): void;
  setServerRole(serverName: string, role: McpServerRole): void;
  quarantineSchema(serverName: string, reason: QuarantineReason, detail?: string): void;
  approveSchemaQuarantine(serverName: string, operatorId: string): void;
}

export function createMcpApi(registry: McpApiRegistry): McpApi {
  return {
    listServerNames(): readonly string[] {
      return registry.serverNames;
    },
    listServers(): readonly McpServerRecord[] {
      return registry.listServers();
    },
    listServerSecurity() {
      return registry.listServerSecurity();
    },
    listSandboxBindings() {
      return registry.listServerSandboxBindings();
    },
    listRecentSecurityDecisions(limit = 8) {
      return registry.listRecentSecurityDecisions(limit);
    },
    listAllTools() {
      return registry.listAllTools();
    },
    setServerTrustMode(serverName, mode) {
      registry.setServerTrustMode(serverName, mode);
    },
    setServerRole(serverName, role) {
      registry.setServerRole(serverName, role);
    },
    quarantineSchema(serverName, reason, detail) {
      registry.quarantineSchema(serverName, reason, detail);
    },
    approveSchemaQuarantine(serverName, operatorId) {
      registry.approveSchemaQuarantine(serverName, operatorId);
    },
  };
}
