import { describe, test, expect } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSkillsModalSurface } from '../../../panels/modals/skills-modal.ts';
import { findAction, open, tabText } from './modal-surface-test-helpers.ts';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';

function seedSkill(root: string, options: { global?: boolean } = {}): { cwd: string; homeDir: string; cleanup: () => void } {
  const cwd = join(root, 'project');
  const homeDir = join(root, 'home');
  const dir = options.global ? join(homeDir, '.goodvibes', 'skills') : join(cwd, '.goodvibes', 'skills');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'demo.md'), '---\nname: demo\ndescription: Demo skill fixture\ndepends_on: other-skill\n---\n@include-target\nbody text');
  return { cwd, homeDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('skills modal surface', () => {
  test('surface identity', () => { expect(createSkillsModalSurface({ shellPaths: { workingDirectory: '/x', homeDirectory: '/x' } }).name).toBe('skills-modal'); });

  test('empty discovery renders honest next-step guidance', () => {
    const root = makeProjectTempDir('gv-skills-modal-empty');
    try {
      const text = tabText(open(createSkillsModalSurface({ shellPaths: { workingDirectory: root, homeDirectory: root } })), 'skills');
      expect(text).toContain('No skills discovered.');
      expect(text).toContain('.goodvibes/skills');
      expect(text).toContain('/registry search skills');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('project-local skill is discovered, parsed, and folds deps/includes into the row', () => {
    const root = makeProjectTempDir('gv-skills-modal-project');
    const { cwd, homeDir, cleanup } = seedSkill(root);
    try {
      const view = open(createSkillsModalSurface({ shellPaths: { workingDirectory: cwd, homeDirectory: homeDir } }));
      const text = tabText(view, 'skills');
      expect(text).toContain('demo');
      expect(text).toContain('Demo skill fixture');
      expect(text).toContain('skills 1  project 1  global 0');
      expect(text).toContain('deps 1'); // folded dependency count
      expect(text).toContain('inc 1'); // folded includes count
      expect(view.tabs[0]!.rows).toHaveLength(1);
    } finally { cleanup(); }
  });

  test('global skill is tagged with global origin, distinct from project-local', () => {
    const root = makeProjectTempDir('gv-skills-modal-global');
    const { cwd, homeDir, cleanup } = seedSkill(root, { global: true });
    try {
      expect(tabText(open(createSkillsModalSurface({ shellPaths: { workingDirectory: cwd, homeDirectory: homeDir } })), 'skills')).toContain('skills 1  project 0  global 1');
    } finally { cleanup(); }
  });

  test('only a refresh action is exposed (no command-routable mutation exists for skills)', () => {
    const surface = createSkillsModalSurface({ shellPaths: { workingDirectory: '/nonexistent', homeDirectory: '/nonexistent' } });
    open(surface);
    expect((surface.actions ?? []).map((a) => a.id)).toEqual(['refresh']);
    expect(findAction(surface, 'refresh')).toBeDefined();
  });
});
