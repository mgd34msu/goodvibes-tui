/**
 * Skill loader — finds and loads skills by trigger match.
 *
 * Scans skill directories for SKILL.md files with trigger frontmatter.
 * Returns the skill body (system prompt) if a matching trigger is found.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  materializeMarkdownBody,
  parseMarkdownFrontmatter,
  normalizeFrontmatterList,
} from '../../utils/markdown-disclosure.ts';

function getSkillDirs(): string[] {
  const cwd = process.cwd();
  return [
    join(cwd, '.goodvibes', 'skills'),
    join(cwd, '.goodvibes', 'tui', 'skills'),
    join(homedir(), '.goodvibes', 'skills'),
    join(homedir(), '.goodvibes', 'tui', 'skills'),
  ];
}

/**
 * Find a skill whose triggers include the given input string.
 * Returns the skill body (markdown content to inject as prompt), or null.
 */
export function loadSkillByTrigger(input: string): string | null {
  const normalizedInput = input.toLowerCase().trim();

  for (const dir of getSkillDirs()) {
    if (!existsSync(dir)) continue;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      // Check for directory-based skill: entry/SKILL.md
      const skillPath = join(dir, entry, 'SKILL.md');
      // Also check flat file: entry.md
      const flatPath = join(dir, entry);

      let content: string | null = null;
      let filePath: string | null = null;

      if (existsSync(skillPath)) {
        filePath = skillPath;
      } else if (entry.endsWith('.md') && existsSync(flatPath)) {
        filePath = flatPath;
      }

      if (!filePath) continue;

      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      const { metadata: frontmatter, body } = parseMarkdownFrontmatter(content);
      const name = typeof frontmatter.name === 'string' ? frontmatter.name : undefined;
      const triggers = normalizeFrontmatterList(frontmatter.triggers);

      // Check triggers
      for (const trigger of triggers) {
        if (trigger.toLowerCase().trim() === normalizedInput) {
          return materializeMarkdownBody(filePath, body);
        }
      }

      // Also match by name: /skill-name
      if (name && `/${name}`.toLowerCase() === normalizedInput) {
        return materializeMarkdownBody(filePath, body);
      }
    }
  }

  return null;
}
