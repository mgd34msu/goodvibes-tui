import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverSkills } from '../../panels/skills-discovery.ts';
import { installEcosystemCatalogEntry } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function writeSkill(root: string, relPath: string, content: string): string {
  const filePath = join(root, relPath);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('discoverSkills', () => {
  let cwd: string;
  let homeDir: string;

  beforeEach(() => {
    cwd = makeProjectTempDir('gv-skills-cwd');
    homeDir = makeProjectTempDir('gv-skills-home');
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  test('project-local skills win over global skills of the same name; frontmatter and includes are read', async () => {
    const projectPath = writeSkill(cwd, '.goodvibes/skills/alpha.md', [
      '---', 'name: alpha', 'description: Project-local alpha skill', 'depends_on: core, utils', '---', '', '@include-alpha',
    ].join('\n'));
    const globalPath = writeSkill(homeDir, '.goodvibes/skills/alpha.md', [
      '---', 'name: alpha', 'description: Global alpha skill', '---', '', '@include-global',
    ].join('\n'));
    writeSkill(homeDir, '.goodvibes/tui/skills/beta/SKILL.md', ['---', 'name: beta', 'description: Global beta skill', '---', ''].join('\n'));

    const skills = await discoverSkills({ workingDirectory: cwd, homeDirectory: homeDir });

    expect(skills).toHaveLength(2);
    expect(skills[0]?.name).toBe('alpha');
    expect(skills[0]?.path).toBe(projectPath);
    expect(skills[0]?.origin).toBe('project-local');
    expect(skills[0]?.dependencies).toEqual(['core', 'utils']);
    expect(skills[0]?.includes).toEqual(['include-alpha']);
    expect(skills[1]?.name).toBe('beta');
    expect(skills[1]?.origin).toBe('global');
    expect(skills.map((skill) => skill.path)).not.toContain(globalPath);
  });

  test('tags marketplace-installed skills with provenance from the install receipt', async () => {
    const ecosystemPaths = {
      cwd,
      homeDir,
      projectCatalogRoot: join(cwd, '.goodvibes', 'ecosystem'),
      userCatalogRoot: join(homeDir, '.goodvibes', 'ecosystem'),
    };
    mkdirSync(ecosystemPaths.projectCatalogRoot, { recursive: true });
    writeFileSync(join(ecosystemPaths.projectCatalogRoot, 'skills.json'), JSON.stringify({
      version: 1,
      entries: [{
        id: 'curated-alpha', kind: 'skill', name: 'curated-alpha', summary: 'A curated skill',
        source: './catalog/skills/curated-alpha', tags: [], provenance: 'curated-local',
      }],
    }, null, 2));
    writeSkill(cwd, 'catalog/skills/curated-alpha/SKILL.md', ['---', 'name: curated-alpha', 'description: Curated alpha skill', '---', ''].join('\n'));
    expect(installEcosystemCatalogEntry('skill', 'curated-alpha', ecosystemPaths).ok).toBe(true);

    const skills = await discoverSkills({ workingDirectory: cwd, homeDirectory: homeDir }, ecosystemPaths);
    const curated = skills.find((skill) => skill.name === 'curated-alpha');

    expect(curated).toBeDefined();
    expect(curated?.marketplaceProvenance).toContain('curated-local');
  });
});
