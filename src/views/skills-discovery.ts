/**
 * skills-discovery.ts, finding the skills on disk: project-local
 * (.goodvibes/skills), global (~/.goodvibes/skills) and custom directories,
 * each SKILL.md parsed for its frontmatter, marketplace-installed ones tagged
 * with their provenance. Used by /skills, /local review and the Skills modal.
 */

import { promises as fsPromises } from 'node:fs';
import { join, sep } from 'node:path';
import { listInstalledEcosystemEntries, type EcosystemCatalogPathOptions, type ShellPathService } from '@/runtime/index.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

export type SkillOrigin = 'project-local' | 'global' | 'custom';

export interface SkillRecord {
  name: string;
  description: string;
  path: string;
  origin: SkillOrigin;
  dependencies: string[];
  includes: string[];
  frontmatter: Record<string, string>;
  /**
   * Set when this skill's file lives under an installed ecosystem-marketplace
   * receipt's targetPath, the receipt's provenance summary (e.g. curated
   * source / signature info), so marketplace-installed skills read as such
   * instead of looking identical to hand-authored ones.
   */
  marketplaceProvenance?: string;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length > 0) {
      result[key.trim()] = rest.join(':').trim();
    }
  }
  return result;
}

function getSkillDirectories(cwd: string, homeDir: string): Array<{ root: string; origin: SkillOrigin }> {
  return [
    { root: join(cwd, '.goodvibes', 'skills'), origin: 'project-local' },
    { root: join(cwd, '.goodvibes', 'tui', 'skills'), origin: 'project-local' },
    { root: join(homeDir, '.goodvibes', 'skills'), origin: 'global' },
    { root: join(homeDir, '.goodvibes', 'tui', 'skills'), origin: 'global' },
  ];
}

async function readSkillFile(path: string, origin: SkillOrigin): Promise<SkillRecord | null> {
  let content = '';
  try {
    content = await fsPromises.readFile(path, 'utf-8');
  } catch {
    return null;
  }

  const frontmatter = parseFrontmatter(content);
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const name = frontmatter.name ?? path.split(/[\\/]/).pop()?.replace(/\.md$/, '') ?? 'skill';
  const description = frontmatter.description ?? frontmatter.summary ?? '';
  const dependencies = frontmatter.depends_on
    ? frontmatter.depends_on.split(',').map((item) => item.trim()).filter(Boolean)
    : [];
  const includes: string[] = [];
  const includeRegex = /^@([\w/-]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = includeRegex.exec(body)) !== null) {
    includes.push(match[1]);
  }

  return {
    name,
    description,
    path,
    origin,
    dependencies,
    includes,
    frontmatter,
  };
}

async function scanSkillDirectory(root: string, origin: SkillOrigin): Promise<SkillRecord[]> {
  let entries: string[] = [];
  try {
    entries = await fsPromises.readdir(root);
  } catch {
    return [];
  }

  const records: SkillRecord[] = [];
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    if (entry.endsWith('.md')) {
      const record = await readSkillFile(join(root, entry), origin);
      if (record) records.push(record);
      continue;
    }

    const markerPath = join(root, entry, 'SKILL.md');
    const record = await readSkillFile(markerPath, origin);
    if (record) records.push(record);
  }

  return records;
}

/**
 * Tags records whose file lives under an installed ecosystem-marketplace
 * receipt's targetPath with that receipt's provenance summary. Best-effort:
 * a lookup failure (e.g. no ecosystem catalogs configured) leaves records
 * untagged rather than failing skill discovery.
 */
function applyMarketplaceProvenance(records: SkillRecord[], ecosystemPaths: EcosystemCatalogPathOptions): SkillRecord[] {
  let receipts: ReturnType<typeof listInstalledEcosystemEntries>;
  try {
    receipts = listInstalledEcosystemEntries('skill', ecosystemPaths);
  } catch {
    return records;
  }
  if (receipts.length === 0) return records;
  return records.map((record) => {
    const receipt = receipts.find((candidate) => record.path === candidate.targetPath || record.path.startsWith(`${candidate.targetPath}${sep}`));
    if (!receipt) return record;
    return { ...record, marketplaceProvenance: receipt.provenanceSummary };
  });
}

export async function discoverSkills(
  shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>,
  ecosystemPaths?: EcosystemCatalogPathOptions,
): Promise<SkillRecord[]> {
  const cwd = shellPaths.workingDirectory;
  const homeDir = shellPaths.homeDirectory;
  const seen = new Set<string>();
  const records: SkillRecord[] = [];

  for (const { root, origin } of getSkillDirectories(cwd, homeDir)) {
    for (const record of await scanSkillDirectory(root, origin)) {
      if (seen.has(record.name.toLowerCase())) continue;
      seen.add(record.name.toLowerCase());
      records.push(record);
    }
  }

  const tagged = ecosystemPaths ? applyMarketplaceProvenance(records, ecosystemPaths) : records;

  return tagged.sort((a, b) => {
    const originRank = a.origin === b.origin
      ? 0
      : a.origin === 'project-local'
        ? -1
        : 1;
    return originRank || a.name.localeCompare(b.name);
  });
}
