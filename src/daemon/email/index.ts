// ---------------------------------------------------------------------------
// Email operator-method surface barrel.
//
// Integration wires this surface by calling registerEmailMethods(ctx) once and
// retaining the returned Unregister. Connectors and pure helpers are re-exported
// for daemon-internal reuse and unit testing.
// ---------------------------------------------------------------------------

export { registerEmailMethods, resolveEmailSettings } from './register.ts';
export type {
  ResolvedEmailSettings,
  EmailMethodsOptions,
  ImapClient,
  SmtpClient,
} from './register.ts';

export {
  ImapConnector,
  ImapError,
  toImapSearchDate,
  quoteImapString,
  parseSearchUids,
  parseAppendUid,
  parseEnvelope,
  parseFetchSummaries,
  parseFullMessage,
  parseAddressList,
  parseMimeMessage,
  splitHeadersBody,
  tokenizeParen,
  extractParenValue,
  extractLiteralFor,
  unescapeImapString,
  decodeTransferEncoding,
  decodeQuotedPrintable,
  decodeMimeWords,
  stripHtml,
  collapseWhitespace,
} from './imap-connector.ts';
export type {
  ImapConnectionSettings,
  ImapEnvelopeSummary,
  ImapFullMessage,
  ImapAttachmentSummary,
  ImapListOptions,
  ImapAppendResult,
  ParsedMime,
} from './imap-connector.ts';

export {
  SmtpConnector,
  SmtpError,
  extractCompleteReply,
  extractAddress,
  parseRecipients,
  dotStuff,
  generateMessageId,
  buildRfc5322Message,
  encodeHeaderValue,
  formatRfc2822Date,
  encodeQuotedPrintable,
} from './smtp-connector.ts';
export type {
  SmtpConnectionSettings,
  SmtpMessage,
  SmtpSendResult,
  Rfc5322Parts,
} from './smtp-connector.ts';
