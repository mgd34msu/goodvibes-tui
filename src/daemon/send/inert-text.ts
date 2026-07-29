/**
 * inert-text.ts — make a message arrive as LITERAL TEXT on whichever channel
 * `goodvibes-daemon send` delivers it to.
 *
 * ## What "inert" means here, and why it is per (surface × transport), not
 * per surface
 *
 * The transform a surface needs depends on what the delivery strategy in
 * `platform/channels/delivery/strategies-core.ts` actually does with the body,
 * not on what the surface is capable of parsing. Two examples that pull in
 * opposite directions:
 *
 *  - Telegram's `sendMessage` CAN parse MarkdownV2, but the strategy sends with
 *    NO `parse_mode`, which is Telegram's plain-text mode. Running a MarkdownV2
 *    escaper over the body on this path would not protect anything — it would
 *    put visible backslashes in front of every `.` `-` `!` `(` in the owner's
 *    message. The correct transform is identity, and the property that makes it
 *    correct is asserted by a test against the real wire payload rather than
 *    asserted here in prose (see src/test/daemon/send-command-wire.test.ts).
 *
 *  - Discord's `postMessage` renders markdown unconditionally, INCLUDING masked
 *    links, so the same body needs real escaping.
 *
 * A single "escape for channel X" table that ignored the transport would get
 * Telegram wrong in the direction that mangles the owner's text, and would get
 * Discord wrong in the direction that renders a link. Hence the split below.
 *
 * ## Provenance of the escaper bodies
 *
 * `escapeDiscordMarkdown` and `escapeSlackMrkdwn` are the escapers written for
 * the inbound-mail structured notices, in the SDK at
 * `packages/sdk/src/platform/email/inbound-notice.ts` — same character classes,
 * same zero-width-space mention break, same rationale. They are reproduced here
 * rather than imported for one reason: that module lives on the unmerged
 * `inbound-email-*` branches and is absent from the published
 * `@pellux/goodvibes-sdk@1.18.1` this product consumes, so there is nothing to
 * import yet.
 *
 * This is a second copy and that is a defect, not a design. When the
 * inbound-mail round merges and an SDK release publishes `platform/email`'s
 * notice escapers, THIS FILE'S `escapeDiscordMarkdown` and `escapeSlackMrkdwn`
 * are to be deleted and the SDK's imported in their place; the surface-kind
 * table below is the only part that should survive that change. The behaviour
 * is pinned by tests either way, so the swap is verifiable rather than hopeful.
 */

import type { ChannelDeliverySurfaceKind } from '@pellux/goodvibes-sdk/platform/channels';

/**
 * Zero-width space. Used to break a token that a surface would otherwise read
 * as syntax, on surfaces that offer no backslash escape (Slack) or where
 * backslash-escaping demonstrably does not defeat the token (Discord mentions).
 */
const ZERO_WIDTH_SPACE = '​';

/**
 * `@everyone`, `@here`, and raw role/channel/user mentions. Backslash-escaping
 * the `@` does NOT reliably suppress these in every Discord client, so the
 * zero-width break is used instead.
 */
function breakMentionForms(text: string): string {
  return text
    .replace(/@(everyone|here)/g, (_match, word: string) => `@${ZERO_WIDTH_SPACE}${word}`)
    .replace(/<@[!&]?(\d+)>/g, (_match, id: string) => `<@${ZERO_WIDTH_SPACE}${id}>`)
    .replace(/<#(\d+)>/g, (_match, id: string) => `<#${ZERO_WIDTH_SPACE}${id}>`);
}

/**
 * Discord markdown. Backslash-escaping `* _ ~ \` |` and `>` renders each as its
 * literal character rather than triggering bold/italic/strikethrough/code/
 * spoiler/quote.
 *
 * `[` `]` `(` `)` are escaped too, and this is REQUIRED rather than
 * precautionary: masked links (`[text](url)`) DO render as clickable in
 * bot-sent and webhook messages — which is exactly how this product delivers to
 * Discord — even though they do not render for text a human typed into the
 * client.
 *   https://github.com/discord/discord-api-docs/issues/6096
 *   https://gist.github.com/matthewzring/9f7bbfd102003963f9be7dbcf7d40e51
 *
 * Without this, a message body assembled from anything the owner did not type
 * arrives in his Discord as a clickable link reading whatever the body said.
 * An escaper that looks optional gets tidied away by the next reader: it is not
 * optional, and it stays.
 *
 * `\` is inside the character class, so a backslash in the input is escaped
 * first and cannot un-escape what follows it.
 */
function escapeDiscordMarkdown(text: string): string {
  return breakMentionForms(text.replace(/[*_~`|>[\]()\\]/g, (ch) => `\\${ch}`));
}

/**
 * Slack mrkdwn. `&`, `<`, `>` MUST be HTML-entity-escaped per Slack's own
 * formatting reference. That is also what defeats `<url|text>` link syntax and
 * `<!channel>` / `<@id>` mention syntax outright, since both require a literal
 * unescaped `<`.
 *
 * Slack has no backslash escape for `* _ ~ \``, so the zero-width break is
 * applied to those as the best available mitigation — stated as a mitigation,
 * not a guarantee, because Slack's whitespace-adjacency rule for what breaks a
 * delimiter pair is not publicly specified to that precision. The residual risk
 * is cosmetic (accidental bold/italic); the injection class this exists to
 * close — a clickable link or a real mention — is closed by the entity escaping
 * above.
 */
function escapeSlackMrkdwn(text: string): string {
  const entityEscaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return entityEscaped.replace(/[*_~`]/g, (ch) => `${ch}${ZERO_WIDTH_SPACE}`);
}

/**
 * Google Chat's `text` field renders `*bold*`, `_italic_`, `~strike~`,
 * `` `code` `` and `<url|text>` links. The `<` entity escape is what defeats
 * the link and `<users/all>` mention forms; the delimiters get the zero-width
 * break, as Google Chat documents no backslash escape either.
 */
function escapeGoogleChatMarkup(text: string): string {
  const entityEscaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return entityEscaped.replace(/[*_~`]/g, (ch) => `${ch}${ZERO_WIDTH_SPACE}`);
}

/**
 * WhatsApp Cloud API text messages render `*bold*`, `_italic_`, `~strike~` and
 * ```` ```mono``` ````. There is no masked-link syntax — a URL in the body is
 * auto-linked showing its real address — so the injection class Discord has
 * does not exist here and only the delimiters need neutralizing. WhatsApp
 * documents no backslash escape, so the zero-width break is used.
 */
function escapeWhatsAppMarkup(text: string): string {
  return text.replace(/[*_~`]/g, (ch) => `${ch}${ZERO_WIDTH_SPACE}`);
}

/**
 * The surfaces whose delivery strategy hands the body to a renderer that parses
 * markup. Every other routable surface is absent DELIBERATELY, and each absence
 * is a checked claim about the strategy, not an oversight:
 *
 *  - `telegram`  — `sendMessage` without `parse_mode`; Telegram's plain-text
 *                  mode. Escaping here would corrupt, not protect.
 *  - `ntfy`      — `publish` sends the body as `text/plain` and never sets the
 *                  `Markdown` header, so ntfy renders it literally. The title
 *                  is derived by `titleFromBody` (first non-empty LINE) and
 *                  passed through `toHeaderSafeTitle`, so no line break or
 *                  non-ASCII byte from the body can reach an HTTP header.
 *  - `webhook`   — the body is a JSON string field; the receiver decides what
 *                  to do with it and there is no markup layer to neutralize.
 *
 *  - `signal`    — the strategy posts `text` to a signal bridge. Signal renders
 *                  no markup in a plain message body; styling travels as
 *                  explicit range metadata the strategy never sends.
 *  - `imessage`,
 *    `bluebubbles` — both end at iMessage, which renders no markup at all.
 *  - `msteams`   — the strategy sends `textFormat: 'plain'` alongside the text,
 *                  which is Teams' own instruction not to parse it.
 *  - `matrix`    — `msgtype: 'm.text'` with no `format`/`formatted_body`. A
 *                  Matrix event without the HTML format field is rendered
 *                  literally by clients, per the spec.
 *
 * `web` is absent for a different reason: its strategy needs a live
 * `ControlPlaneGateway` in the same process, which a short-lived CLI does not
 * have, so the command does not offer it as a channel at all. `telephony` is
 * absent because a CLI `send` to it would place a phone call or an SMS through
 * a paid carrier — a different act from messaging a channel — and because the
 * strategy already XML-escapes the voice path itself via `escapeTwiml`.
 */
const INERT_TRANSFORMS: Partial<Record<ChannelDeliverySurfaceKind, (text: string) => string>> = {
  // Renders markup, including a masked link: full escaping.
  discord: escapeDiscordMarkdown,
  mattermost: escapeDiscordMarkdown,
  // Renders markup, but has no masked-link syntax: delimiters only.
  slack: escapeSlackMrkdwn,
  'google-chat': escapeGoogleChatMarkup,
  whatsapp: escapeWhatsAppMarkup,
  // Delivered as plain text by the strategy: transforming would corrupt, not
  // protect. Each of these is a checked claim about the strategy, not a guess —
  // see the list above.
  telegram: (text) => text,
  ntfy: (text) => text,
  webhook: (text) => text,
  signal: (text) => text,
  imessage: (text) => text,
  bluebubbles: (text) => text,
  msteams: (text) => text,
  matrix: (text) => text,
};

/** Surfaces `goodvibes-daemon send` will deliver to, in a stable display order. */
export const INERT_RENDERABLE_SURFACE_KINDS: readonly ChannelDeliverySurfaceKind[] = [
  'telegram', 'ntfy', 'discord', 'slack', 'google-chat', 'webhook',
  'signal', 'whatsapp', 'imessage', 'msteams', 'bluebubbles', 'mattermost', 'matrix',
];

/**
 * Whether this surface has a verified inert transform.
 *
 * A surface with no entry gets a refusal from the send command, never an
 * untransformed body. Returning the body unchanged for an unknown surface is
 * precisely how a markup-rendering channel acquires a live link: the default
 * has to be "refuse", and it has to be checkable from the caller.
 */
export function canRenderInert(surfaceKind: ChannelDeliverySurfaceKind): boolean {
  return Object.prototype.hasOwnProperty.call(INERT_TRANSFORMS, surfaceKind);
}

/**
 * Render `text` so it arrives on `surfaceKind` as the literal characters the
 * caller supplied.
 *
 * Throws for a surface with no verified transform. This function has no
 * "pass it through" branch and must never grow one: every caller of the send
 * command reaches the world through here, so a permissive fallback would make
 * the command a way to put live markup on the owner's phone.
 */
export function inertBodyFor(surfaceKind: ChannelDeliverySurfaceKind, text: string): string {
  const transform = INERT_TRANSFORMS[surfaceKind];
  if (!transform) {
    throw new Error(
      `No verified inert-text transform for surface '${surfaceKind}'. `
      + 'Sending would risk the message being rendered as markup rather than as text, '
      + `so nothing was sent. Supported: ${INERT_RENDERABLE_SURFACE_KINDS.join(', ')}.`,
    );
  }
  return transform(text);
}
