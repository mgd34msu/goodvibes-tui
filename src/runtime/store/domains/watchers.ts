/**
 * Watcher domain state — managed sources that feed automation and routes.
 */

import type { AutomationSourceRecord } from '../../../automation/sources.ts';

export type WatcherKind = 'webhook' | 'polling' | 'filesystem' | 'socket' | 'integration' | 'manual';
export type WatcherState = 'stopped' | 'starting' | 'running' | 'degraded' | 'failed';
export type WatcherSourceStatus = 'healthy' | 'lagging' | 'stale' | 'degraded' | 'failed' | 'unknown';

export interface WatcherRecord {
  readonly id: string;
  readonly kind: WatcherKind;
  readonly label: string;
  readonly state: WatcherState;
  readonly source: AutomationSourceRecord;
  readonly intervalMs?: number;
  readonly lastHeartbeatAt?: number;
  readonly sourceLagMs?: number;
  readonly sourceStatus?: WatcherSourceStatus;
  readonly degradedReason?: string;
  readonly lastCheckpoint?: string;
  readonly lastError?: string;
  readonly metadata: Record<string, unknown>;
}

export interface WatcherDomainState {
  readonly revision: number;
  readonly lastUpdatedAt: number;
  readonly source: string;
  readonly watchers: Map<string, WatcherRecord>;
  readonly watcherIds: string[];
  readonly activeWatcherIds: string[];
  readonly failedWatcherIds: string[];
  readonly totalStarted: number;
  readonly totalStopped: number;
  readonly totalFailed: number;
  readonly totalHeartbeats: number;
  readonly totalDegraded: number;
  readonly totalLagged: number;
}

export function createInitialWatcherState(): WatcherDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    watchers: new Map(),
    watcherIds: [],
    activeWatcherIds: [],
    failedWatcherIds: [],
    totalStarted: 0,
    totalStopped: 0,
    totalFailed: 0,
    totalHeartbeats: 0,
    totalDegraded: 0,
    totalLagged: 0,
  };
}
