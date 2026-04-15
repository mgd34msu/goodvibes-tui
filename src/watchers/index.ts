export type { RegisterWatcherInput, RegisterPollingWatcherInput, WatcherRegistryOptions } from '@pellux/goodvibes-sdk/platform/watchers/registry';
export { WatcherRegistry } from '@pellux/goodvibes-sdk/platform/watchers/registry';
export type { WatcherStoreSnapshot } from '@pellux/goodvibes-sdk/platform/watchers/store';
export {
  getWatcherStorePath,
  loadWatcherSnapshot,
  loadWatcherSnapshotFromPath,
  resolveWatcherStorePath,
  saveWatcherSnapshot,
  saveWatcherSnapshotToPath,
} from '@pellux/goodvibes-sdk/platform/watchers/store';
