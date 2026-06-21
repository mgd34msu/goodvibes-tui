// Public barrel for the inbound inbox surface.
//
// Integration wires this surface the same way as every other daemon surface
// (e.g. routing/triage): it calls the `register(ctx): Unregister` entry point
// from its surface bootstrap and disposes the returned Unregister on shutdown.
// `register` is the SurfaceRegister-shaped wrapper around registerInboxMethods.

export { register, registerInboxMethods, INBOX_LIST_METHOD_ID, INBOX_LIST_SCOPES } from './register.ts';
export type {
  InboxListInput,
  InboxListOutput,
  InboxProviderReport,
  RegisterInboxOptions,
} from './register.ts';

export type {
  InboundChannelItem,
  InboundProviderAdapter,
  ProviderPollOptions,
  ProviderPollResult,
  ProviderState,
  AdapterContext,
  AdapterFactory,
  RouteResolver,
} from './provider-adapter.ts';
export {
  POLL_CADENCE_MS,
  registerAdapterFactory,
  registeredProviderIds,
  buildAdapters,
  clearAdapterRegistry,
} from './provider-adapter.ts';

export { InboxCursorStore } from './cursor-store.ts';
export type { InboxQuery } from './cursor-store.ts';
export { InboundPoller } from './poller.ts';
export type { ProviderStatus, PollerOptions } from './poller.ts';

export { createSlackAdapter } from './providers/slack.ts';
export { createDiscordAdapter } from './providers/discord.ts';
export { createEmailAdapter } from './providers/email.ts';
export {
  ImapClient,
  parseFetchResponse,
  decodeHeader,
  imapDate,
} from './providers/imap-client.ts';
export type { ImapConfig, ImapEnvelope } from './providers/imap-client.ts';

export {
  digestSender,
  stripPii,
  stripMarkup,
  toSubjectPreview,
  toBodyPreview,
  SUBJECT_PREVIEW_MAX,
  BODY_PREVIEW_MAX,
} from './mapping.ts';
