/**
 * settings-modal-search — ranked search over the settings workspace.
 *
 * Split out of settings-modal-data.ts, which had reached its 800-line ceiling.
 * Scoring and search are a self-contained unit: they read a SettingEntry and a
 * label function and depend on nothing else in the assembly path, so moving
 * them changes no behavior. Both are re-exported from settings-modal-data.ts,
 * so no import site moved.
 */

import type { SettingEntry, SettingsCategory } from './settings-modal-types.ts';

// ---------------------------------------------------------------------------
// fuzzyScoreSettingEntry — score an entry against a query for ranked search
// ---------------------------------------------------------------------------

/**
 * Score a single SettingEntry against a search query.
 *
 * Score tiers (higher = better match):
 *   - 3000–3999: exact key substring match (3000 + position bonus 0–999)
 *   - 2000–2999: exact label substring match (2000 + position bonus 0–999)
 *   - 1000–1999: exact description substring match (1000 + position bonus 0–999)
 *   - 1–99:      subsequence match across key+label+description
 *
 * Returns null when the query does not match at all.
 *
 * @param query - The search string (already lowercased).
 * @param entry - The setting entry to test.
 * @param getLabel - Pure function mapping an entry to its display label.
 */
export function fuzzyScoreSettingEntry(
  query: string,
  entry: SettingEntry,
  getLabel: (e: SettingEntry) => string,
): number | null {
  if (query.length === 0) return 0;
  const lq = query.toLowerCase();
  const key = entry.setting.key.toLowerCase();
  const label = getLabel(entry).toLowerCase();
  const description = (entry.setting.description ?? '').toLowerCase();

  // Tier 1: key substring — base 3000, position bonus up to 999
  // A key match at position 0 scores 3999; at position 999 scores 3000.
  const keyIdx = key.indexOf(lq);
  if (keyIdx !== -1) return 3000 + Math.max(0, 999 - keyIdx);

  // Tier 2: label substring — base 2000, position bonus up to 999
  const labelIdx = label.indexOf(lq);
  if (labelIdx !== -1) return 2000 + Math.max(0, 999 - labelIdx);

  // Tier 3: description substring — base 1000, position bonus up to 999
  const descIdx = description.indexOf(lq);
  if (descIdx !== -1) return 1000 + Math.max(0, 999 - descIdx);

  // Tier 4: subsequence across concatenated key + label + description — 1..99
  const haystack = `${key} ${label} ${description}`;
  let qi = 0;
  let score = 0;
  for (let ci = 0; ci < haystack.length && qi < lq.length; ci++) {
    if (haystack[ci] === lq[qi]) {
      qi++;
      score++;
    }
  }
  if (qi === lq.length) return Math.min(99, score);
  return null;
}

/**
 * Search all setting entries across all groups, returning results ranked by
 * relevance score (highest first). Excludes the flags, mcp, and subscriptions
 * special categories (which have their own entry types).
 *
 * @param query - User input string. Empty string returns []. 
 * @param groups - The settings group map from buildSettingGroups.
 * @param getLabel - Pure function mapping an entry to its display label.
 */
export function searchSettingEntries(
  query: string,
  groups: Map<SettingsCategory, SettingEntry[]>,
  getLabel: (e: SettingEntry) => string,
): SettingEntry[] {
  if (query.trim().length === 0) return [];
  const lq = query.trim().toLowerCase();
  const seen = new Set<string>();
  const scored: Array<{ entry: SettingEntry; score: number }> = [];
  for (const entries of groups.values()) {
    for (const entry of entries) {
      // Deduplicate: network tab cross-lists keys already in controlPlane/httpListener/web
      if (seen.has(entry.setting.key)) continue;
      seen.add(entry.setting.key);
      const score = fuzzyScoreSettingEntry(lq, entry, getLabel);
      if (score !== null) scored.push({ entry, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(r => r.entry);
}
