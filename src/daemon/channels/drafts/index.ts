// Surface barrel: Draft Sync Backend (channels.drafts.*).
// Integration calls registerDraftsMethods(ctx) to publish the four methods.

export { registerDraftsMethods } from './register.ts';
export type { RegisterDraftsOptions } from './register.ts';

export { DraftSyncStore } from './draft-store.ts';
export type {
  DraftRecord,
  DraftStatus,
  DraftSaveInput,
  DraftSaveResult,
  DraftListQuery,
  DraftSyncStoreOptions,
} from './draft-store.ts';
export {
  ALL_DRAFT_STATUSES,
  WRITABLE_DRAFT_STATUSES,
  DEFAULT_DRAFT_LIST_LIMIT,
  MAX_DRAFT_LIST_LIMIT,
  DRAFT_MESSAGE_DIGEST_HEX,
} from './draft-store.ts';
