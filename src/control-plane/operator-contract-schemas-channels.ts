import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  entityOutputSchema,
  objectSchema,
} from './method-catalog-shared.ts';
import {
  GENERIC_LIST_SCHEMA,
  JSON_RECORD_SCHEMA,
  JSON_SCHEMA_DOCUMENT_SCHEMA,
  JSON_VALUE_SCHEMA,
  METADATA_SCHEMA,
  STRING_LIST_SCHEMA,
  nullableSchema,
} from './operator-contract-schemas-shared.ts';

const CHANNEL_SECRET_STATUS_SCHEMA = objectSchema({
  field: STRING_SCHEMA,
  label: STRING_SCHEMA,
  configured: BOOLEAN_SCHEMA,
  source: STRING_SCHEMA,
}, ['field', 'label', 'configured', 'source']);

const CHANNEL_ACCOUNT_ACTION_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  available: BOOLEAN_SCHEMA,
}, ['id', 'label', 'kind', 'available']);

const CHANNEL_SETUP_FIELD_OPTION_SCHEMA = objectSchema({
  value: STRING_SCHEMA,
  label: STRING_SCHEMA,
}, ['value', 'label']);

const CHANNEL_LOGIN_SCHEMA = objectSchema({
  kind: STRING_SCHEMA,
  url: STRING_SCHEMA,
  qr: STRING_SCHEMA,
  expiresAt: NUMBER_SCHEMA,
  instructions: STRING_SCHEMA,
}, ['kind']);

export const TOOL_DEFINITION_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  description: STRING_SCHEMA,
  parameters: JSON_SCHEMA_DOCUMENT_SCHEMA,
  sideEffects: STRING_LIST_SCHEMA,
  concurrency: STRING_SCHEMA,
  supportsProgress: BOOLEAN_SCHEMA,
  supportsStreamingOutput: BOOLEAN_SCHEMA,
}, ['name', 'description', 'parameters']);

export const CHANNEL_REPAIR_ACTION_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  description: STRING_SCHEMA,
  dangerous: BOOLEAN_SCHEMA,
  inputSchema: JSON_SCHEMA_DOCUMENT_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'label', 'description', 'dangerous', 'metadata']);

export const CHANNEL_ACCOUNT_RECORD_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  surface: STRING_SCHEMA,
  label: STRING_SCHEMA,
  enabled: BOOLEAN_SCHEMA,
  configured: BOOLEAN_SCHEMA,
  linked: BOOLEAN_SCHEMA,
  state: STRING_SCHEMA,
  authState: STRING_SCHEMA,
  accountId: STRING_SCHEMA,
  workspaceId: STRING_SCHEMA,
  secrets: arraySchema(CHANNEL_SECRET_STATUS_SCHEMA),
  actions: arraySchema(CHANNEL_ACCOUNT_ACTION_SCHEMA),
  metadata: METADATA_SCHEMA,
}, ['id', 'surface', 'label', 'enabled', 'configured', 'linked', 'state', 'authState', 'secrets', 'actions', 'metadata']);

const CHANNEL_SETUP_FIELD_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  required: BOOLEAN_SCHEMA,
  detail: STRING_SCHEMA,
  placeholder: STRING_SCHEMA,
  configKey: STRING_SCHEMA,
  secretTargetId: STRING_SCHEMA,
  defaultValue: JSON_VALUE_SCHEMA,
  options: arraySchema(CHANNEL_SETUP_FIELD_OPTION_SCHEMA),
  metadata: METADATA_SCHEMA,
}, ['id', 'label', 'kind', 'required', 'metadata']);

const CHANNEL_SECRET_TARGET_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  surface: STRING_SCHEMA,
  label: STRING_SCHEMA,
  required: BOOLEAN_SCHEMA,
  supports: STRING_LIST_SCHEMA,
  serviceName: STRING_SCHEMA,
  serviceField: STRING_SCHEMA,
  envKeys: STRING_LIST_SCHEMA,
  configKeys: STRING_LIST_SCHEMA,
  detail: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'surface', 'label', 'required', 'supports', 'metadata']);

export const CHANNEL_SETUP_SCHEMA_SCHEMA = objectSchema({
  surface: STRING_SCHEMA,
  version: NUMBER_SCHEMA,
  label: STRING_SCHEMA,
  setupMode: STRING_SCHEMA,
  description: STRING_SCHEMA,
  fields: arraySchema(CHANNEL_SETUP_FIELD_SCHEMA),
  secretTargets: arraySchema(CHANNEL_SECRET_TARGET_SCHEMA),
  externalSteps: STRING_LIST_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['surface', 'version', 'label', 'setupMode', 'description', 'fields', 'secretTargets', 'externalSteps', 'metadata']);

const CHANNEL_DOCTOR_CHECK_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  status: STRING_SCHEMA,
  detail: STRING_SCHEMA,
  repairActionId: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'label', 'status', 'detail']);

export const CHANNEL_DOCTOR_REPORT_SCHEMA = objectSchema({
  surface: STRING_SCHEMA,
  accountId: STRING_SCHEMA,
  state: STRING_SCHEMA,
  summary: STRING_SCHEMA,
  checkedAt: NUMBER_SCHEMA,
  checks: arraySchema(CHANNEL_DOCTOR_CHECK_SCHEMA),
  repairActions: arraySchema(CHANNEL_REPAIR_ACTION_SCHEMA),
  metadata: METADATA_SCHEMA,
}, ['surface', 'state', 'summary', 'checkedAt', 'checks', 'repairActions', 'metadata']);

const CHANNEL_LIFECYCLE_MIGRATION_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  fromVersion: NUMBER_SCHEMA,
  toVersion: NUMBER_SCHEMA,
  action: STRING_SCHEMA,
  applied: BOOLEAN_SCHEMA,
  detail: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'fromVersion', 'toVersion', 'action', 'applied', 'detail']);

export const CHANNEL_LIFECYCLE_STATE_SCHEMA = objectSchema({
  surface: STRING_SCHEMA,
  accountId: STRING_SCHEMA,
  currentVersion: NUMBER_SCHEMA,
  targetVersion: NUMBER_SCHEMA,
  migrations: arraySchema(CHANNEL_LIFECYCLE_MIGRATION_SCHEMA),
  metadata: METADATA_SCHEMA,
}, ['surface', 'currentVersion', 'targetVersion', 'migrations', 'metadata']);

const CHANNEL_LIFECYCLE_RESULT_SCHEMA = objectSchema({
  surface: STRING_SCHEMA,
  accountId: STRING_SCHEMA,
  action: STRING_SCHEMA,
  ok: BOOLEAN_SCHEMA,
  state: STRING_SCHEMA,
  authState: STRING_SCHEMA,
  account: nullableSchema(CHANNEL_ACCOUNT_RECORD_SCHEMA),
  message: STRING_SCHEMA,
  login: CHANNEL_LOGIN_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['surface', 'action', 'ok', 'metadata']);

export const CHANNEL_ACCOUNT_ACTION_OUTPUT_SCHEMA = objectSchema({
  surface: STRING_SCHEMA,
  accountId: STRING_SCHEMA,
  action: STRING_SCHEMA,
  result: CHANNEL_LIFECYCLE_RESULT_SCHEMA,
}, ['surface', 'action', 'result']);

const CHANNEL_RESOLVED_TARGET_SCHEMA = objectSchema({
  surface: STRING_SCHEMA,
  input: STRING_SCHEMA,
  normalized: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  to: STRING_SCHEMA,
  display: STRING_SCHEMA,
  accountId: STRING_SCHEMA,
  workspaceId: STRING_SCHEMA,
  channelId: STRING_SCHEMA,
  groupId: STRING_SCHEMA,
  threadId: STRING_SCHEMA,
  parentId: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  sessionTarget: STRING_SCHEMA,
  bindingId: STRING_SCHEMA,
  directoryEntryId: STRING_SCHEMA,
  source: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['surface', 'input', 'normalized', 'kind', 'to', 'source', 'metadata']);

export const CHANNEL_TARGET_RESOLVE_OUTPUT_SCHEMA = objectSchema({
  surface: STRING_SCHEMA,
  target: CHANNEL_RESOLVED_TARGET_SCHEMA,
}, ['surface', 'target']);

const CHANNEL_AUTHORIZATION_RESULT_SCHEMA = objectSchema({
  allowed: BOOLEAN_SCHEMA,
  reason: STRING_SCHEMA,
  account: nullableSchema(CHANNEL_ACCOUNT_RECORD_SCHEMA),
  actionAvailable: BOOLEAN_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['allowed', 'reason', 'metadata']);

export const CHANNEL_AUTHORIZE_OUTPUT_SCHEMA = objectSchema({
  surface: STRING_SCHEMA,
  result: CHANNEL_AUTHORIZATION_RESULT_SCHEMA,
}, ['surface', 'result']);

const CHANNEL_ALLOWLIST_TARGET_SCHEMA = objectSchema({
  kind: STRING_SCHEMA,
  input: STRING_SCHEMA,
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['kind', 'input', 'id', 'label', 'metadata']);

export const CHANNEL_ALLOWLIST_RESOLUTION_SCHEMA = objectSchema({
  surface: STRING_SCHEMA,
  resolved: arraySchema(CHANNEL_ALLOWLIST_TARGET_SCHEMA),
  unresolved: STRING_LIST_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['surface', 'resolved', 'unresolved', 'metadata']);

export const CHANNEL_GROUP_POLICY_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  groupId: STRING_SCHEMA,
  channelId: STRING_SCHEMA,
  workspaceId: STRING_SCHEMA,
  requireMention: BOOLEAN_SCHEMA,
  allowGroupMessages: BOOLEAN_SCHEMA,
  allowThreadMessages: BOOLEAN_SCHEMA,
  allowTextCommandsWithoutMention: BOOLEAN_SCHEMA,
  allowlistUserIds: STRING_LIST_SCHEMA,
  allowlistChannelIds: STRING_LIST_SCHEMA,
  allowlistGroupIds: STRING_LIST_SCHEMA,
  allowedCommands: STRING_LIST_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id']);

export const CHANNEL_STATUS_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  surface: STRING_SCHEMA,
  label: STRING_SCHEMA,
  state: STRING_SCHEMA,
  enabled: BOOLEAN_SCHEMA,
  accountId: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'surface', 'label', 'state', 'enabled', 'metadata']);

export const CHANNEL_CAPABILITY_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  surface: STRING_SCHEMA,
  label: STRING_SCHEMA,
  scope: STRING_SCHEMA,
  supported: BOOLEAN_SCHEMA,
  detail: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'surface', 'label', 'scope', 'supported', 'detail', 'metadata']);

export const CHANNEL_TOOL_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  surface: STRING_SCHEMA,
  name: STRING_SCHEMA,
  description: STRING_SCHEMA,
  actionIds: STRING_LIST_SCHEMA,
  inputSchema: JSON_SCHEMA_DOCUMENT_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'surface', 'name', 'description', 'actionIds', 'metadata']);

export const CHANNEL_OPERATOR_ACTION_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  surface: STRING_SCHEMA,
  label: STRING_SCHEMA,
  description: STRING_SCHEMA,
  dangerous: BOOLEAN_SCHEMA,
  inputSchema: JSON_SCHEMA_DOCUMENT_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'surface', 'label', 'description', 'dangerous', 'metadata']);

export const CHANNEL_POLICY_AUDIT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  surface: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  allowed: BOOLEAN_SCHEMA,
  reason: STRING_SCHEMA,
  userId: STRING_SCHEMA,
  channelId: STRING_SCHEMA,
  groupId: STRING_SCHEMA,
  threadId: STRING_SCHEMA,
  conversationKind: STRING_SCHEMA,
  matchedGroupPolicyId: STRING_SCHEMA,
  text: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'surface', 'createdAt', 'allowed', 'reason', 'metadata']);

export const CHANNEL_DIRECTORY_ENTRY_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  surface: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  label: STRING_SCHEMA,
  handle: STRING_SCHEMA,
  accountId: STRING_SCHEMA,
  workspaceId: STRING_SCHEMA,
  groupId: STRING_SCHEMA,
  threadId: STRING_SCHEMA,
  parentId: STRING_SCHEMA,
  memberCount: NUMBER_SCHEMA,
  memberIds: STRING_LIST_SCHEMA,
  aliases: STRING_LIST_SCHEMA,
  isSelf: BOOLEAN_SCHEMA,
  isDirect: BOOLEAN_SCHEMA,
  isGroupConversation: BOOLEAN_SCHEMA,
  searchText: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'surface', 'kind', 'label', 'metadata']);

export const CHANNEL_POLICY_SCHEMA = objectSchema({
  surface: STRING_SCHEMA,
  enabled: BOOLEAN_SCHEMA,
  requireMention: BOOLEAN_SCHEMA,
  allowDirectMessages: BOOLEAN_SCHEMA,
  allowGroupMessages: BOOLEAN_SCHEMA,
  allowThreadMessages: BOOLEAN_SCHEMA,
  dmPolicy: STRING_SCHEMA,
  groupPolicy: STRING_SCHEMA,
  allowTextCommandsWithoutMention: BOOLEAN_SCHEMA,
  allowlistUserIds: STRING_LIST_SCHEMA,
  allowlistChannelIds: STRING_LIST_SCHEMA,
  allowlistGroupIds: STRING_LIST_SCHEMA,
  allowedCommands: STRING_LIST_SCHEMA,
  groupPolicies: arraySchema(CHANNEL_GROUP_POLICY_SCHEMA),
  updatedAt: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['surface', 'enabled', 'requireMention', 'allowDirectMessages', 'allowGroupMessages', 'allowThreadMessages', 'dmPolicy', 'groupPolicy', 'allowTextCommandsWithoutMention', 'allowlistUserIds', 'allowlistChannelIds', 'allowlistGroupIds', 'allowedCommands', 'groupPolicies', 'updatedAt', 'metadata']);

export const CHANNEL_ALLOWLIST_EDIT_RESULT_SCHEMA = objectSchema({
  surface: STRING_SCHEMA,
  updatedPolicy: CHANNEL_POLICY_SCHEMA,
  resolution: CHANNEL_ALLOWLIST_RESOLUTION_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['surface', 'updatedPolicy', 'resolution', 'metadata']);

export const CHANNEL_TOOL_ACTION_OUTPUT_SCHEMA = objectSchema({
  toolId: STRING_SCHEMA,
  surface: STRING_SCHEMA,
  result: JSON_RECORD_SCHEMA,
}, ['toolId', 'surface', 'result']);

export const CHANNEL_OPERATOR_ACTION_OUTPUT_SCHEMA = objectSchema({
  actionId: STRING_SCHEMA,
  surface: STRING_SCHEMA,
  result: JSON_RECORD_SCHEMA,
}, ['actionId', 'surface', 'result']);

export const CHANNEL_STATUS_LIST_OUTPUT_SCHEMA = objectSchema({
  channels: arraySchema(CHANNEL_STATUS_SCHEMA),
}, ['channels']);

export const CHANNEL_ACCOUNT_ENTITY_OUTPUT_SCHEMA = CHANNEL_ACCOUNT_RECORD_SCHEMA;
export const CHANNEL_ACCOUNTS_OUTPUT_SCHEMA = objectSchema({
  accounts: arraySchema(CHANNEL_ACCOUNT_RECORD_SCHEMA),
}, ['accounts']);

export const CHANNEL_SETUP_ENTITY_OUTPUT_SCHEMA = entityOutputSchema('schema', CHANNEL_SETUP_SCHEMA_SCHEMA);
