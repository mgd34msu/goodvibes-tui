/**
 * Knowledge emitters — typed wrappers for KnowledgeEvent domain.
 */

import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { KnowledgeEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/knowledge';
import type { EmitterContext } from '@pellux/goodvibes-sdk/platform/runtime/emitters/index';

function knowledgeEvent<T extends KnowledgeEvent['type']>(
  type: T,
  data: Omit<Extract<KnowledgeEvent, { type: T }>, 'type'>,
  ctx: EmitterContext,
): RuntimeEventEnvelope<T, Extract<KnowledgeEvent, { type: T }>> {
  return createEventEnvelope(type, { type, ...data } as Extract<KnowledgeEvent, { type: T }>, ctx);
}

export function emitKnowledgeIngestStarted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sourceId: string; connectorId: string; sourceType: string; uri?: string },
): void {
  bus.emit('knowledge', knowledgeEvent('KNOWLEDGE_INGEST_STARTED', data, ctx));
}

export function emitKnowledgeIngestCompleted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sourceId: string; status: string; artifactId?: string; title?: string },
): void {
  bus.emit('knowledge', knowledgeEvent('KNOWLEDGE_INGEST_COMPLETED', data, ctx));
}

export function emitKnowledgeIngestFailed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sourceId: string; error: string },
): void {
  bus.emit('knowledge', knowledgeEvent('KNOWLEDGE_INGEST_FAILED', data, ctx));
}

export function emitKnowledgeExtractionCompleted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sourceId: string; extractionId: string; format: string; estimatedTokens: number },
): void {
  bus.emit('knowledge', knowledgeEvent('KNOWLEDGE_EXTRACTION_COMPLETED', data, ctx));
}

export function emitKnowledgeExtractionFailed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sourceId: string; error: string },
): void {
  bus.emit('knowledge', knowledgeEvent('KNOWLEDGE_EXTRACTION_FAILED', data, ctx));
}

export function emitKnowledgeCompileCompleted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { sourceId: string; nodeCount: number; edgeCount: number },
): void {
  bus.emit('knowledge', knowledgeEvent('KNOWLEDGE_COMPILE_COMPLETED', data, ctx));
}

export function emitKnowledgeLintCompleted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { issueCount: number },
): void {
  bus.emit('knowledge', knowledgeEvent('KNOWLEDGE_LINT_COMPLETED', data, ctx));
}

export function emitKnowledgePacketBuilt(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { task: string; itemCount: number; estimatedTokens: number; detail: 'compact' | 'standard' | 'detailed' },
): void {
  bus.emit('knowledge', knowledgeEvent('KNOWLEDGE_PACKET_BUILT', data, ctx));
}

export function emitKnowledgeProjectionRendered(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { targetId: string; pageCount: number },
): void {
  bus.emit('knowledge', knowledgeEvent('KNOWLEDGE_PROJECTION_RENDERED', data, ctx));
}

export function emitKnowledgeProjectionMaterialized(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { targetId: string; artifactId: string; pageCount: number },
): void {
  bus.emit('knowledge', knowledgeEvent('KNOWLEDGE_PROJECTION_MATERIALIZED', data, ctx));
}

export function emitKnowledgeJobQueued(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { jobId: string; runId: string; mode: 'inline' | 'background' },
): void {
  bus.emit('knowledge', knowledgeEvent('KNOWLEDGE_JOB_QUEUED', data, ctx));
}

export function emitKnowledgeJobStarted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { jobId: string; runId: string; mode: 'inline' | 'background' },
): void {
  bus.emit('knowledge', knowledgeEvent('KNOWLEDGE_JOB_STARTED', data, ctx));
}

export function emitKnowledgeJobCompleted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { jobId: string; runId: string; durationMs: number },
): void {
  bus.emit('knowledge', knowledgeEvent('KNOWLEDGE_JOB_COMPLETED', data, ctx));
}

export function emitKnowledgeJobFailed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { jobId: string; runId: string; error: string; durationMs: number },
): void {
  bus.emit('knowledge', knowledgeEvent('KNOWLEDGE_JOB_FAILED', data, ctx));
}
