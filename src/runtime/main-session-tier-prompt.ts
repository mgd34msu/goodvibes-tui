/**
 * main-session-tier-prompt.ts, the tier guidance the main interactive session
 * adds to its system prompt.
 *
 * The SDK's getTierPromptSupplement() is written for spawned agents: its
 * small-context ('free') text tells the model its final message MUST end with
 * "the required JSON completion block" or the run counts as failed, and that
 * "there is no human watching". The main session is a person's conversation,
 * so a small-context model obeyed and closed its reply with
 * ```json {"status":"completed"} ```, which the transcript then drew under
 * the answer. The main session keeps the tool-call guidance and drops what
 * only an agent run owes its controller.
 */

import { getTierPromptSupplement } from '@pellux/goodvibes-sdk/platform/providers';

export type MainSessionTier = Parameters<typeof getTierPromptSupplement>[0];

/** Small-context guidance for a conversation with a person: tool-call discipline only. */
export const MAIN_SESSION_FREE_SUPPLEMENT = `## Tool guidance

Every tool call must include ALL required parameters. Missing parameters cause
silent failures. When in doubt, check the tool's schema before calling it.

When work needs several independent agents, spawn all of them before waiting
for any result: parallel spawns run concurrently and finish sooner.`;

/**
 * The supplement the main session's system prompt carries for a model tier.
 * Never asks for a completion report, a JSON block, or unattended behavior.
 */
export function mainSessionTierSupplement(tier: MainSessionTier): string {
  return tier === 'free' ? MAIN_SESSION_FREE_SUPPLEMENT : getTierPromptSupplement(tier);
}
