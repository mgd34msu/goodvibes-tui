import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.ts';
import {
  enumSchema,
  TOOL_ARGUMENTS_SCHEMA,
} from './operator-contract-schemas-shared.ts';

export const PERMISSION_CATEGORY_SCHEMA = enumSchema(['read', 'write', 'execute', 'delegate']);
export const PERMISSION_RISK_LEVEL_SCHEMA = enumSchema(['low', 'medium', 'high', 'critical']);
export const PERMISSION_ANALYSIS_TARGET_KIND_SCHEMA = enumSchema(['command', 'path', 'url', 'task', 'generic']);
export const PERMISSION_ANALYSIS_SURFACE_SCHEMA = enumSchema(['filesystem', 'shell', 'network', 'orchestration', 'platform', 'generic']);
export const PERMISSION_BLAST_RADIUS_SCHEMA = enumSchema(['local', 'project', 'external', 'delegated', 'platform']);

export const PERMISSION_PROMPT_REQUEST_ANALYSIS_SCHEMA = objectSchema({
  classification: STRING_SCHEMA,
  riskLevel: PERMISSION_RISK_LEVEL_SCHEMA,
  summary: STRING_SCHEMA,
  reasons: arraySchema(STRING_SCHEMA),
  target: STRING_SCHEMA,
  targetKind: PERMISSION_ANALYSIS_TARGET_KIND_SCHEMA,
  surface: PERMISSION_ANALYSIS_SURFACE_SCHEMA,
  blastRadius: PERMISSION_BLAST_RADIUS_SCHEMA,
  sideEffects: arraySchema(STRING_SCHEMA),
  host: STRING_SCHEMA,
}, ['classification', 'riskLevel', 'summary', 'reasons'], { additionalProperties: false });

export const PERMISSION_PROMPT_REQUEST_SCHEMA = objectSchema({
  callId: STRING_SCHEMA,
  tool: STRING_SCHEMA,
  args: TOOL_ARGUMENTS_SCHEMA,
  category: PERMISSION_CATEGORY_SCHEMA,
  analysis: PERMISSION_PROMPT_REQUEST_ANALYSIS_SCHEMA,
  workingDirectory: STRING_SCHEMA,
}, ['callId', 'tool', 'args', 'category', 'analysis'], { additionalProperties: false });

export const PERMISSION_PROMPT_DECISION_SCHEMA = objectSchema({
  approved: BOOLEAN_SCHEMA,
  remember: BOOLEAN_SCHEMA,
}, ['approved'], { additionalProperties: false });

export const PERMISSION_MODE_SCHEMA = enumSchema([
  'default',
  'plan',
  'allow-all',
  'custom',
  'background-restricted',
]);
export const PERMISSION_DECISION_MACHINE_STATE_SCHEMA = enumSchema([
  'collect_rules',
  'normalize_input',
  'evaluate_policy',
  'evaluate_runtime_mode',
  'evaluate_session_override',
  'final_safety_checks',
  'decision_emitted',
]);
export const PERMISSION_DECISION_OUTCOME_SCHEMA = enumSchema(['approved', 'denied', 'deferred']);
export const PERMISSION_SOURCE_LAYER_SCHEMA = enumSchema([
  'config_policy',
  'managed_policy',
  'runtime_mode',
  'session_override',
  'safety_check',
  'user_prompt',
]);
export const PERMISSION_DECISION_REASON_SCHEMA = enumSchema([
  'config_allow',
  'config_deny',
  'managed_policy_allow',
  'managed_policy_deny',
  'mode_allow_all',
  'mode_denied',
  'mode_plan_deny',
  'mode_background_restricted',
  'session_cached_approval',
  'session_cached_denial',
  'safety_guardrail',
  'user_approved',
  'user_denied',
]);

export const PERMISSION_RUNTIME_DECISION_SCHEMA = objectSchema({
  callId: STRING_SCHEMA,
  toolName: STRING_SCHEMA,
  category: PERMISSION_CATEGORY_SCHEMA,
  machineState: PERMISSION_DECISION_MACHINE_STATE_SCHEMA,
  outcome: PERMISSION_DECISION_OUTCOME_SCHEMA,
  reason: PERMISSION_DECISION_REASON_SCHEMA,
  sourceLayer: PERMISSION_SOURCE_LAYER_SCHEMA,
  persisted: BOOLEAN_SCHEMA,
  classification: STRING_SCHEMA,
  riskLevel: PERMISSION_RISK_LEVEL_SCHEMA,
  summary: STRING_SCHEMA,
  decidedAt: NUMBER_SCHEMA,
}, ['callId', 'toolName', 'category', 'machineState', 'outcome', 'reason', 'sourceLayer', 'persisted', 'decidedAt'], { additionalProperties: false });
