import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PanelManager } from '../../panels/panel-manager.ts';
import { registerBuiltinPanels } from '../../panels/builtin-panels.ts';
import { SkillsPanel, discoverSkills } from '../../panels/skills-panel.ts';
import { RuntimeEventBus, installEcosystemCatalogEntry } from '@/runtime/index.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createUiRuntimeServices } from '../../runtime/ui-services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import type { Line } from '../../types/grid.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { trackDisposables } from '../helpers/disposables.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * A composed runtime graph starts a dozen pollers while it builds — the fleet
 * registry tick, the config-file watch, the memory governor, the knowledge
 * scheduler, the cross-session sweep, the orchestration snapshot writer, the
 * push-subscription sweep and the snapshot / retention / consolidation
 * schedulers. Nothing upstream stops a graph it did not compose itself, so the
 * test that built it owns stopping it.
 */
const disposables = trackDisposables();

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

function makeShellPaths(workingDirectory: string, homeDirectory: string): Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'> {
  return { workingDirectory, homeDirectory };
}

function makeTestTempDir(prefix: string): string {
  // makeProjectTempDir registers the directory with the shared cleanup registry,
  // so the test process removes it before it ends. The version this replaced
  // nested the directories under an extra `.test-tmp/skills-panel/` level that
  // the afterEach never removed, so that level survived every green run.
  return makeProjectTempDir(prefix.replace(/-+$/, ''));
}

describe('SkillsPanel', () => {
  let cwd: string;
  let homeDir: string;

  beforeEach(() => {
    cwd = makeTestTempDir('gv-skills-cwd-');
    homeDir = makeTestTempDir('gv-skills-home-');
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  test('shows guidance when no skills are discovered', () => {
    const shellPaths = makeShellPaths(cwd, homeDir);
    const panel = new SkillsPanel({ shellPaths });
    const text = linesText(panel.render(120, 12));
    expect(text).toContain('No skills discovered');
    expect(text).toContain('.goodvibes/skills');
    expect(text).toContain('/registry search skills');
  });

  test('is registered as a built-in panel', () => {
    const manager = new PanelManager();
    const services = disposables.add(createRuntimeServices({
      configManager: new ConfigManager({ surfaceRoot: 'tui',
        workingDir: cwd,
        homeDir,
        configDir: join(homeDir, '.goodvibes', 'test-skills-panel'),
      }),
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      workingDir: cwd,
      homeDirectory: homeDir,
    }));
    const uiServices = createUiRuntimeServices(services);
    registerBuiltinPanels(manager, {
      providerRegistry: services.providerRegistry,
      uiServices,
      tokenAuditor: services.tokenAuditor,
      componentHealthMonitor: services.componentHealthMonitor,
      worktreeRegistry: services.worktreeRegistry,
      sandboxSessionRegistry: services.sandboxSessionRegistry,
    });
    // (the purge) — group B: skills migrated to the 'skills-modal' config-
    // modal surface. The panel is no longer a registered type; the id
    // redirects to the surface (registered in registerBuiltinModals).
    expect(manager.getRegisteredTypes().some((entry) => entry.id === 'skills')).toBe(false);
    expect(manager.getModalRedirect('skills')).toBe('skills-modal');
    expect(manager.getModalSurface('skills-modal')?.name).toBe('skills-modal');
  });

  test('discovers project-local skills before global skills and renders origin path', async () => {
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

    const shellPaths = makeShellPaths(cwd, homeDir);
    const skills = await discoverSkills(shellPaths);
    expect(skills).toHaveLength(2);
    expect(skills[0]?.name).toBe('alpha');
    expect(skills[0]?.path).toBe(projectPath);
    expect(skills[0]?.description).toContain('Project-local');
    expect(skills[1]?.name).toBe('beta');
    expect(skills.map((skill) => skill.path)).not.toContain(globalPath);

    const panel = new SkillsPanel({ shellPaths: makeShellPaths(cwd, homeDir) });
    panel.onActivate();
    await panel.awaitReady();
    const text = linesText(panel.render(120, 16));
    expect(text).toContain('Skills - discover project-local and global skill packs');
    expect(text).toContain('alpha');
    expect(text).toContain('Project-local alpha skill');
    expect(text).toContain('.goodvibes/skills/alpha.md');
    expect(text).toContain('Depends: core, utils');
    expect(text).toContain('Includes: include-alpha');
  });

  test('supports filtering and navigation', async () => {
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

    const panel = new SkillsPanel({ shellPaths: makeShellPaths(cwd, homeDir) });
    panel.onActivate();
    await panel.awaitReady();
    panel.handleInput('/');
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
    expect(second).toContain('Up/Down navigate');
  });

  test('/ activates the filter; Esc deactivates and down navigates normally', async () => {
    writeSkill(
      cwd,
      '.goodvibes/tui/skills/alpha/SKILL.md',
      ['---', 'name: alpha', 'description: Alpha skill', '---', ''].join('\n'),
    );
    writeSkill(
      cwd,
      '.goodvibes/tui/skills/beta/SKILL.md',
      ['---', 'name: beta', 'description: Beta skill', '---', ''].join('\n'),
    );

    const panel = new SkillsPanel({ shellPaths: makeShellPaths(cwd, homeDir) });
    panel.onActivate();
    await panel.awaitReady();
    panel.handleInput('/');
    panel.handleInput('b');
    let text = linesText(panel.render(120, 16));
    // converged modal filter — pinned '[Filter] ' + literal '_' cursor contract.
    expect(text).toContain('[Filter] b');

    panel.handleInput('escape');
    panel.handleInput('down');
    text = linesText(panel.render(120, 16));
    expect(text).toContain('Selected: beta');
  });

  test('d then Enter/y actually deletes the skill file from disk (no more "delete via shell" signpost)', async () => {
    const filePath = writeSkill(
      cwd,
      '.goodvibes/skills/alpha.md',
      ['---', 'name: alpha', 'description: Alpha skill', '---', ''].join('\n'),
    );

    const panel = new SkillsPanel({ shellPaths: makeShellPaths(cwd, homeDir) });
    panel.onActivate();
    await panel.awaitReady();

    expect(panel.handleInput('d')).toBe(true);
    const confirmText = linesText(panel.render(120, 16));
    expect(confirmText).toContain('Delete');
    expect(confirmText).not.toContain('rm "');

    expect(panel.handleInput('enter')).toBe(true);
    // Deletion + rescan are TWO async steps off the confirmed keypress. Poll
    // the observable outcome (the rescanned empty state), not just the file
    // removal — waiting only on the file loses the rescan race under CI load.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!existsSync(filePath) && linesText(panel.render(120, 16)).includes('No skills discovered')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(filePath)).toBe(false);

    const text = linesText(panel.render(120, 16));
    expect(text).toContain('No skills discovered');
  });

  // (the purge): Enter used to open the skill's markdown source in the
  // preview panel via handlePanelIntegrationAction. 'preview' is
  // DELETE-disposition with no successor surface, so that cross-panel jump
  // was removed rather than repointed — Enter is now a no-op key-consume
  // (browse-only) on this list until migrates Skills to a modal.
  test('Enter on a skill row is consumed but no longer opens a preview panel', async () => {
    writeSkill(
      cwd,
      '.goodvibes/tui/skills/alpha/SKILL.md',
      ['---', 'name: alpha', 'description: Alpha skill', '---', ''].join('\n'),
    );
    // (the purge): skills is register-retired (redirects to the modal), so
    // construct the retained panel class directly — the same pattern the other
    // tests in this file use — to exercise its Enter/no-preview behavior.
    const skillsPanel = new SkillsPanel({ shellPaths: makeShellPaths(cwd, homeDir) });
    skillsPanel.onActivate();
    await skillsPanel.awaitReady();
    expect(skillsPanel.handleInput('enter')).toBe(true);
    // handlePanelIntegrationAction was removed from SkillsPanel entirely (see
    // comment above) — probe through a narrow structural type to assert its
    // genuine absence rather than reading a property the class type no longer
    // declares.
    expect((skillsPanel as unknown as { handlePanelIntegrationAction?: unknown }).handlePanelIntegrationAction).toBeUndefined();
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
        id: 'curated-alpha',
        kind: 'skill',
        name: 'curated-alpha',
        summary: 'A curated skill',
        source: './catalog/skills/curated-alpha',
        tags: [],
        provenance: 'curated-local',
      }],
    }, null, 2));
    writeSkill(
      cwd,
      'catalog/skills/curated-alpha/SKILL.md',
      ['---', 'name: curated-alpha', 'description: Curated alpha skill', '---', ''].join('\n'),
    );

    const installResult = installEcosystemCatalogEntry('skill', 'curated-alpha', ecosystemPaths);
    expect(installResult.ok).toBe(true);

    const panel = new SkillsPanel({ shellPaths: makeShellPaths(cwd, homeDir), ecosystemPaths });
    panel.onActivate();
    await panel.awaitReady();
    const text = linesText(panel.render(120, 16));
    expect(text).toContain('curated-alpha');
    expect(text).toContain('curated-local');
  });
});
