import type { PermissionAuditEntry } from './policy-runtime.ts';

export interface PermissionRuleSuggestion {
  readonly id: string;
  readonly tool: string;
  readonly command: string;
  readonly summary: string;
  readonly reason: string;
}

export function buildPermissionRuleSuggestions(
  audit: readonly PermissionAuditEntry[],
): PermissionRuleSuggestion[] {
  const denied = audit.filter((entry) => entry.approved === false);
  const grouped = new Map<string, PermissionAuditEntry[]>();
  for (const entry of denied) {
    const key = `${entry.tool}:${entry.target ?? entry.host ?? entry.summary}`;
    const list = grouped.get(key) ?? [];
    list.push(entry);
    grouped.set(key, list);
  }
  return [...grouped.entries()]
    .filter(([, entries]) => entries.length >= 2)
    .map(([key, entries]) => {
      const sample = entries[0]!;
      const target = sample.target ?? sample.host ?? sample.summary;
      return {
        id: key,
        tool: sample.tool,
        command: `/policy simulate ${sample.tool}${target ? ` --target ${JSON.stringify(target)}` : ''}`,
        summary: `Repeated denials for ${sample.tool}`,
        reason: `${entries.length} denials suggest a durable scoped rule or policy review may be appropriate.`,
      } satisfies PermissionRuleSuggestion;
    })
    .sort((a, b) => a.tool.localeCompare(b.tool));
}
