/**
 * command-reference.ts — pure renderer for the generated slash-command
 * reference (docs/commands-reference.md).
 *
 * The reference is generated from the live command registry (via
 * {@link categorizeBuiltinCommands} in ./commands.ts), never hand-maintained.
 * This module is deliberately side-effect free so both the generator
 * (scripts/project-surfaces.ts) and the drift-check test import the same
 * rendering logic — the committed file and a fresh render must be byte-identical
 * or the gate fails.
 */
import type { SlashCommand } from './command-registry.ts';

export interface CategorizedCommand {
  readonly command: SlashCommand;
  readonly category: string;
}

/** Escape the pipe and backslash characters that would break a markdown table cell. */
function escapeCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/** Stable anchor slug for a category heading (GitHub-style). */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * renderCommandReferenceMarkdown — deterministic markdown for the full command
 * set. Categories are sorted alphabetically and commands alphabetically by
 * primary name within each category, so the output depends only on the command
 * set and their metadata — not on registration order — which keeps the drift
 * check meaningful (a genuinely new/renamed command moves the bytes; a pure
 * reordering does not).
 */
export function renderCommandReferenceMarkdown(entries: readonly CategorizedCommand[]): string {
  const byCategory = new Map<string, SlashCommand[]>();
  for (const { command, category } of entries) {
    const list = byCategory.get(category) ?? [];
    list.push(command);
    byCategory.set(category, list);
  }

  const categories = Array.from(byCategory.keys()).sort((a, b) => a.localeCompare(b));
  const total = entries.length;

  const lines: string[] = [];
  lines.push('<!-- GENERATED FILE — DO NOT EDIT BY HAND.');
  lines.push('     Regenerate with `bun run docs:commands`.');
  lines.push('     Source of truth: the slash-command registry (src/input/commands.ts).');
  lines.push('     A drift check (src/test/release-gates/command-reference-gate.test.ts)');
  lines.push('     fails CI if this file is stale. -->');
  lines.push('');
  lines.push('# Command Reference');
  lines.push('');
  lines.push(
    `GoodVibes ships **${total}** built-in slash commands across **${categories.length}** categories. ` +
      'Every command below is generated directly from the command registry, so this list is always ' +
      'complete and current. Type a command in the composer prefixed with `/`, or press `Ctrl+K` (or ' +
      'run `/palette`) to search them all in the command palette.',
  );
  lines.push('');
  lines.push('## Categories');
  lines.push('');
  for (const category of categories) {
    const count = byCategory.get(category)?.length ?? 0;
    lines.push(`- [${escapeCell(category)}](#${slug(category)}) — ${count}`);
  }
  lines.push('');

  for (const category of categories) {
    const commands = (byCategory.get(category) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    lines.push(`## ${category}`);
    lines.push('');
    lines.push('| Command | Aliases | Usage | Description |');
    lines.push('| --- | --- | --- | --- |');
    for (const cmd of commands) {
      const name = `\`/${escapeCell(cmd.name)}\``;
      const aliases = (cmd.aliases ?? []).length > 0
        ? (cmd.aliases ?? []).map((a) => `\`/${escapeCell(a)}\``).join(', ')
        : '—';
      const usageText = cmd.usage ?? cmd.argsHint ?? '';
      const usage = usageText ? `\`${escapeCell(usageText)}\`` : '—';
      const description = cmd.description ? escapeCell(cmd.description) : '—';
      lines.push(`| ${name} | ${aliases} | ${usage} | ${description} |`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
