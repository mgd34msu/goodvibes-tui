// ---------------------------------------------------------------------------
// Public surface for the daemon-internal Email Auto-Tag / Spam Triage handler.
//
// `registerTriagedInbox` (from ./integration.ts) is the single entry the
// runtime composition root calls. It DECORATES the inbox surface's
// `channels.inbox.list` handler (overlaying persisted triage metadata) and
// returns the poller-facing pipeline + tagger. inbox.triage.* are NOT published
// catalog methods — this surface registers no triage method id.
// ---------------------------------------------------------------------------

export {
  scoreInboundItem,
  labelToTag,
  type TriageScore,
  type TriageScorerOptions,
} from './scorer.ts';

export type {
  InboundChannelItem,
  TriageLabel,
  ConversationKind,
} from './types.ts';

export {
  runInboxTriage,
  createTriageStore,
  readTriageMetadata,
  readTriageMetadataBatch,
  enrichItemsWithTriage,
  TRIAGE_STORE_FILE,
  type TriageMetadata,
  type TriagedItem,
  type TriageOverlay,
  type TriageEnrichedItem,
  type RunInboxTriageOptions,
  type RunInboxTriageResult,
} from './pipeline.ts';

export {
  createTriageTagger,
  TRIAGE_AUTOTAG_FLAG,
  type TriageTagger,
  type TriageTaggerOptions,
  type TaggerProviderConfig,
  type ApplyTagsRequest,
  type ApplyTagsResult,
  type ImapStoreArgs,
  type ImapRetryOptions,
} from './tagger/index.ts';

export {
  registerTriagedInbox,
  INBOX_LIST_METHOD_ID,
  type RegisterInbox,
  type RegisterTriagedInboxOptions,
  type TriagedInboxRegistration,
} from './integration.ts';
