/**
 * The main session's system prompt never asks the model for an agent-run
 * completion report.
 *
 * Live run on 14d4e369: with an 8.2k context window the model is 'free' tier,
 * and the main session appended the SDK's agent supplement, which says the
 * final message "MUST end with the required JSON completion block". The model
 * obeyed and ended its answer with ```json {"status":"completed"} ```, which
 * the transcript drew under the answer.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getTierPromptSupplement } from '@pellux/goodvibes-sdk/platform/providers';
import { MAIN_SESSION_FREE_SUPPLEMENT, mainSessionTierSupplement } from '../../runtime/main-session-tier-prompt.ts';

const TIERS = ['free', 'standard', 'premium', 'subscription'] as const;
const REPORT_DEMAND = /completion (block|report)|json block|```json|no human watching/i;

describe('main session tier guidance', () => {
  test('no tier asks for a JSON completion block or unattended behavior', () => {
    for (const tier of TIERS) expect(mainSessionTierSupplement(tier)).not.toMatch(REPORT_DEMAND);
  });

  test('the small-context tier keeps the tool-call guidance', () => {
    expect(mainSessionTierSupplement('free')).toBe(MAIN_SESSION_FREE_SUPPLEMENT);
    expect(MAIN_SESSION_FREE_SUPPLEMENT).toContain('required parameters');
  });

  test('the SDK agent supplement is the one that carries the demand (why the main session has its own)', () => {
    expect(getTierPromptSupplement('free')).toMatch(REPORT_DEMAND);
  });

  test('the main session prompt is composed from the main-session supplement, not the agent one', () => {
    const source = readFileSync(new URL('../../runtime/bootstrap.ts', import.meta.url), 'utf8');
    expect(source).toContain('mainSessionTierSupplement(tier)');
    expect(source).not.toMatch(/getTierPromptSupplement\s*\(/);
  });
});
