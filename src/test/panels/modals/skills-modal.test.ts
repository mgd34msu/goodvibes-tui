import { describe, test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindSkillsModal, skillsModalGoldenSurface } from '../../../panels/modals/skills-modal.ts';
import { EMPTY_VIEW } from '../../../panels/modals/modal-surface.ts';
import type { ModalConfig } from '../../../renderer/modal-factory.ts';

/** Flatten a ModalConfig's text/list/title content into one searchable string. */
function configText(config: ModalConfig): string {
  const parts: string[] = [config.title];
  if (config.search !== undefined) parts.push(config.search);
  for (const section of config.sections) {
    if (section.content) parts.push(section.content);
    for (const item of section.items ?? []) parts.push(item.label);
  }
  for (const hint of config.hints ?? []) parts.push(hint);
  if (config.footer) parts.push(config.footer);
  return parts.join('\n');
}

/** Write a project-local skill markdown file under a fresh tmp cwd/homeDir tree. */
function seedSkill(root: string, options: { global?: boolean } = {}): { cwd: string; homeDir: string; cleanup: () => void } {
  const cwd = join(root, 'project');
  const homeDir = join(root, 'home');
  const dir = options.global ? join(homeDir, '.goodvibes', 'skills') : join(cwd, '.goodvibes', 'skills');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'demo.md'),
    '---\nname: demo\ndescription: Demo skill fixture\ndepends_on: other-skill\n---\n@include-target\nbody text',
  );
  return { cwd, homeDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('skills modal builder', () => {
  test('empty discovery renders next-step guidance and no rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-skills-modal-empty-'));
    try {
      const surface = bindSkillsModal({ shellPaths: { workingDirectory: root, homeDirectory: root } });
      surface.refresh();
      const text = configText(surface.buildConfig(EMPTY_VIEW));
      expect(text).toContain('No skills discovered.');
      expect(text).toContain('.goodvibes/skills');
      expect(text).toContain('/registry search skills');
      expect(surface.rowIds(EMPTY_VIEW)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('project-local skill is discovered, parsed, and rendered with detail', () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-skills-modal-project-'));
    const { cwd, homeDir, cleanup } = seedSkill(root);
    try {
      const surface = bindSkillsModal({ shellPaths: { workingDirectory: cwd, homeDirectory: homeDir } });
      surface.refresh();
      const config = surface.buildConfig(EMPTY_VIEW);
      const text = configText(config);
      expect(text).toContain('demo');
      expect(text).toContain('Demo skill fixture');
      expect(text).toContain('skills 1');
      expect(text).toContain('project 1');
      expect(text).toContain('other-skill'); // dependency
      expect(text).toContain('include-target'); // includes
      expect(surface.rowIds(EMPTY_VIEW)).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test('global skill is tagged with global origin, distinct from project-local', () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-skills-modal-global-'));
    const { cwd, homeDir, cleanup } = seedSkill(root, { global: true });
    try {
      const surface = bindSkillsModal({ shellPaths: { workingDirectory: cwd, homeDirectory: homeDir } });
      surface.refresh();
      const text = configText(surface.buildConfig(EMPTY_VIEW));
      expect(text).toContain('global 1');
      expect(text).toContain('project 0');
    } finally {
      cleanup();
    }
  });

  test('filter query narrows the visible list', () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-skills-modal-filter-'));
    const { cwd, homeDir, cleanup } = seedSkill(root);
    try {
      const surface = bindSkillsModal({ shellPaths: { workingDirectory: cwd, homeDirectory: homeDir } });
      surface.refresh();
      const matching = surface.buildConfig({ ...EMPTY_VIEW, query: 'demo' });
      expect(configText(matching)).toContain('demo');
      const nonMatching = surface.buildConfig({ ...EMPTY_VIEW, query: 'no-such-skill' });
      expect(configText(nonMatching)).toContain('No skills match');
      expect(surface.rowIds({ ...EMPTY_VIEW, query: 'no-such-skill' })).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('only a refresh action is exposed (no command-routable mutation exists for skills)', () => {
    const surface = bindSkillsModal({ shellPaths: { workingDirectory: '/nonexistent', homeDirectory: '/nonexistent' } });
    surface.refresh();
    expect(Object.keys(surface.actions)).toEqual(['refresh']);
    expect(surface.actions.refresh!(EMPTY_VIEW)).toEqual({ kind: 'refresh' });
  });

  test('golden surface renders the deterministic empty state with no leaked tmp path', () => {
    const surface = skillsModalGoldenSurface();
    const config = surface.buildConfig(EMPTY_VIEW);
    const text = configText(config);
    expect(text).toContain('No skills discovered.');
    expect(text).not.toContain('gv-skills-golden-');
    expect(surface.rowIds(EMPTY_VIEW)).toHaveLength(0);
  });
});
