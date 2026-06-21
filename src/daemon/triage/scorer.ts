// ---------------------------------------------------------------------------
// Daemon-internal email auto-tag / spam triage SCORER.
//
// Pure, dependency-free heuristic + naive-Bayes-style spam/priority scoring
// over an InboundChannelItem's textual surface (subject + snippet). No I/O,
// no credentials, no network — safe to run on every polled item.
//
// The score is a normalized 0..1 confidence in the assigned label. The label
// is one of 'spam' | 'priority' | 'normal'. Scoring is deterministic so the
// pipeline can persist stable triageScore/triageTags values across polls.
// ---------------------------------------------------------------------------

import type { InboundChannelItem } from '../operator/index.ts';

export type TriageLabel = 'spam' | 'priority' | 'normal';

export interface TriageScore {
  /** Confidence in the assigned label, 0..1 (2-decimal rounded). */
  score: number;
  label: TriageLabel;
  /** Raw component probabilities (for diagnostics / tests). */
  signals: {
    spam: number; // 0..1 P(spam)
    priority: number; // 0..1 P(priority)
  };
}

export interface TriageScorerOptions {
  /** Minimum P(spam) to label an item 'spam'. Default 0.65. */
  spamThreshold?: number;
  /** Minimum P(priority) to label an item 'priority'. Default 0.6. */
  priorityThreshold?: number;
  /** Extra spam lexicon terms (lowercased) merged with the defaults. */
  extraSpamTerms?: readonly string[];
  /** Extra priority lexicon terms (lowercased) merged with the defaults. */
  extraPriorityTerms?: readonly string[];
}

const DEFAULT_SPAM_THRESHOLD = 0.65;
const DEFAULT_PRIORITY_THRESHOLD = 0.6;

// Tokens that, when present, push toward spam. Weighted log-likelihoods.
const SPAM_TERMS: ReadonlyMap<string, number> = new Map([
  ['viagra', 3.2],
  ['lottery', 2.8],
  ['winner', 2.0],
  ['congratulations', 1.4],
  ['prize', 2.2],
  ['free', 1.1],
  ['cash', 1.6],
  ['bitcoin', 1.5],
  ['crypto', 1.2],
  ['investment', 1.0],
  ['guarantee', 1.3],
  ['guaranteed', 1.5],
  ['risk-free', 2.0],
  ['click', 1.2],
  ['unsubscribe', 0.9],
  ['limited', 0.9],
  ['offer', 1.0],
  ['act now', 2.2],
  ['urgent', 0.7],
  ['wire transfer', 2.6],
  ['nigerian', 2.6],
  ['inheritance', 2.4],
  ['million', 1.4],
  ['pharmacy', 2.2],
  ['pills', 2.0],
  ['loan', 1.4],
  ['debt', 1.2],
  ['refinance', 1.6],
  ['casino', 2.4],
  ['earn money', 2.2],
  ['work from home', 1.8],
  ['100% free', 2.4],
  ['no cost', 1.6],
  ['cheap', 1.2],
  ['discount', 0.8],
  ['weight loss', 2.0],
  ['verify your account', 2.6],
  ['suspended', 1.4],
  ['password', 1.0],
  ['confirm your identity', 2.4],
]);

// Tokens that push toward priority/important.
const PRIORITY_TERMS: ReadonlyMap<string, number> = new Map([
  ['urgent', 2.4],
  ['asap', 2.4],
  ['immediately', 2.0],
  ['deadline', 2.0],
  ['today', 1.2],
  ['eod', 1.6],
  ['important', 1.6],
  ['action required', 2.2],
  ['action needed', 2.2],
  ['please respond', 1.8],
  ['please reply', 1.8],
  ['waiting', 1.0],
  ['follow up', 1.2],
  ['follow-up', 1.2],
  ['reminder', 1.0],
  ['overdue', 2.2],
  ['blocker', 2.0],
  ['blocked', 1.6],
  ['escalation', 2.2],
  ['escalate', 2.0],
  ['critical', 2.4],
  ['emergency', 2.6],
  ['payment due', 2.0],
  ['invoice', 1.2],
  ['signature', 1.0],
  ['approval', 1.4],
  ['approve', 1.4],
  ['meeting', 0.8],
  ['call me', 1.6],
]);

const URL_PATTERN = /https?:\/\/[^\s]+/gi;
const MONEY_PATTERN = /(?:[$£€]\s?\d|(?:\d[\d,]*)\s?(?:usd|eur|gbp|dollars|euros))/i;
const EXCESSIVE_PUNCT = /[!?]{2,}/;

function normalizeText(item: InboundChannelItem): string {
  const subject = typeof item.subject === 'string' ? item.subject : '';
  const snippet = typeof item.snippet === 'string' ? item.snippet : '';
  // Subject is weighted more heavily by duplicating it once.
  return `${subject} ${subject} ${snippet}`.trim();
}

function countLexicon(text: string, lexicon: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const [term, weight] of lexicon) {
    if (term.includes(' ')) {
      // Phrase match: count non-overlapping occurrences.
      let from = 0;
      let idx = text.indexOf(term, from);
      while (idx !== -1) {
        total += weight;
        from = idx + term.length;
        idx = text.indexOf(term, from);
      }
    } else {
      // Word-boundary match for single tokens.
      const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'g');
      const matches = text.match(re);
      if (matches) total += weight * matches.length;
    }
  }
  return total;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upperCaseRatio(text: string): number {
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length < 8) return 0;
  let upper = 0;
  for (const ch of letters) {
    if (ch >= 'A' && ch <= 'Z') upper += 1;
  }
  return upper / letters.length;
}

function urlDensity(text: string): number {
  const urls = text.match(URL_PATTERN);
  const urlCount = urls ? urls.length : 0;
  const words = text.split(/\s+/).filter((w) => w.length > 0).length || 1;
  return urlCount / words;
}

/** Logistic squash of an accumulated log-likelihood into 0..1. */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Score a single inbound item for spam likelihood and priority likelihood,
 * then resolve a single label. Deterministic and side-effect free.
 */
export function scoreInboundItem(
  item: InboundChannelItem,
  options: TriageScorerOptions = {},
): TriageScore {
  const spamThreshold = options.spamThreshold ?? DEFAULT_SPAM_THRESHOLD;
  const priorityThreshold = options.priorityThreshold ?? DEFAULT_PRIORITY_THRESHOLD;

  const spamLexicon = mergeLexicon(SPAM_TERMS, options.extraSpamTerms, 1.5);
  const priorityLexicon = mergeLexicon(PRIORITY_TERMS, options.extraPriorityTerms, 1.5);

  const raw = normalizeText(item);
  const text = raw.toLowerCase();

  // ---- Spam evidence -----------------------------------------------------
  // Bias term tuned so a clean message lands well below the threshold.
  let spamLL = -2.4;
  spamLL += countLexicon(text, spamLexicon);

  const caps = upperCaseRatio(raw);
  if (caps > 0.6) spamLL += 1.8;
  else if (caps > 0.4) spamLL += 0.9;

  const density = urlDensity(text);
  if (density > 0.25) spamLL += 1.6;
  else if (density > 0.1) spamLL += 0.8;

  if (MONEY_PATTERN.test(raw)) spamLL += 0.8;
  if (EXCESSIVE_PUNCT.test(raw)) spamLL += 0.6;
  if (raw.length === 0) spamLL -= 1.0; // empty/no-text items are not spam

  const spam = clamp01(sigmoid(spamLL));

  // ---- Priority evidence -------------------------------------------------
  let priorityLL = -2.2;
  priorityLL += countLexicon(text, priorityLexicon);

  // Direct conversations (1:1 DMs) are inherently more likely to be priority.
  if (item.conversationKind === 'direct') priorityLL += 0.8;
  if (item.unread === true) priorityLL += 0.3;
  // A trailing question mark suggests an awaited answer.
  if (/\?\s*$/.test(raw)) priorityLL += 0.5;

  // Spam strongly suppresses priority — promotional text is rarely urgent.
  priorityLL -= spam * 2.5;

  const priority = clamp01(sigmoid(priorityLL));

  // ---- Label resolution --------------------------------------------------
  let label: TriageLabel = 'normal';
  let score: number;
  if (spam >= spamThreshold && spam >= priority) {
    label = 'spam';
    score = spam;
  } else if (priority >= priorityThreshold) {
    label = 'priority';
    score = priority;
  } else {
    label = 'normal';
    // Confidence in 'normal' is how far both signals sit below their gates.
    score = clamp01(1 - Math.max(spam, priority));
  }

  return {
    score: round2(score),
    label,
    signals: { spam: round2(spam), priority: round2(priority) },
  };
}

function mergeLexicon(
  base: ReadonlyMap<string, number>,
  extra: readonly string[] | undefined,
  extraWeight: number,
): ReadonlyMap<string, number> {
  if (!extra || extra.length === 0) return base;
  const merged = new Map(base);
  for (const term of extra) {
    const key = term.trim().toLowerCase();
    if (key.length === 0) continue;
    merged.set(key, Math.max(merged.get(key) ?? 0, extraWeight));
  }
  return merged;
}

/** Map a label to the canonical provider-side tag string applied by the tagger. */
export function labelToTag(label: TriageLabel): string {
  switch (label) {
    case 'spam':
      return 'GoodVibes/Spam';
    case 'priority':
      return 'GoodVibes/Priority';
    default:
      return 'GoodVibes/Normal';
  }
}
