export interface ConversationFollowUpItem {
  readonly key: string;
  readonly summary: string;
}

const MAX_BATCH_SIZE = 6;
const MAX_SUMMARY_LENGTH = 240;

function normalizeSummary(summary: string): string {
  const compact = summary.replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_SUMMARY_LENGTH) return compact;
  return `${compact.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}

export function normalizeConversationFollowUpItems(
  items: readonly ConversationFollowUpItem[],
): ConversationFollowUpItem[] {
  const deduped = new Map<string, ConversationFollowUpItem>();
  for (const item of items) {
    const summary = normalizeSummary(item.summary);
    if (!summary) continue;
    deduped.set(item.key, { key: item.key, summary });
  }
  return [...deduped.values()].slice(0, MAX_BATCH_SIZE);
}

export function buildConversationFollowUpPrompt(
  items: readonly ConversationFollowUpItem[],
): string {
  const normalized = normalizeConversationFollowUpItems(items);
  const bullets = normalized.map((item, index) => `${index + 1}. ${item.summary}`);
  return [
    'Background milestones completed since your last reply:',
    ...bullets,
    '',
    'Write 1-2 short sentences for the user acknowledging the update.',
    'Do not ask questions.',
    'Do not mention internal routing, follow-ups, or hidden notifications.',
    'Do not call tools.',
    'Be concise and factual.',
  ].join('\n');
}
