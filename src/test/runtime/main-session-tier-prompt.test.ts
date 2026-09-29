/**
 * The main session's system prompt never asks the model for an agent-run
 * completion report.
 *
 * Live run on 14d4e369: with an 8.2k context window the model is 'free' tier,
 * and the main session appended the SDK's agent supplement, which says the
 * final message "MUST end with the required JSON completion block". The model
 * obeyed and ended its answer with ```json {"status":"completed"} ```, which
 * the transcript drew under the answer. The SDK now carries a conversational
 * variant (audience: 'conversation'), and the main session asks for it.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getTierPromptSupplement } from '@pellux/goodvibes-sdk/platform/providers';

const TIERS = ['free', 'standard', 'premium', 'subscription'] as const;
const REPORT_DEMAND = /completion (block|report)|json block|```json|no human watching/i;
const conversation = (tier: (typeof TIERS)[number]) => getTierPromptSupplement(tier, { audience: 'conversation' });

describe('main session tier guidance', () => {
  test('no tier asks a conversation for a JSON completion block or unattended behavior', () => {
    for (const tier of TIERS) expect(conversation(tier)).not.toMatch(REPORT_DEMAND);
  });

  test('the small-context tier keeps the tool-call guidance', () => {
    expect(conversation('free')).toContain('required parameters');
  });

  test('the SDK agent supplement is the one that carries the demand (why the main session asks for the conversation one)', () => {
    expect(getTierPromptSupplement('free')).toMatch(REPORT_DEMAND);
  });

  test('the main session prompt is composed from the conversation supplement, not the agent one', () => {
    const source = readFileSync(new URL('../../runtime/bootstrap.ts', import.meta.url), 'utf8');
    expect(source).toContain("getTierPromptSupplement(tier, { audience: 'conversation' })");
    expect(source).not.toMatch(/getTierPromptSupplement\s*\(\s*tier\s*\)/);
  });
});
