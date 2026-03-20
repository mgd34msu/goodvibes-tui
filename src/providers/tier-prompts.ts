/**
 * Tier-based system prompt supplements.
 *
 * Model capability tiers drive how much extra guidance is injected into
 * the system prompt.  All features remain available regardless of tier;
 * only the verbosity of the guidance changes.
 */

import type { ModelTier } from './registry.ts';
export type { ModelTier };

/**
 * Returns supplemental system prompt content based on the model's capability
 * tier.  The returned string is appended to the base system prompt before
 * each LLM call.
 *
 * - free    — explicit tool-call examples, multi-agent reminders, structured
 *             output enforcement (~300 tokens)
 * - standard — brief reminders about tool usage and plan adherence (~80 tokens)
 * - premium  — empty; capable models need no extra hand-holding
 */
export function getTierPromptSupplement(tier: ModelTier): string {
  switch (tier) {
    case 'free':
      return FREE_SUPPLEMENT;
    case 'standard':
      return STANDARD_SUPPLEMENT;
    case 'premium':
      return '';
  }
}

// ---------------------------------------------------------------------------
// Supplement text
// ---------------------------------------------------------------------------

const FREE_SUPPLEMENT = `## Agent Guidance

You are operating in a multi-agent system. Follow these rules carefully:

**Tool calls — required format:**
Every tool call must include ALL required parameters. Missing parameters cause
silent failures. When in doubt, check the tool's schema before calling it.

Example — correct agent spawn:
\`\`\`json
{ "name": "agent", "input": { "task": "<task>", "mode": "engineer" } }
\`\`\`

**Multi-agent workflows:**
When a plan requires multiple parallel agents, spawn ALL of them before
waiting for results — do not spawn one, wait, then spawn the next. Parallel
spawns run concurrently and complete faster.

**Structured output:**
Your final message MUST end with the required JSON completion block. Omitting
it causes the orchestrator to treat your run as failed.

**Plan adherence:**
Complete the full plan. Do not stop after the first step and ask for
confirmation — there is no human watching. Make the best choice and continue.`;

const STANDARD_SUPPLEMENT = `## Reminders
- Include all required parameters in every tool call.
- When spawning agents, use the correct \`mode\` parameter.
- Complete your full plan before reporting results.`;
