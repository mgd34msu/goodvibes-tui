/**
 * channels.drafts.* handler surface barrel.
 *
 * Re-exports only the concrete register entrypoint and the store/types other
 * code may need. It imports concrete submodules (no project index barrels), so
 * it introduces no import cycle.
 */
export { registerDraftMethods } from './register.ts';
export type { RegisterDraftsOptions } from './register.ts';
export { DraftSyncStore, sha256First, redactWebhook } from './draft-store.ts';
export type {
  DraftListQuery,
  DraftRecord,
  DraftSaveInput,
  DraftSaveResult,
  DraftStatus,
} from './draft-store.ts';
