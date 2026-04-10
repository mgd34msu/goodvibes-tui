/**
 * WatcherEvent — discriminated union covering managed watcher and listener lifecycle events.
 */

export const WATCHER_SOURCE_KINDS = ['poll', 'webhook', 'tail', 'file', 'api', 'stream'] as const;

export type WatcherSourceKind = (typeof WATCHER_SOURCE_KINDS)[number];

export type WatcherEvent =
  | {
      type: 'WATCHER_STARTED';
      watcherId: string;
      sourceKind: WatcherSourceKind;
      name: string;
    }
  | {
      type: 'WATCHER_HEARTBEAT';
      watcherId: string;
      sourceKind: WatcherSourceKind;
      seenAt: number;
      checkpoint: string;
    }
  | {
      type: 'WATCHER_CHECKPOINT_ADVANCED';
      watcherId: string;
      sourceKind: WatcherSourceKind;
      checkpoint: string;
    }
  | {
      type: 'WATCHER_FAILED';
      watcherId: string;
      sourceKind: WatcherSourceKind;
      error: string;
      retryable: boolean;
    }
  | {
      type: 'WATCHER_STOPPED';
      watcherId: string;
      sourceKind: WatcherSourceKind;
      reason: string;
    };

export type WatcherEventType = WatcherEvent['type'];
