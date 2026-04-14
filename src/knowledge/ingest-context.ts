import type { ArtifactStore } from '../artifacts/index.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import type { KnowledgeConnectorRegistry } from './connectors.ts';
import type { KnowledgeConnector, KnowledgeIssueRecord } from './types.ts';
import type { KnowledgeStore } from './store.ts';

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
