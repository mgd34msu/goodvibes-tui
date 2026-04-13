import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  entityOutputSchema,
  listOutputSchema,
  objectSchema,
} from './method-catalog-shared.ts';
import {
  ARTIFACT_DESCRIPTOR_SCHEMA,
  GENERIC_LIST_SCHEMA,
  GRAPHQL_RESPONSE_DATA_SCHEMA,
  GRAPHQL_RESPONSE_EXTENSIONS_SCHEMA,
  JSON_RECORD_SCHEMA,
  JSON_SCHEMA_DOCUMENT_SCHEMA,
  JSON_VALUE_SCHEMA,
  METADATA_SCHEMA,
  STRING_LIST_SCHEMA,
  enumSchema,
  nullableSchema,
  recordSchema,
} from './operator-contract-schemas-shared.ts';

export const KNOWLEDGE_INJECTION_TRUST_TIER_SCHEMA = enumSchema(['reviewed', 'fresh', 'stale']);
export const KNOWLEDGE_INJECTION_USE_AS_SCHEMA = enumSchema(['reference-material']);
export const KNOWLEDGE_INJECTION_RETENTION_SCHEMA = enumSchema(['task-only']);
export const KNOWLEDGE_INJECTION_INGEST_MODE_SCHEMA = enumSchema(['keyword-ranked', 'semantic-ranked', 'hybrid-ranked']);
export const KNOWLEDGE_SOURCE_TYPE_SCHEMA = enumSchema([
  'url',
  'bookmark',
  'bookmark-list',
  'document',
  'repo',
  'dataset',
  'image',
  'manual',
  'other',
]);
export const KNOWLEDGE_PACKET_DETAIL_SCHEMA = enumSchema(['compact', 'standard', 'detailed']);
export const KNOWLEDGE_JOB_MODE_SCHEMA = enumSchema(['inline', 'background']);
export const KNOWLEDGE_JOB_STATUS_SCHEMA = enumSchema(['queued', 'running', 'completed', 'failed']);
export const KNOWLEDGE_JOB_KIND_SCHEMA = enumSchema([
  'lint',
  'reindex',
  'refresh-stale',
  'refresh-bookmarks',
  'rebuild-projections',
  'light-consolidation',
  'deep-consolidation',
]);
export const KNOWLEDGE_CONSOLIDATION_DECISION_SCHEMA = enumSchema(['accept', 'reject', 'supersede']);
export const KNOWLEDGE_CONNECTOR_SETUP_FIELD_KIND_SCHEMA = enumSchema(['text', 'path', 'uri', 'secret', 'token', 'choice']);
export const KNOWLEDGE_CONNECTOR_SETUP_FIELD_SOURCE_SCHEMA = enumSchema([
  'inline',
  'env',
  'goodvibes',
  'bitwarden',
  'vaultwarden',
  'bws',
  'manual',
]);
export const KNOWLEDGE_CONNECTOR_DOCTOR_STATUS_SCHEMA = enumSchema(['pass', 'warn', 'fail']);

const KNOWLEDGE_EMPTY_OBJECT_SCHEMA = objectSchema({}, [], { additionalProperties: false });
const KNOWLEDGE_AT_SCHEDULE_SCHEMA = objectSchema({
  kind: enumSchema(['at']),
  at: NUMBER_SCHEMA,
}, ['kind', 'at'], { additionalProperties: false });
const KNOWLEDGE_EVERY_SCHEDULE_SCHEMA = objectSchema({
  kind: enumSchema(['every']),
  intervalMs: NUMBER_SCHEMA,
  anchorAt: NUMBER_SCHEMA,
}, ['kind', 'intervalMs'], { additionalProperties: false });
const KNOWLEDGE_EVERY_SCHEDULE_INPUT_INTERVAL_MS_SCHEMA = KNOWLEDGE_EVERY_SCHEDULE_SCHEMA;
const KNOWLEDGE_EVERY_SCHEDULE_INPUT_INTERVAL_TEXT_SCHEMA = objectSchema({
  kind: enumSchema(['every']),
  interval: STRING_SCHEMA,
  anchorAt: NUMBER_SCHEMA,
}, ['kind', 'interval'], { additionalProperties: false });
const KNOWLEDGE_CRON_SCHEDULE_SCHEMA = objectSchema({
  kind: enumSchema(['cron']),
  expression: STRING_SCHEMA,
  timezone: STRING_SCHEMA,
  staggerMs: NUMBER_SCHEMA,
}, ['kind', 'expression'], { additionalProperties: false });
export const KNOWLEDGE_SCHEDULE_DEFINITION_SCHEMA = {
  anyOf: [
    KNOWLEDGE_AT_SCHEDULE_SCHEMA,
    KNOWLEDGE_EVERY_SCHEDULE_SCHEMA,
    KNOWLEDGE_CRON_SCHEDULE_SCHEMA,
  ],
} as const;
export const KNOWLEDGE_SCHEDULE_INPUT_SCHEMA = {
  anyOf: [
    KNOWLEDGE_AT_SCHEDULE_SCHEMA,
    KNOWLEDGE_EVERY_SCHEDULE_INPUT_INTERVAL_MS_SCHEMA,
    KNOWLEDGE_EVERY_SCHEDULE_INPUT_INTERVAL_TEXT_SCHEMA,
    KNOWLEDGE_CRON_SCHEDULE_SCHEMA,
  ],
} as const;

const KNOWLEDGE_JOB_RUN_PROJECTION_SCHEMA = objectSchema({
  targetId: STRING_SCHEMA,
  artifactId: STRING_SCHEMA,
}, ['targetId', 'artifactId'], { additionalProperties: false });
const KNOWLEDGE_JOB_RUN_ISSUE_COUNT_RESULT_SCHEMA = objectSchema({
  issueCount: NUMBER_SCHEMA,
}, ['issueCount'], { additionalProperties: false });
const KNOWLEDGE_JOB_RUN_REINDEX_RESULT_SCHEMA = objectSchema({
  sourceCount: NUMBER_SCHEMA,
  issueCount: NUMBER_SCHEMA,
}, ['sourceCount', 'issueCount'], { additionalProperties: false });
const KNOWLEDGE_JOB_RUN_REFRESH_RESULT_SCHEMA = objectSchema({
  refreshed: NUMBER_SCHEMA,
}, ['refreshed'], { additionalProperties: false });
const KNOWLEDGE_JOB_RUN_PROJECTIONS_RESULT_SCHEMA = objectSchema({
  projections: arraySchema(KNOWLEDGE_JOB_RUN_PROJECTION_SCHEMA),
}, ['projections'], { additionalProperties: false });
const KNOWLEDGE_JOB_RUN_CONSOLIDATION_RESULT_SCHEMA = objectSchema({
  reportId: STRING_SCHEMA,
  metrics: recordSchema(NUMBER_SCHEMA),
}, ['reportId', 'metrics'], { additionalProperties: false });
export const KNOWLEDGE_JOB_RUN_RESULT_SCHEMA = {
  anyOf: [
    KNOWLEDGE_EMPTY_OBJECT_SCHEMA,
    KNOWLEDGE_JOB_RUN_ISSUE_COUNT_RESULT_SCHEMA,
    KNOWLEDGE_JOB_RUN_REINDEX_RESULT_SCHEMA,
    KNOWLEDGE_JOB_RUN_REFRESH_RESULT_SCHEMA,
    KNOWLEDGE_JOB_RUN_PROJECTIONS_RESULT_SCHEMA,
    KNOWLEDGE_JOB_RUN_CONSOLIDATION_RESULT_SCHEMA,
  ],
} as const;
export const KNOWLEDGE_JOB_RUN_REQUEST_SCHEMA = objectSchema({
  mode: KNOWLEDGE_JOB_MODE_SCHEMA,
  sourceIds: STRING_LIST_SCHEMA,
  limit: NUMBER_SCHEMA,
}, [], { additionalProperties: false });
export const KNOWLEDGE_CONNECTOR_INGEST_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    connectorId: STRING_SCHEMA,
    input: JSON_VALUE_SCHEMA,
    content: STRING_SCHEMA,
    path: STRING_SCHEMA,
    sessionId: STRING_SCHEMA,
    allowPrivateHosts: BOOLEAN_SCHEMA,
  },
  required: ['connectorId'],
  anyOf: [
    { required: ['input'] },
    { required: ['content'] },
    { required: ['path'] },
  ],
  additionalProperties: false,
} as const;
export const KNOWLEDGE_INJECTION_PROVENANCE_SCHEMA = objectSchema({
  source: enumSchema(['project-memory']),
  links: arraySchema(objectSchema({
    kind: STRING_SCHEMA,
    ref: STRING_SCHEMA,
    label: STRING_SCHEMA,
  }, ['kind', 'ref'], { additionalProperties: false })),
}, ['source', 'links'], { additionalProperties: false });
export const KNOWLEDGE_INJECTION_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  cls: STRING_SCHEMA,
  summary: STRING_SCHEMA,
  reason: STRING_SCHEMA,
  confidence: NUMBER_SCHEMA,
  reviewState: STRING_SCHEMA,
  trustTier: KNOWLEDGE_INJECTION_TRUST_TIER_SCHEMA,
  useAs: KNOWLEDGE_INJECTION_USE_AS_SCHEMA,
  retention: KNOWLEDGE_INJECTION_RETENTION_SCHEMA,
  provenance: KNOWLEDGE_INJECTION_PROVENANCE_SCHEMA,
  ingestMode: KNOWLEDGE_INJECTION_INGEST_MODE_SCHEMA,
}, ['id', 'cls', 'summary', 'reason', 'confidence', 'reviewState', 'trustTier', 'useAs', 'retention', 'provenance', 'ingestMode'], { additionalProperties: false });
export const KNOWLEDGE_INJECTION_PROMPT_SCHEMA = objectSchema({
  injections: arraySchema(KNOWLEDGE_INJECTION_SCHEMA),
  prompt: nullableSchema(STRING_SCHEMA),
}, ['injections'], { additionalProperties: true });

const KNOWLEDGE_SOURCE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  connectorId: STRING_SCHEMA,
  sourceType: KNOWLEDGE_SOURCE_TYPE_SCHEMA,
  title: STRING_SCHEMA,
  sourceUri: STRING_SCHEMA,
  canonicalUri: STRING_SCHEMA,
  summary: STRING_SCHEMA,
  description: STRING_SCHEMA,
  tags: STRING_LIST_SCHEMA,
  folderPath: STRING_SCHEMA,
  status: STRING_SCHEMA,
  artifactId: STRING_SCHEMA,
  contentHash: STRING_SCHEMA,
  lastCrawledAt: NUMBER_SCHEMA,
  crawlError: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
}, ['id', 'connectorId', 'sourceType', 'tags', 'status', 'metadata', 'createdAt', 'updatedAt'], { additionalProperties: true });

const KNOWLEDGE_NODE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  slug: STRING_SCHEMA,
  title: STRING_SCHEMA,
  summary: STRING_SCHEMA,
  aliases: STRING_LIST_SCHEMA,
  status: STRING_SCHEMA,
  confidence: NUMBER_SCHEMA,
  sourceId: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
}, ['id', 'kind', 'slug', 'title', 'aliases', 'status', 'confidence', 'metadata', 'createdAt', 'updatedAt'], { additionalProperties: true });

const KNOWLEDGE_ISSUE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  severity: STRING_SCHEMA,
  code: STRING_SCHEMA,
  message: STRING_SCHEMA,
  status: STRING_SCHEMA,
  sourceId: STRING_SCHEMA,
  nodeId: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
}, ['id', 'severity', 'code', 'message', 'status', 'metadata', 'createdAt', 'updatedAt'], { additionalProperties: true });

const KNOWLEDGE_EDGE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  fromKind: STRING_SCHEMA,
  fromId: STRING_SCHEMA,
  toKind: STRING_SCHEMA,
  toId: STRING_SCHEMA,
  relation: STRING_SCHEMA,
  weight: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
}, ['id', 'fromKind', 'fromId', 'toKind', 'toId', 'relation', 'weight', 'metadata', 'createdAt', 'updatedAt'], { additionalProperties: true });

const KNOWLEDGE_EXTRACTION_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  sourceId: STRING_SCHEMA,
  artifactId: STRING_SCHEMA,
  extractorId: STRING_SCHEMA,
  format: STRING_SCHEMA,
  title: STRING_SCHEMA,
  summary: STRING_SCHEMA,
  excerpt: STRING_SCHEMA,
  sections: STRING_LIST_SCHEMA,
  links: STRING_LIST_SCHEMA,
  estimatedTokens: NUMBER_SCHEMA,
  structure: JSON_RECORD_SCHEMA,
  metadata: METADATA_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
}, ['id', 'sourceId', 'extractorId', 'format', 'sections', 'links', 'estimatedTokens', 'structure', 'metadata', 'createdAt', 'updatedAt'], { additionalProperties: true });

export const KNOWLEDGE_STATUS_SCHEMA = objectSchema({
  ready: BOOLEAN_SCHEMA,
  storagePath: STRING_SCHEMA,
  sourceCount: NUMBER_SCHEMA,
  nodeCount: NUMBER_SCHEMA,
  edgeCount: NUMBER_SCHEMA,
  issueCount: NUMBER_SCHEMA,
  extractionCount: NUMBER_SCHEMA,
  jobRunCount: NUMBER_SCHEMA,
  usageCount: NUMBER_SCHEMA,
  candidateCount: NUMBER_SCHEMA,
  reportCount: NUMBER_SCHEMA,
  scheduleCount: NUMBER_SCHEMA,
}, ['ready', 'storagePath', 'sourceCount', 'nodeCount', 'edgeCount', 'issueCount', 'extractionCount', 'jobRunCount', 'usageCount', 'candidateCount', 'reportCount', 'scheduleCount']);

export const KNOWLEDGE_ITEM_VIEW_SCHEMA = objectSchema({
  source: KNOWLEDGE_SOURCE_SCHEMA,
  node: KNOWLEDGE_NODE_SCHEMA,
  issue: KNOWLEDGE_ISSUE_SCHEMA,
  relatedEdges: arraySchema(KNOWLEDGE_EDGE_SCHEMA),
  linkedSources: arraySchema(KNOWLEDGE_SOURCE_SCHEMA),
  linkedNodes: arraySchema(KNOWLEDGE_NODE_SCHEMA),
}, [], { additionalProperties: true });

const KNOWLEDGE_CONNECTOR_FIELD_SCHEMA = objectSchema({
  key: STRING_SCHEMA,
  label: STRING_SCHEMA,
  kind: KNOWLEDGE_CONNECTOR_SETUP_FIELD_KIND_SCHEMA,
  optional: BOOLEAN_SCHEMA,
  source: KNOWLEDGE_CONNECTOR_SETUP_FIELD_SOURCE_SCHEMA,
  description: STRING_SCHEMA,
}, ['key', 'label', 'kind'], { additionalProperties: true });

const KNOWLEDGE_CONNECTOR_SETUP_SCHEMA = objectSchema({
  version: STRING_SCHEMA,
  summary: STRING_SCHEMA,
  transportHints: STRING_LIST_SCHEMA,
  steps: STRING_LIST_SCHEMA,
  fields: arraySchema(KNOWLEDGE_CONNECTOR_FIELD_SCHEMA),
  metadata: METADATA_SCHEMA,
}, ['version', 'summary'], { additionalProperties: true });

export const KNOWLEDGE_CONNECTOR_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  displayName: STRING_SCHEMA,
  version: STRING_SCHEMA,
  description: STRING_SCHEMA,
  sourceType: KNOWLEDGE_SOURCE_TYPE_SCHEMA,
  inputSchema: JSON_SCHEMA_DOCUMENT_SCHEMA,
  examples: GENERIC_LIST_SCHEMA,
  capabilities: STRING_LIST_SCHEMA,
  setup: KNOWLEDGE_CONNECTOR_SETUP_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'description', 'sourceType'], { additionalProperties: true });

const KNOWLEDGE_CONNECTOR_DOCTOR_CHECK_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  status: KNOWLEDGE_CONNECTOR_DOCTOR_STATUS_SCHEMA,
  detail: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'label', 'status', 'detail'], { additionalProperties: true });

const KNOWLEDGE_CONNECTOR_DOCTOR_REPORT_SCHEMA = objectSchema({
  connectorId: STRING_SCHEMA,
  ready: BOOLEAN_SCHEMA,
  summary: STRING_SCHEMA,
  checks: arraySchema(KNOWLEDGE_CONNECTOR_DOCTOR_CHECK_SCHEMA),
  hints: STRING_LIST_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['connectorId', 'ready', 'summary', 'checks', 'hints', 'metadata'], { additionalProperties: true });

export const KNOWLEDGE_INGEST_RESULT_SCHEMA = objectSchema({
  source: KNOWLEDGE_SOURCE_SCHEMA,
  artifactId: STRING_SCHEMA,
  issues: arraySchema(KNOWLEDGE_ISSUE_SCHEMA),
}, ['source', 'issues'], { additionalProperties: true });

export const KNOWLEDGE_BATCH_INGEST_RESULT_SCHEMA = objectSchema({
  imported: NUMBER_SCHEMA,
  failed: NUMBER_SCHEMA,
  sources: arraySchema(KNOWLEDGE_SOURCE_SCHEMA),
  errors: STRING_LIST_SCHEMA,
}, ['imported', 'failed', 'sources', 'errors']);

const KNOWLEDGE_SEARCH_RESULT_SCHEMA = objectSchema({
  kind: STRING_SCHEMA,
  id: STRING_SCHEMA,
  score: NUMBER_SCHEMA,
  reason: STRING_SCHEMA,
  source: KNOWLEDGE_SOURCE_SCHEMA,
  node: KNOWLEDGE_NODE_SCHEMA,
}, ['kind', 'id', 'score', 'reason'], { additionalProperties: true });

export const KNOWLEDGE_SEARCH_OUTPUT_SCHEMA = objectSchema({
  results: arraySchema(KNOWLEDGE_SEARCH_RESULT_SCHEMA),
}, ['results']);

export const KNOWLEDGE_SOURCES_OUTPUT_SCHEMA = listOutputSchema('sources', KNOWLEDGE_SOURCE_SCHEMA);
export const KNOWLEDGE_NODES_OUTPUT_SCHEMA = listOutputSchema('nodes', KNOWLEDGE_NODE_SCHEMA);
export const KNOWLEDGE_ISSUES_OUTPUT_SCHEMA = listOutputSchema('issues', KNOWLEDGE_ISSUE_SCHEMA);
export const KNOWLEDGE_CONNECTORS_OUTPUT_SCHEMA = listOutputSchema('connectors', KNOWLEDGE_CONNECTOR_SCHEMA);

const KNOWLEDGE_PACKET_ITEM_SCHEMA = objectSchema({
  kind: STRING_SCHEMA,
  id: STRING_SCHEMA,
  title: STRING_SCHEMA,
  summary: STRING_SCHEMA,
  uri: STRING_SCHEMA,
  reason: STRING_SCHEMA,
  score: NUMBER_SCHEMA,
  estimatedTokens: NUMBER_SCHEMA,
  related: STRING_LIST_SCHEMA,
  evidence: STRING_LIST_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['kind', 'id', 'title', 'reason', 'score', 'estimatedTokens', 'related', 'evidence', 'metadata'], { additionalProperties: true });

export const KNOWLEDGE_PACKET_SCHEMA = objectSchema({
  task: STRING_SCHEMA,
  writeScope: STRING_LIST_SCHEMA,
  generatedAt: NUMBER_SCHEMA,
  detail: KNOWLEDGE_PACKET_DETAIL_SCHEMA,
  strategy: STRING_SCHEMA,
  budgetLimit: NUMBER_SCHEMA,
  estimatedTokens: NUMBER_SCHEMA,
  items: arraySchema(KNOWLEDGE_PACKET_ITEM_SCHEMA),
}, ['task', 'writeScope', 'generatedAt', 'detail', 'strategy', 'budgetLimit', 'estimatedTokens', 'items']);

const KNOWLEDGE_USAGE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  targetKind: STRING_SCHEMA,
  targetId: STRING_SCHEMA,
  usageKind: STRING_SCHEMA,
  task: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  score: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
  createdAt: NUMBER_SCHEMA,
}, ['id', 'targetKind', 'targetId', 'usageKind', 'metadata', 'createdAt'], { additionalProperties: true });

const KNOWLEDGE_CANDIDATE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  candidateType: STRING_SCHEMA,
  status: STRING_SCHEMA,
  subjectKind: STRING_SCHEMA,
  subjectId: STRING_SCHEMA,
  title: STRING_SCHEMA,
  summary: STRING_SCHEMA,
  score: NUMBER_SCHEMA,
  evidence: STRING_LIST_SCHEMA,
  suggestedMemoryClass: STRING_SCHEMA,
  suggestedScope: STRING_SCHEMA,
  decidedAt: NUMBER_SCHEMA,
  decidedBy: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
}, ['id', 'candidateType', 'status', 'subjectKind', 'subjectId', 'title', 'score', 'evidence', 'metadata', 'createdAt', 'updatedAt'], { additionalProperties: true });

const KNOWLEDGE_REPORT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  title: STRING_SCHEMA,
  summary: STRING_SCHEMA,
  highlights: STRING_LIST_SCHEMA,
  metrics: recordSchema(NUMBER_SCHEMA),
  metadata: METADATA_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
}, ['id', 'kind', 'title', 'summary', 'highlights', 'metrics', 'metadata', 'createdAt', 'updatedAt'], { additionalProperties: true });

const KNOWLEDGE_JOB_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  kind: KNOWLEDGE_JOB_KIND_SCHEMA,
  title: STRING_SCHEMA,
  description: STRING_SCHEMA,
  defaultMode: KNOWLEDGE_JOB_MODE_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'kind', 'title', 'description', 'defaultMode', 'metadata']);

const KNOWLEDGE_JOB_RUN_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  jobId: STRING_SCHEMA,
  status: KNOWLEDGE_JOB_STATUS_SCHEMA,
  mode: KNOWLEDGE_JOB_MODE_SCHEMA,
  requestedAt: NUMBER_SCHEMA,
  startedAt: NUMBER_SCHEMA,
  completedAt: NUMBER_SCHEMA,
  error: STRING_SCHEMA,
  result: KNOWLEDGE_JOB_RUN_RESULT_SCHEMA,
  metadata: METADATA_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
}, ['id', 'jobId', 'status', 'mode', 'requestedAt', 'result', 'metadata', 'createdAt', 'updatedAt'], { additionalProperties: true });

const KNOWLEDGE_SCHEDULE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  jobId: STRING_SCHEMA,
  label: STRING_SCHEMA,
  enabled: BOOLEAN_SCHEMA,
  schedule: KNOWLEDGE_SCHEDULE_DEFINITION_SCHEMA,
  lastRunAt: NUMBER_SCHEMA,
  nextRunAt: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  updatedAt: NUMBER_SCHEMA,
}, ['id', 'jobId', 'label', 'enabled', 'schedule', 'metadata', 'createdAt', 'updatedAt'], { additionalProperties: true });

const KNOWLEDGE_PROJECTION_TARGET_SCHEMA = objectSchema({
  targetId: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  title: STRING_SCHEMA,
  description: STRING_SCHEMA,
  itemId: STRING_SCHEMA,
  defaultPath: STRING_SCHEMA,
  defaultFilename: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['targetId', 'kind', 'title', 'description', 'defaultPath', 'defaultFilename', 'metadata'], { additionalProperties: true });

const KNOWLEDGE_PROJECTION_PAGE_SCHEMA = objectSchema({
  path: STRING_SCHEMA,
  title: STRING_SCHEMA,
  format: STRING_SCHEMA,
  content: STRING_SCHEMA,
  itemIds: STRING_LIST_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['path', 'title', 'format', 'content', 'itemIds', 'metadata']);

export const KNOWLEDGE_PROJECTION_BUNDLE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  target: KNOWLEDGE_PROJECTION_TARGET_SCHEMA,
  generatedAt: NUMBER_SCHEMA,
  pageCount: NUMBER_SCHEMA,
  pages: arraySchema(KNOWLEDGE_PROJECTION_PAGE_SCHEMA),
  metadata: METADATA_SCHEMA,
}, ['id', 'target', 'generatedAt', 'pageCount', 'pages', 'metadata']);

export const KNOWLEDGE_MATERIALIZED_PROJECTION_SCHEMA = objectSchema({
  bundle: KNOWLEDGE_PROJECTION_BUNDLE_SCHEMA,
  artifact: ARTIFACT_DESCRIPTOR_SCHEMA,
}, ['bundle', 'artifact']);

export const KNOWLEDGE_GRAPHQL_SCHEMA_OUTPUT_SCHEMA = objectSchema({
  language: STRING_SCHEMA,
  domain: STRING_SCHEMA,
  schema: STRING_SCHEMA,
}, ['language', 'domain', 'schema']);

export const KNOWLEDGE_GRAPHQL_EXECUTE_OUTPUT_SCHEMA = objectSchema({
  data: GRAPHQL_RESPONSE_DATA_SCHEMA,
  errors: GENERIC_LIST_SCHEMA,
  extensions: GRAPHQL_RESPONSE_EXTENSIONS_SCHEMA,
}, [], { additionalProperties: true });

export const KNOWLEDGE_LINT_OUTPUT_SCHEMA = objectSchema({
  issues: arraySchema(KNOWLEDGE_ISSUE_SCHEMA),
}, ['issues']);

export const KNOWLEDGE_REINDEX_OUTPUT_SCHEMA = objectSchema({
  status: KNOWLEDGE_STATUS_SCHEMA,
  issues: arraySchema(KNOWLEDGE_ISSUE_SCHEMA),
}, ['status', 'issues']);

export const KNOWLEDGE_USAGE_OUTPUT_SCHEMA = objectSchema({
  usage: arraySchema(KNOWLEDGE_USAGE_SCHEMA),
}, ['usage']);

export const KNOWLEDGE_CANDIDATE_OUTPUT_SCHEMA = objectSchema({
  candidate: KNOWLEDGE_CANDIDATE_SCHEMA,
}, ['candidate']);

export const KNOWLEDGE_CANDIDATES_OUTPUT_SCHEMA = objectSchema({
  candidates: arraySchema(KNOWLEDGE_CANDIDATE_SCHEMA),
}, ['candidates']);

export const KNOWLEDGE_REPORT_OUTPUT_SCHEMA = objectSchema({
  report: KNOWLEDGE_REPORT_SCHEMA,
}, ['report']);

export const KNOWLEDGE_REPORTS_OUTPUT_SCHEMA = objectSchema({
  reports: arraySchema(KNOWLEDGE_REPORT_SCHEMA),
}, ['reports']);

export const KNOWLEDGE_EXTRACTION_OUTPUT_SCHEMA = objectSchema({
  extraction: KNOWLEDGE_EXTRACTION_SCHEMA,
}, ['extraction']);

export const KNOWLEDGE_JOBS_OUTPUT_SCHEMA = objectSchema({
  jobs: arraySchema(KNOWLEDGE_JOB_SCHEMA),
}, ['jobs']);

export const KNOWLEDGE_JOB_OUTPUT_SCHEMA = objectSchema({
  job: KNOWLEDGE_JOB_SCHEMA,
}, ['job']);

export const KNOWLEDGE_JOB_RUNS_OUTPUT_SCHEMA = objectSchema({
  runs: arraySchema(KNOWLEDGE_JOB_RUN_SCHEMA),
}, ['runs']);
export const KNOWLEDGE_JOB_RUN_OUTPUT_SCHEMA = objectSchema({
  run: KNOWLEDGE_JOB_RUN_SCHEMA,
}, ['run']);

export const KNOWLEDGE_SCHEDULES_OUTPUT_SCHEMA = objectSchema({
  schedules: arraySchema(KNOWLEDGE_SCHEDULE_SCHEMA),
}, ['schedules']);

export const KNOWLEDGE_SCHEDULE_OUTPUT_SCHEMA = objectSchema({
  schedule: KNOWLEDGE_SCHEDULE_SCHEMA,
}, ['schedule']);

export const KNOWLEDGE_PROJECTION_TARGETS_OUTPUT_SCHEMA = objectSchema({
  targets: arraySchema(KNOWLEDGE_PROJECTION_TARGET_SCHEMA),
}, ['targets']);

export const KNOWLEDGE_ITEM_ENTITY_OUTPUT_SCHEMA = KNOWLEDGE_ITEM_VIEW_SCHEMA;
export const KNOWLEDGE_CONNECTOR_ENTITY_OUTPUT_SCHEMA = entityOutputSchema('connector', KNOWLEDGE_CONNECTOR_SCHEMA);
export const KNOWLEDGE_CONNECTOR_DOCTOR_OUTPUT_SCHEMA = entityOutputSchema('report', KNOWLEDGE_CONNECTOR_DOCTOR_REPORT_SCHEMA);
export const KNOWLEDGE_EXTRACTIONS_OUTPUT_SCHEMA = listOutputSchema('extractions', KNOWLEDGE_EXTRACTION_SCHEMA);
export const KNOWLEDGE_USAGE_LIST_OUTPUT_SCHEMA = KNOWLEDGE_USAGE_OUTPUT_SCHEMA;
