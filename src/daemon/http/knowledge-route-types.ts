export type AutomationScheduleDefinition = unknown;
export type KnowledgeProjectionTargetKind = 'overview' | 'bundle' | 'source' | 'node' | 'issue';
export type KnowledgeUsageKind = string;
export type KnowledgeCandidateStatus = string;
export type KnowledgeSourceType = string;
export type KnowledgePacketDetail = string;

export interface AuthenticatedPrincipalLike {
  readonly principalId: string;
  readonly principalKind: string;
  readonly admin: boolean;
  readonly scopes: readonly string[];
}

export interface KnowledgeGraphqlAccessLike {
  readonly requiredScopes: readonly string[];
  readonly adminRequired?: boolean;
}

export interface KnowledgeGraphqlResultLike {
  readonly data?: unknown;
  readonly errors?: readonly unknown[];
}

export interface KnowledgeGraphqlServiceLike {
  readonly schemaText: string;
  execute(input: {
    readonly query: string;
    readonly operationName?: string;
    readonly variables?: Record<string, unknown>;
    readonly admin: boolean;
    readonly scopes: readonly string[];
  }): Promise<KnowledgeGraphqlResultLike>;
}

export interface KnowledgeServiceLike {
  getStatus(): Promise<unknown>;
  listSources(limit: number): readonly unknown[];
  listNodes(limit: number): readonly unknown[];
  listIssues(limit: number): readonly unknown[];
  getItem(id: string): unknown | null;
  listConnectors(): readonly unknown[];
  getConnector(id: string): unknown | null;
  doctorConnector(id: string): Promise<unknown | null>;
  listProjectionTargets(limit: number): Promise<readonly unknown[]>;
  listExtractions(limit: number, sourceId?: string): readonly unknown[];
  listUsageRecords(
    limit: number,
    filter: { targetKind?: 'source' | 'node' | 'issue'; targetId?: string; usageKind?: KnowledgeUsageKind },
  ): readonly unknown[];
  listConsolidationCandidates(
    limit: number,
    filter: { status?: KnowledgeCandidateStatus; subjectKind?: 'source' | 'node' | 'issue'; subjectId?: string },
  ): readonly unknown[];
  getConsolidationCandidate(id: string): unknown | null;
  listConsolidationReports(limit: number): readonly unknown[];
  getConsolidationReport(id: string): unknown | null;
  getExtraction(id: string): unknown | null;
  getSourceExtraction(id: string): unknown | null;
  listJobs(): readonly unknown[];
  getJob(jobId: string): unknown | null;
  listJobRuns(limit: number, jobId?: string): readonly unknown[];
  listSchedules(limit: number): readonly unknown[];
  getSchedule(id: string): unknown | null;
  ingestUrl(input: Record<string, unknown>): Promise<unknown>;
  ingestArtifact(input: Record<string, unknown>): Promise<unknown>;
  importBookmarksFromFile(input: Record<string, unknown>): Promise<unknown>;
  importUrlsFromFile(input: Record<string, unknown>): Promise<unknown>;
  ingestConnectorInput(input: Record<string, unknown>): Promise<unknown>;
  search(query: string, limit: number): readonly unknown[];
  buildPacket(
    task: string,
    writeScope: readonly string[],
    limit: number,
    options: { detail?: KnowledgePacketDetail; budgetLimit?: number },
  ): Promise<unknown> | unknown;
  decideConsolidationCandidate(
    id: string,
    decision: 'accept' | 'reject' | 'supersede',
    input: Record<string, unknown>,
  ): Promise<unknown>;
  runJob(jobId: string, input: Record<string, unknown>): Promise<unknown>;
  lint(): Promise<readonly unknown[]>;
  reindex(): Promise<unknown>;
  saveSchedule(input: {
    readonly id?: string;
    readonly jobId: string;
    readonly schedule: AutomationScheduleDefinition;
    readonly label?: string;
    readonly enabled?: boolean;
    readonly metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  deleteSchedule(id: string): Promise<boolean>;
  setScheduleEnabled(id: string, enabled: boolean): Promise<unknown | null>;
  renderProjection(input: { kind: KnowledgeProjectionTargetKind; id?: string; limit?: number }): Promise<unknown>;
  materializeProjection(input: {
    kind: KnowledgeProjectionTargetKind;
    id?: string;
    limit?: number;
    filename?: string;
  }): Promise<unknown>;
}

export interface DaemonKnowledgeRouteContext {
  readonly configManager: { get(key: string): unknown };
  readonly inspectGraphqlAccess: (
    query: string,
    operationName?: string,
  ) => KnowledgeGraphqlAccessLike;
  readonly normalizeAtSchedule: (at: number) => AutomationScheduleDefinition;
  readonly normalizeCronSchedule: (
    expression: string,
    timezone?: string,
    staggerMs?: unknown,
  ) => AutomationScheduleDefinition;
  readonly normalizeEverySchedule: (
    interval: number | string,
    anchorAt?: number,
  ) => AutomationScheduleDefinition;
  readonly parseJsonBody: (req: Request) => Promise<Record<string, unknown> | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<Record<string, unknown> | null | Response>;
  readonly parseJsonText: (raw: string) => Record<string, unknown> | Response;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly resolveAuthenticatedPrincipal: (req: Request) => AuthenticatedPrincipalLike | null;
  readonly knowledgeService: KnowledgeServiceLike;
  readonly knowledgeGraphqlService: KnowledgeGraphqlServiceLike;
}
