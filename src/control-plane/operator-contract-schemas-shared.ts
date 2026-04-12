import {
  BOOLEAN_SCHEMA,
  JSON_ARRAY_SCHEMA,
  JSON_OBJECT_SCHEMA,
  JSON_VALUE_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
} from './method-catalog-shared.ts';

export {
  BOOLEAN_SCHEMA,
  JSON_ARRAY_SCHEMA,
  JSON_OBJECT_SCHEMA,
  JSON_VALUE_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  objectSchema,
};

const NULL_SCHEMA = { type: 'null' } as const;

export function enumSchema(values: readonly string[]): Record<string, unknown> {
  return { type: 'string', enum: [...values] };
}

export function nullableSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return { anyOf: [schema, NULL_SCHEMA] };
}

export function recordSchema(valueSchema: Record<string, unknown> = JSON_VALUE_SCHEMA): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: valueSchema,
  };
}

export const STRING_LIST_SCHEMA = arraySchema(STRING_SCHEMA);
export const GENERIC_LIST_SCHEMA = JSON_ARRAY_SCHEMA;
export const METADATA_SCHEMA = JSON_OBJECT_SCHEMA;

export const ARTIFACT_DESCRIPTOR_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  mimeType: STRING_SCHEMA,
  filename: STRING_SCHEMA,
  sizeBytes: NUMBER_SCHEMA,
  sha256: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  expiresAt: NUMBER_SCHEMA,
  sourceUri: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'kind', 'mimeType', 'sizeBytes', 'sha256', 'createdAt', 'metadata'], { additionalProperties: true });

export const ARTIFACT_ATTACHMENT_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  artifactId: STRING_SCHEMA,
  kind: STRING_SCHEMA,
  mimeType: STRING_SCHEMA,
  filename: STRING_SCHEMA,
  sizeBytes: NUMBER_SCHEMA,
  sha256: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  expiresAt: NUMBER_SCHEMA,
  sourceUri: STRING_SCHEMA,
  contentPath: STRING_SCHEMA,
  contentUrl: STRING_SCHEMA,
  dataBase64: STRING_SCHEMA,
  label: STRING_SCHEMA,
  metadata: METADATA_SCHEMA,
}, ['id', 'artifactId', 'kind', 'mimeType', 'sizeBytes', 'sha256', 'createdAt', 'contentPath', 'metadata'], { additionalProperties: true });
