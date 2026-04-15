import type { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts/index';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import type { KnowledgeConnectorRegistry } from '@pellux/goodvibes-sdk/platform/knowledge/connectors';
import type { KnowledgeConnector, KnowledgeIssueRecord } from '@pellux/goodvibes-sdk/platform/knowledge/types';
import type { KnowledgeStore } from '@pellux/goodvibes-sdk/platform/knowledge/store';

export interface KnowledgeIngestContext {
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly connectorRegistry: KnowledgeConnectorRegistry;
  readonly emitIfReady: (
    fn: (bus: RuntimeEventBus, ctx: { readonly traceId: string; readonly sessionId: string; readonly source: string }) => void,
    sessionId?: string,
  ) => void;
  readonly syncReviewedMemory: () => Promise<void>;
  readonly lint: () => Promise<readonly KnowledgeIssueRecord[]>;
  readonly listConnectors: () => readonly KnowledgeConnector[];
}
