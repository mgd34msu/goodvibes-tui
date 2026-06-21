// ---------------------------------------------------------------------------
// Barrel for the daemon-internal Email Auto-Tag / Spam Triage surface.
//
// Daemon-internal ONLY: inbox.triage.list and inbox.triage.tag register with
// transport ['internal'] and are absent from the agent-facing WS method list.
//
// Wiring contract: the daemon integration layer (src/runtime/services.ts, the
// single allowed edit site there) wires this surface in one of two ways:
//   - `registerTriageMethods(ctx)` (alias of `register`) to expose just the
//     internal triage methods; or
//   - `registerTriagedInbox(ctx)` to compose triage WITH the inbox surface so
//     channels.inbox.list returns pre-scored items (the full contract loop).
// Either returns an Unregister the integration retains for teardown.
// ---------------------------------------------------------------------------

export {
  scoreInboundItem,
  labelToTag,
  type TriageLabel,
  type TriageScore,
  type TriageScorerOptions,
} from './scorer.ts';

export {
  runInboxTriage,
  createTriageStore,
  readTriageMetadata,
  enrichItemsWithTriage,
  TRIAGE_STORE_FILE,
  type TriageMetadata,
  type TriagedItem,
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
} from './tagger.ts';

export {
  register,
  registerTriageMethods,
  createTriageRegister,
  TRIAGE_METHOD_IDS,
  type RegisterTriageOptions,
} from './register.ts';

export {
  registerTriagedInbox,
  type RegisterTriagedInboxOptions,
} from './integration.ts';
