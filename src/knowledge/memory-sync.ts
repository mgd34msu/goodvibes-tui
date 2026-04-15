import type { MemoryRecord, MemoryRegistry } from '@pellux/goodvibes-sdk/platform/state/index';
import type { KnowledgeStore } from '@pellux/goodvibes-sdk/platform/knowledge/store';
import { slugify } from '@pellux/goodvibes-sdk/platform/knowledge/internal';

export async function syncKnowledgeMemoryNodes(
  store: KnowledgeStore,
  registry: Pick<MemoryRegistry, 'getAll' | 'getStore'>,
): Promise<void> {
  await registry.getStore().init();
  const memoryRecords = registry.getAll().filter((record) => record.reviewState !== 'contradicted');
  for (const record of memoryRecords) {
    await upsertKnowledgeMemoryNode(store, record);
  }
}

async function upsertKnowledgeMemoryNode(store: KnowledgeStore, record: MemoryRecord): Promise<void> {
  const node = await store.upsertNode({
    id: `memory-${record.id}`,
    kind: 'memory',
    slug: slugify(record.id),
    title: record.summary,
    summary: record.detail ?? record.summary,
    aliases: record.tags,
    status: record.reviewState === 'stale' ? 'stale' : 'active',
    confidence: record.confidence,
    metadata: {
      memoryId: record.id,
      scope: record.scope,
      cls: record.cls,
      reviewState: record.reviewState,
    },
  });

  for (const tag of record.tags) {
    const topicNode = await store.upsertNode({
      kind: 'topic',
      slug: slugify(tag),
      title: tag,
      summary: `Topic tag ${tag}.`,
      aliases: [tag],
      metadata: { tag },
    });
    await store.upsertEdge({
      fromKind: 'node',
      fromId: node.id,
      toKind: 'node',
      toId: topicNode.id,
      relation: 'memory_tagged_with',
    });
  }

  for (const provenance of record.provenance) {
    if (provenance.kind !== 'session') continue;
    await store.upsertEdge({
      fromKind: 'node',
      fromId: node.id,
      toKind: 'session',
      toId: provenance.ref,
      relation: 'derived_from_session',
    });
  }
}
