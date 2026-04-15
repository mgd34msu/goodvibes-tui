import { describe, expect, test } from 'bun:test';
import {
  KNOWLEDGE_INJECTION_PROMPT_SCHEMA,
  KNOWLEDGE_INJECTION_SCHEMA,
} from '@pellux/goodvibes-sdk/platform/control-plane/operator-contract-schemas-knowledge';
import {
  ARTIFACT_ACQUISITION_MODE_SCHEMA,
  ARTIFACT_FETCH_MODE_SCHEMA,
} from '@pellux/goodvibes-sdk/platform/control-plane/operator-contract-schemas-media';
import { ARTIFACT_ATTACHMENT_SCHEMA, ARTIFACT_DESCRIPTOR_SCHEMA } from '@pellux/goodvibes-sdk/platform/control-plane/operator-contract-schemas-shared';

function objectProperties(schema: Record<string, unknown>): Record<string, unknown> {
  return (schema.properties ?? {}) as Record<string, unknown>;
}

describe('knowledge and artifact intent gate', () => {
  test('knowledge injection schema exposes explicit runtime intent semantics', () => {
    const injectionProperties = objectProperties(KNOWLEDGE_INJECTION_SCHEMA);
    const promptProperties = objectProperties(KNOWLEDGE_INJECTION_PROMPT_SCHEMA);

    expect(injectionProperties.trustTier).toEqual({ type: 'string', enum: ['reviewed', 'fresh', 'stale'] });
    expect(injectionProperties.useAs).toEqual({ type: 'string', enum: ['reference-material'] });
    expect(injectionProperties.retention).toEqual({ type: 'string', enum: ['task-only'] });
    expect(injectionProperties.ingestMode).toEqual({
      type: 'string',
      enum: ['keyword-ranked', 'semantic-ranked', 'hybrid-ranked'],
    });
    expect(objectProperties(injectionProperties.provenance as Record<string, unknown>).source).toEqual({
      type: 'string',
      enum: ['project-memory'],
    });
    expect(promptProperties.injections).toBeTruthy();
  });

  test('artifact descriptor schemas expose acquisition and fetch modes explicitly', () => {
    const descriptorProperties = objectProperties(ARTIFACT_DESCRIPTOR_SCHEMA);
    const attachmentProperties = objectProperties(ARTIFACT_ATTACHMENT_SCHEMA);

    expect(ARTIFACT_ACQUISITION_MODE_SCHEMA).toEqual({
      type: 'string',
      enum: ['inline-data', 'local-path', 'remote-fetch', 'unknown'],
    });
    expect(ARTIFACT_FETCH_MODE_SCHEMA).toEqual({
      type: 'string',
      enum: ['not-applicable', 'public-only', 'allow-private-hosts', 'unknown'],
    });
    expect(descriptorProperties.acquisitionMode).toEqual({ type: 'string' });
    expect(descriptorProperties.fetchMode).toEqual({ type: 'string' });
    expect(attachmentProperties.acquisitionMode).toEqual({ type: 'string' });
    expect(attachmentProperties.fetchMode).toEqual({ type: 'string' });
  });
});
