/**
 * Skill loader — finds and loads skills by trigger match.
 *
 * Scans skill directories for SKILL.md files with trigger frontmatter.
 * Returns the skill body (system prompt) if a matching trigger is found.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function getSkillDirs(): string[] {
  const cwd = process.cwd();
  return [
    join(cwd, '.goodvibes', 'skills'),
    join(cwd, '.goodvibes', 'tui', 'skills'),
    join(homedir(), '.goodvibes', 'skills'),
    join(homedir(), '.goodvibes', 'tui', 'skills'),
  ];
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  triggers?: string[];
}

function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) return null;

  const secondDash = trimmed.indexOf('\n---', 3);
  if (secondDash === -1) return null;

  const rawFm = trimmed.slice(3, secondDash).trim();
  const body = trimmed.slice(secondDash + 4).trimStart();

  const fm: SkillFrontmatter = {};
  const lines = rawFm.split('\n');
  let collectingTriggers = false;
  const triggerList: string[] = [];

  for (const line of lines) {
    if (collectingTriggers) {
      const listItem = line.match(/^\s+-\s+(.+)$/);
      if (listItem) {
        triggerList.push(listItem[1].trim());
        continue;
      }
      collectingTriggers = false;
    }

    const kv = line.match(/^([\w_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();

    if (key === 'name') fm.name = value;
    if (key === 'description') fm.description = value;
    if (key === 'triggers') {
      // Inline array: [a, b, c]
      const inlineMatch = value.match(/^\[(.+)\]$/);
      if (inlineMatch) {
        fm.triggers = inlineMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      } else if (!value) {
        collectingTriggers = true;
      }
    }
  }

  if (triggerList.length > 0) fm.triggers = triggerList;

  return { frontmatter: fm, body };
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

      const parsed = parseFrontmatter(content);
      if (!parsed) continue;

      const { frontmatter, body } = parsed;

      // Check triggers
      if (frontmatter.triggers) {
        for (const trigger of frontmatter.triggers) {
          if (trigger.toLowerCase().trim() === normalizedInput) {
            return body;
          }
        }
      }

      // Also match by name: /skill-name
      if (frontmatter.name && `/${frontmatter.name}`.toLowerCase() === normalizedInput) {
        return body;
      }
    }
  }

  return null;
}
