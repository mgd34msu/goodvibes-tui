import { describe, expect, test } from 'bun:test';
import {
  SHARED_SESSION_INPUT_RECORD_SCHEMA,
  SHARED_SESSION_ROUTING_INTENT_SCHEMA,
} from '@pellux/goodvibes-sdk/platform/control-plane';
import {
  AUTOMATION_RUN_SCHEMA,
  ROUTE_BINDING_SCHEMA,
} from '@pellux/goodvibes-sdk/platform/control-plane';

function objectProperties(schema: Record<string, unknown>): Record<string, unknown> {
  return (schema.properties ?? {}) as Record<string, unknown>;
}

describe('session, route, and execution intent gate', () => {
  test('shared session schemas expose explicit routing and lifecycle intent semantics', () => {
    const routingProperties = objectProperties(SHARED_SESSION_ROUTING_INTENT_SCHEMA);
    const inputProperties = objectProperties(SHARED_SESSION_INPUT_RECORD_SCHEMA);
    const executionIntentProperties = objectProperties(routingProperties.executionIntent as Record<string, unknown>);

    expect(inputProperties.correlationId).toEqual({ type: 'string' });
    expect(inputProperties.causationId).toEqual({ type: 'string' });
    expect(executionIntentProperties.riskClass).toEqual({ type: 'string', enum: ['safe', 'elevated', 'dangerous'] });
    expect(executionIntentProperties.requiresApproval).toEqual({ type: 'boolean' });
    expect(executionIntentProperties.networkPolicy).toEqual({ type: 'string', enum: ['inherit', 'allow', 'deny', 'scoped'] });
    expect(executionIntentProperties.filesystemPolicy).toEqual({ type: 'string', enum: ['inherit', 'workspace-write', 'read-only', 'isolated'] });
  });

  test('route and automation schemas expose explicit delivery and execution intent fields', () => {
    const routeProperties = objectProperties(ROUTE_BINDING_SCHEMA);
    const runProperties = objectProperties(AUTOMATION_RUN_SCHEMA);

    expect(routeProperties.sessionPolicy).toEqual({
      type: 'string',
      enum: ['create-or-bind', 'continue-existing', 'require-existing'],
    });
    expect(routeProperties.threadPolicy).toEqual({
      type: 'string',
      enum: ['preserve', 'replace', 'detached'],
    });
    expect(routeProperties.deliveryGuarantee).toEqual({
      type: 'string',
      enum: ['best-effort', 'at-least-once'],
    });
    expect(runProperties.executionIntent).toMatchObject({ type: 'object' });
  });
});
