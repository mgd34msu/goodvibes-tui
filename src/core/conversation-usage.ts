/**
 * conversation-usage.ts, usage totals folded from a transcript's assistant
 * messages (re-exported by conversation.ts).
 *
 * The fold is the SDK's (platform/core sumConversationUsage): a resumed
 * session hydrates its token counters and its context figure from it. The
 * context figure is the latest real turn request's; a follow-up
 * acknowledgement (sent without tool definitions) counts toward the totals
 * only, so the meter never drops to that smaller request's size.
 */

export { sumConversationUsage } from '@pellux/goodvibes-sdk/platform/core';
