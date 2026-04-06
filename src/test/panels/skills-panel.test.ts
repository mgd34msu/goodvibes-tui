import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PanelManager } from '../../panels/panel-manager.ts';
import { registerBuiltinPanels } from '../../panels/builtin-panels.ts';
import { SkillsPanel, discoverSkills } from '../../panels/skills-panel.ts';
import type { RuntimeEventBus } from '../../runtime/events/index.ts';
import type { Line } from '../../types/grid.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

function writeSkill(root: string, relPath: string, content: string): string {
  const filePath = join(root, relPath);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('SkillsPanel', () => {
  let cwd: string;
  let homeDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'gv-skills-cwd-'));
    homeDir = mkdtempSync(join(tmpdir(), 'gv-skills-home-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  test('shows guidance when no skills are discovered', () => {
    const panel = new SkillsPanel({ cwd, homeDir });
    const text = linesText(panel.render(120, 12));
    expect(text).toContain('No skills discovered');
    expect(text).toContain('.goodvibes/skills');
    expect(text).toContain('/registry search skills');
  });

  test('is registered as a built-in panel', () => {
    const manager = new PanelManager();
    registerBuiltinPanels(manager, { runtimeBus: {} as RuntimeEventBus });
    expect(manager.getRegisteredTypes().some((entry) => entry.id === 'skills')).toBe(true);
  });

  test('discovers project-local skills before global skills and renders origin path', () => {
    const projectPath = writeSkill(
      cwd,
      '.goodvibes/skills/alpha.md',
      [
        '---',
        'name: alpha',
        'description: Project-local alpha skill',
        'depends_on: core, utils',
        '---',
        '',
        '@include-alpha',
      ].join('\n'),
    );
    const globalPath = writeSkill(
      homeDir,
      '.goodvibes/skills/alpha.md',
      [
        '---',
        'name: alpha',
        'description: Global alpha skill',
        '---',
        '',
        '@include-global',
      ].join('\n'),
    );
    writeSkill(
      homeDir,
      '.goodvibes/tui/skills/beta/SKILL.md',
      [
        '---',
        'name: beta',
        'description: Global beta skill',
        '---',
        '',
      ].join('\n'),
    );

    const skills = discoverSkills({ cwd, homeDir });
    expect(skills).toHaveLength(2);
    expect(skills[0]?.name).toBe('alpha');
    expect(skills[0]?.path).toBe(projectPath);
    expect(skills[0]?.description).toContain('Project-local');
    expect(skills[1]?.name).toBe('beta');
    expect(skills.map((skill) => skill.path)).not.toContain(globalPath);

    const panel = new SkillsPanel({ cwd, homeDir });
    const text = linesText(panel.render(120, 16));
    expect(text).toContain('Skills — discover project-local and global skill packs');
    expect(text).toContain('alpha');
    expect(text).toContain('Project-local alpha skill');
    expect(text).toContain(projectPath);
    expect(text).toContain('Depends: core, utils');
    expect(text).toContain('Includes: include-alpha');
  });

  test('supports filtering and navigation', () => {
    writeSkill(
      cwd,
      '.goodvibes/tui/skills/alpha/SKILL.md',
      ['---', 'name: alpha', 'description: Alpha skill', '---', ''].join('\n'),
    );
    writeSkill(
      cwd,
      '.goodvibes/tui/skills/beta/SKILL.md',
      ['---', 'name: beta', 'description: Beta skill needle-42', '---', ''].join('\n'),
    );
    writeSkill(
      homeDir,
      '.goodvibes/skills/gamma.md',
      ['---', 'name: gamma', 'description: Gamma skill', '---', ''].join('\n'),
    );

    const panel = new SkillsPanel({ cwd, homeDir });
    for (const ch of 'needle-42') {
      expect(panel.handleInput(ch)).toBe(true);
    }
    const filtered = linesText(panel.render(120, 16));
    expect(filtered).toContain('beta');
    expect(filtered).not.toContain('alpha');
    expect(filtered).not.toContain('gamma');

    panel.handleInput('escape');
    panel.handleInput('down');
    const second = linesText(panel.render(120, 16));
    expect(second).toContain('Selected: beta');
    expect(second).toContain('Path:');
    expect(second).toContain('↑/↓ navigate');
  });
});
