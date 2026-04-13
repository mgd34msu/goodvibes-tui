import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  bodyEnvelopeSchema,
  objectSchema,
} from './method-catalog-shared.ts';
import {
  JSON_RECORD_SCHEMA,
  METADATA_SCHEMA,
  STRING_LIST_SCHEMA,
  enumSchema,
} from './operator-contract-schemas-shared.ts';

export const ARTIFACT_ACQUISITION_MODE_SCHEMA = enumSchema(['inline-data', 'local-path', 'remote-fetch', 'unknown']);
export const ARTIFACT_FETCH_MODE_SCHEMA = enumSchema(['not-applicable', 'public-only', 'allow-private-hosts', 'unknown']);

export const VOICE_AUDIO_ARTIFACT_SCHEMA = objectSchema({
  mimeType: STRING_SCHEMA,
  format: STRING_SCHEMA,
  dataBase64: STRING_SCHEMA,
  uri: STRING_SCHEMA,
  sampleRateHz: NUMBER_SCHEMA,
  durationMs: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['mimeType', 'format', 'metadata']);

export const VOICE_SYNTHESIS_REQUEST_SCHEMA = bodyEnvelopeSchema({
  providerId: STRING_SCHEMA,
  text: STRING_SCHEMA,
  voiceId: STRING_SCHEMA,
  modelId: STRING_SCHEMA,
  format: STRING_SCHEMA,
  speed: NUMBER_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['text']);

export const VOICE_TRANSCRIPTION_REQUEST_SCHEMA = bodyEnvelopeSchema({
  providerId: STRING_SCHEMA,
  audio: VOICE_AUDIO_ARTIFACT_SCHEMA,
  language: STRING_SCHEMA,
  modelId: STRING_SCHEMA,
  prompt: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['audio']);

export const VOICE_REALTIME_SESSION_REQUEST_SCHEMA = bodyEnvelopeSchema({
  providerId: STRING_SCHEMA,
  modelId: STRING_SCHEMA,
  voiceId: STRING_SCHEMA,
  inputFormat: STRING_SCHEMA,
  outputFormat: STRING_SCHEMA,
  instructions: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
});

export const MEDIA_ARTIFACT_SCHEMA = objectSchema({
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

export const MEDIA_ANALYZE_REQUEST_SCHEMA = bodyEnvelopeSchema({
  providerId: STRING_SCHEMA,
  artifact: MEDIA_ARTIFACT_SCHEMA,
  artifactId: STRING_SCHEMA,
  prompt: STRING_SCHEMA,
  modelId: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
});

export const MEDIA_TRANSFORM_REQUEST_SCHEMA = bodyEnvelopeSchema({
  providerId: STRING_SCHEMA,
  artifact: MEDIA_ARTIFACT_SCHEMA,
  operation: STRING_SCHEMA,
  outputMimeType: STRING_SCHEMA,
  options: JSON_RECORD_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['artifact', 'operation']);

export const MEDIA_GENERATION_REQUEST_SCHEMA = bodyEnvelopeSchema({
  providerId: STRING_SCHEMA,
  prompt: STRING_SCHEMA,
  outputMimeType: STRING_SCHEMA,
  modelId: STRING_SCHEMA,
  options: JSON_RECORD_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['prompt']);

export const MULTIMODAL_ARTIFACT_INPUT_SCHEMA = objectSchema({
  artifactId: STRING_SCHEMA,
  mimeType: STRING_SCHEMA,
  dataBase64: STRING_SCHEMA,
  uri: STRING_SCHEMA,
  allowPrivateHosts: BOOLEAN_SCHEMA,
  filename: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
});

export const MULTIMODAL_WRITEBACK_OPTIONS_SCHEMA = objectSchema({
  sessionId: STRING_SCHEMA,
  title: STRING_SCHEMA,
  tags: arraySchema(STRING_SCHEMA),
  folderPath: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
});

export const MULTIMODAL_ANALYZE_REQUEST_SCHEMA = bodyEnvelopeSchema({
  artifactId: STRING_SCHEMA,
  artifact: MULTIMODAL_ARTIFACT_INPUT_SCHEMA,
  prompt: STRING_SCHEMA,
  imageProviderId: STRING_SCHEMA,
  audioProviderId: STRING_SCHEMA,
  modelId: STRING_SCHEMA,
  language: STRING_SCHEMA,
  detail: enumSchema(['compact', 'standard', 'detailed']),
  allowPrivateHosts: BOOLEAN_SCHEMA,
  includePacket: BOOLEAN_SCHEMA,
  writeback: MULTIMODAL_WRITEBACK_OPTIONS_SCHEMA,
  sessionId: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
});

export const MULTIMODAL_PACKET_REQUEST_SCHEMA = bodyEnvelopeSchema({
  analysis: objectSchema({
    id: STRING_SCHEMA,
    kind: STRING_SCHEMA,
    artifact: objectSchema({
      id: STRING_SCHEMA,
      kind: STRING_SCHEMA,
      mimeType: STRING_SCHEMA,
      filename: STRING_SCHEMA,
      sizeBytes: NUMBER_SCHEMA,
      sha256: STRING_SCHEMA,
      createdAt: NUMBER_SCHEMA,
      expiresAt: NUMBER_SCHEMA,
      sourceUri: STRING_SCHEMA,
      acquisitionMode: STRING_SCHEMA,
      fetchMode: STRING_SCHEMA,
      metadata: METADATA_SCHEMA,
    }, ['id', 'kind', 'mimeType', 'sizeBytes', 'sha256', 'createdAt', 'metadata'], { additionalProperties: true }),
    providerIds: STRING_LIST_SCHEMA,
    summary: STRING_SCHEMA,
    text: STRING_SCHEMA,
    labels: STRING_LIST_SCHEMA,
    entities: STRING_LIST_SCHEMA,
    segments: arraySchema(objectSchema({
      kind: STRING_SCHEMA,
      title: STRING_SCHEMA,
      text: STRING_SCHEMA,
      startMs: NUMBER_SCHEMA,
      endMs: NUMBER_SCHEMA,
      confidence: NUMBER_SCHEMA,
      metadata: METADATA_SCHEMA,
    }, ['kind', 'metadata'])),
    metadata: METADATA_SCHEMA,
  }, ['id', 'kind', 'artifact', 'providerIds', 'labels', 'entities', 'segments', 'metadata']),
  detail: enumSchema(['compact', 'standard', 'detailed']),
  budgetLimit: NUMBER_SCHEMA,
}, ['analysis']);

export const MULTIMODAL_WRITEBACK_REQUEST_SCHEMA = bodyEnvelopeSchema({
  analysis: objectSchema({
    id: STRING_SCHEMA,
    kind: STRING_SCHEMA,
    artifact: objectSchema({
      id: STRING_SCHEMA,
      kind: STRING_SCHEMA,
      mimeType: STRING_SCHEMA,
      filename: STRING_SCHEMA,
      sizeBytes: NUMBER_SCHEMA,
      sha256: STRING_SCHEMA,
      createdAt: NUMBER_SCHEMA,
      expiresAt: NUMBER_SCHEMA,
      sourceUri: STRING_SCHEMA,
      acquisitionMode: STRING_SCHEMA,
      fetchMode: STRING_SCHEMA,
      metadata: METADATA_SCHEMA,
    }, ['id', 'kind', 'mimeType', 'sizeBytes', 'sha256', 'createdAt', 'metadata'], { additionalProperties: true }),
    providerIds: STRING_LIST_SCHEMA,
    summary: STRING_SCHEMA,
    text: STRING_SCHEMA,
    labels: STRING_LIST_SCHEMA,
    entities: STRING_LIST_SCHEMA,
    segments: arraySchema(objectSchema({
      kind: STRING_SCHEMA,
      title: STRING_SCHEMA,
      text: STRING_SCHEMA,
      startMs: NUMBER_SCHEMA,
      endMs: NUMBER_SCHEMA,
      confidence: NUMBER_SCHEMA,
      metadata: METADATA_SCHEMA,
    }, ['kind', 'metadata'])),
    metadata: METADATA_SCHEMA,
  }, ['id', 'kind', 'artifact', 'providerIds', 'labels', 'entities', 'segments', 'metadata']),
  sessionId: STRING_SCHEMA,
  title: STRING_SCHEMA,
  tags: arraySchema(STRING_SCHEMA),
  folderPath: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['analysis']);
