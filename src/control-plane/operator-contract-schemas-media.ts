import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  entityOutputSchema,
  objectSchema,
} from './method-catalog-shared.ts';
import {
  ARTIFACT_DESCRIPTOR_SCHEMA,
  GENERIC_LIST_SCHEMA,
  METADATA_SCHEMA,
  STRING_LIST_SCHEMA,
  recordSchema,
} from './operator-contract-schemas-shared.ts';

const VOICE_PROVIDER_DESCRIPTOR_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  capabilities: STRING_LIST_SCHEMA,
}, ['id', 'label', 'capabilities']);

const VOICE_DESCRIPTOR_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  locale: STRING_SCHEMA,
  gender: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'label', 'metadata']);

const VOICE_PROVIDER_STATUS_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  state: STRING_SCHEMA,
  capabilities: STRING_LIST_SCHEMA,
  configured: BOOLEAN_SCHEMA,
  detail: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'label', 'state', 'capabilities', 'configured', 'metadata']);

const VOICE_AUDIO_ARTIFACT_SCHEMA = objectSchema({
  mimeType: STRING_SCHEMA,
  format: STRING_SCHEMA,
  dataBase64: STRING_SCHEMA,
  uri: STRING_SCHEMA,
  sampleRateHz: NUMBER_SCHEMA,
  durationMs: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['mimeType', 'format', 'metadata']);

export const VOICE_STATUS_SCHEMA = objectSchema({
  enabled: BOOLEAN_SCHEMA,
  providerCount: NUMBER_SCHEMA,
  providers: arraySchema(VOICE_PROVIDER_STATUS_SCHEMA),
  note: STRING_SCHEMA,
}, ['enabled', 'providerCount', 'providers', 'note']);

export const VOICE_PROVIDERS_OUTPUT_SCHEMA = objectSchema({
  providers: arraySchema(VOICE_PROVIDER_DESCRIPTOR_SCHEMA),
}, ['providers']);

export const VOICE_VOICES_OUTPUT_SCHEMA = objectSchema({
  voices: arraySchema(VOICE_DESCRIPTOR_SCHEMA),
}, ['voices']);

export const VOICE_SYNTHESIS_RESULT_SCHEMA = objectSchema({
  providerId: STRING_SCHEMA,
  audio: VOICE_AUDIO_ARTIFACT_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['providerId', 'audio', 'metadata']);

const VOICE_TRANSCRIPTION_SEGMENT_SCHEMA = objectSchema({
  text: STRING_SCHEMA,
  startMs: NUMBER_SCHEMA,
  endMs: NUMBER_SCHEMA,
  confidence: NUMBER_SCHEMA,
}, ['text']);

export const VOICE_TRANSCRIPTION_RESULT_SCHEMA = objectSchema({
  providerId: STRING_SCHEMA,
  text: STRING_SCHEMA,
  language: STRING_SCHEMA,
  segments: arraySchema(VOICE_TRANSCRIPTION_SEGMENT_SCHEMA),
  metadata: METADATA_SCHEMA,
}, ['providerId', 'text', 'metadata']);

export const VOICE_REALTIME_SESSION_SCHEMA = objectSchema({
  providerId: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  transport: STRING_SCHEMA,
  url: STRING_SCHEMA,
  expiresAt: NUMBER_SCHEMA,
  headers: recordSchema(STRING_SCHEMA),
  metadata: METADATA_SCHEMA,
}, ['providerId', 'sessionId', 'transport', 'metadata']);

const WEB_SEARCH_EVIDENCE_SCHEMA = objectSchema({
  url: STRING_SCHEMA,
  extract: STRING_SCHEMA,
  content: STRING_SCHEMA,
  tokensUsed: NUMBER_SCHEMA,
  status: NUMBER_SCHEMA,
  contentType: STRING_SCHEMA,
  truncated: BOOLEAN_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['url', 'extract', 'content', 'tokensUsed', 'metadata']);

const WEB_SEARCH_RESULT_SCHEMA = objectSchema({
  rank: NUMBER_SCHEMA,
  url: STRING_SCHEMA,
  title: STRING_SCHEMA,
  snippet: STRING_SCHEMA,
  displayUrl: STRING_SCHEMA,
  domain: STRING_SCHEMA,
  type: STRING_SCHEMA,
  providerId: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
  evidence: arraySchema(WEB_SEARCH_EVIDENCE_SCHEMA),
}, ['rank', 'url', 'type', 'providerId', 'metadata']);

const WEB_SEARCH_INSTANT_ANSWER_SCHEMA = objectSchema({
  heading: STRING_SCHEMA,
  answer: STRING_SCHEMA,
  abstract: STRING_SCHEMA,
  source: STRING_SCHEMA,
  url: STRING_SCHEMA,
  image: STRING_SCHEMA,
  type: STRING_SCHEMA,
  related: arraySchema(objectSchema({
    text: STRING_SCHEMA,
    url: STRING_SCHEMA,
  }, ['text', 'url'])),
  metadata: METADATA_SCHEMA,
}, ['type', 'related', 'metadata']);

const WEB_SEARCH_PROVIDER_DESCRIPTOR_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  capabilities: STRING_LIST_SCHEMA,
  requiresAuth: BOOLEAN_SCHEMA,
  configured: BOOLEAN_SCHEMA,
  note: STRING_SCHEMA,
}, ['id', 'label', 'capabilities', 'requiresAuth', 'configured']);

export const WEB_SEARCH_RESPONSE_SCHEMA = objectSchema({
  providerId: STRING_SCHEMA,
  providerLabel: STRING_SCHEMA,
  query: STRING_SCHEMA,
  verbosity: STRING_SCHEMA,
  results: arraySchema(WEB_SEARCH_RESULT_SCHEMA),
  instantAnswer: WEB_SEARCH_INSTANT_ANSWER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['providerId', 'providerLabel', 'query', 'verbosity', 'results', 'metadata']);

export const WEB_SEARCH_PROVIDERS_OUTPUT_SCHEMA = objectSchema({
  providers: arraySchema(WEB_SEARCH_PROVIDER_DESCRIPTOR_SCHEMA),
}, ['providers']);

const MEDIA_ARTIFACT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  artifactId: STRING_SCHEMA,
  mimeType: STRING_SCHEMA,
  dataBase64: STRING_SCHEMA,
  uri: STRING_SCHEMA,
  filename: STRING_SCHEMA,
  sizeBytes: NUMBER_SCHEMA,
  sha256: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['mimeType', 'metadata']);

const MEDIA_PROVIDER_DESCRIPTOR_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  capabilities: STRING_LIST_SCHEMA,
}, ['id', 'label', 'capabilities']);

export const MEDIA_ANALYSIS_RESULT_SCHEMA = objectSchema({
  providerId: STRING_SCHEMA,
  description: STRING_SCHEMA,
  labels: STRING_LIST_SCHEMA,
  text: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['providerId', 'metadata']);

export const MEDIA_TRANSFORM_RESULT_SCHEMA = objectSchema({
  providerId: STRING_SCHEMA,
  artifact: MEDIA_ARTIFACT_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['providerId', 'artifact', 'metadata']);

export const MEDIA_GENERATION_RESULT_SCHEMA = objectSchema({
  providerId: STRING_SCHEMA,
  artifacts: arraySchema(MEDIA_ARTIFACT_SCHEMA),
  metadata: METADATA_SCHEMA,
}, ['providerId', 'artifacts', 'metadata']);

const MULTIMODAL_PROVIDER_DESCRIPTOR_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  label: STRING_SCHEMA,
  transport: STRING_SCHEMA,
  capabilities: STRING_LIST_SCHEMA,
  configured: BOOLEAN_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'label', 'transport', 'capabilities', 'configured', 'metadata']);

const MULTIMODAL_SEGMENT_SCHEMA = objectSchema({
  kind: STRING_SCHEMA,
  title: STRING_SCHEMA,
  text: STRING_SCHEMA,
  startMs: NUMBER_SCHEMA,
  endMs: NUMBER_SCHEMA,
  confidence: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['kind', 'metadata']);

export const MULTIMODAL_STATUS_SCHEMA = objectSchema({
  enabled: BOOLEAN_SCHEMA,
  providerCount: NUMBER_SCHEMA,
  providers: arraySchema(MULTIMODAL_PROVIDER_DESCRIPTOR_SCHEMA),
  note: STRING_SCHEMA,
}, ['enabled', 'providerCount', 'providers', 'note']);

export const MULTIMODAL_ANALYSIS_RESULT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  artifact: ARTIFACT_DESCRIPTOR_SCHEMA,
  providerIds: STRING_LIST_SCHEMA,
  summary: STRING_SCHEMA,
  text: STRING_SCHEMA,
  labels: STRING_LIST_SCHEMA,
  entities: STRING_LIST_SCHEMA,
  segments: arraySchema(MULTIMODAL_SEGMENT_SCHEMA),
  metadata: METADATA_SCHEMA,
}, ['id', 'kind', 'artifact', 'providerIds', 'labels', 'entities', 'segments', 'metadata']);

export const MULTIMODAL_PACKET_SCHEMA = objectSchema({
  detail: STRING_SCHEMA,
  budgetLimit: NUMBER_SCHEMA,
  estimatedTokens: NUMBER_SCHEMA,
  rendered: STRING_SCHEMA,
  highlights: STRING_LIST_SCHEMA,
}, ['detail', 'budgetLimit', 'estimatedTokens', 'rendered', 'highlights']);

export const MULTIMODAL_WRITEBACK_RESULT_SCHEMA = objectSchema({
  analysisArtifact: ARTIFACT_DESCRIPTOR_SCHEMA,
  knowledgeSourceId: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['analysisArtifact', 'metadata']);

export const MULTIMODAL_ANALYZE_OUTPUT_SCHEMA = objectSchema({
  analysis: MULTIMODAL_ANALYSIS_RESULT_SCHEMA,
  packet: MULTIMODAL_PACKET_SCHEMA,
  writeback: MULTIMODAL_WRITEBACK_RESULT_SCHEMA,
}, ['analysis']);

export const MULTIMODAL_PACKET_OUTPUT_SCHEMA = objectSchema({
  packet: MULTIMODAL_PACKET_SCHEMA,
}, ['packet']);

export const MULTIMODAL_WRITEBACK_OUTPUT_SCHEMA = objectSchema({
  writeback: MULTIMODAL_WRITEBACK_RESULT_SCHEMA,
}, ['writeback']);

export const ARTIFACT_ENTITY_OUTPUT_SCHEMA = entityOutputSchema('artifact', ARTIFACT_DESCRIPTOR_SCHEMA);

export const ARTIFACT_LIST_OUTPUT_SCHEMA = objectSchema({
  artifacts: GENERIC_LIST_SCHEMA,
}, ['artifacts']);

export const MULTIMODAL_PROVIDERS_OUTPUT_SCHEMA = objectSchema({
  providers: arraySchema(MULTIMODAL_PROVIDER_DESCRIPTOR_SCHEMA),
}, ['providers']);

export const MEDIA_PROVIDERS_OUTPUT_SCHEMA = objectSchema({
  providers: arraySchema(MEDIA_PROVIDER_DESCRIPTOR_SCHEMA),
}, ['providers']);
