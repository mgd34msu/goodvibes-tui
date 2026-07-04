import { MODAL_TONES } from './modal-theme.ts';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { ModalConfig, ModalSection, ModalListItem } from '../../renderer/modal-factory.ts';
import type { BoundModalSurface, ModalAction, ModalViewState } from './modal-surface.ts';
import type { SkillOrigin, SkillRecord } from '../skills-panel.ts';
import { listInstalledEcosystemEntries, type EcosystemCatalogPathOptions, type ShellPathService } from '@/runtime/index.ts';

// ---------------------------------------------------------------------------
// Skills → modal (W6 WO-B). Mirrors src/panels/skills-panel.ts:
// SkillsPanel({ componentHealthMonitor, shellPaths, ecosystemPaths }).
// `componentHealthMonitor` is a panel-only render-perf concern
// (ScrollableListPanel base class) — irrelevant to a stateless config
// builder, so it is dropped from the dep shape here.
//
// discoverSkills() in skills-panel.ts (lines 151-178) is async (fsPromises),
// but BoundModalSurface.refresh() is synchronous (modal-surface.ts:72) — the
// host calls it once on open and again on the 'refresh' action, with no
// await. So this file re-implements the same directory/frontmatter/
// marketplace-provenance conventions synchronously (node:fs sync calls)
// rather than reusing discoverSkills. If skills-panel.ts's discovery
// mechanics change (new directories, frontmatter fields, provenance
// matching), this needs a parallel update — the two are independent
// implementations of the same on-disk contract.
//
// W6.1 removed Enter's cross-open into the preview panel (skills-panel.ts
// lines 370-376: "DELETE-disposition with no successor surface"), and the
// panel's local 'd' delete (skills-panel.ts:304-313, a real fs.rm) has no
// /skills command equivalent (skills-runtime.ts has no delete/remove
// subcommand) — see this module's test file and the WO report for why that
// verb is intentionally left out of the modal rather than silently
// mutating disk with no charter-compliant command path to route through.
// ---------------------------------------------------------------------------

export interface SkillsModalDeps {
  readonly shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>;
  readonly ecosystemPaths?: EcosystemCatalogPathOptions;
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

function readSkillFileSync(path: string, origin: SkillOrigin): SkillRecord | null {
  let content = '';
  try {
    content = readFileSync(path, 'utf-8');
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
  return { name, description, path, origin, dependencies, includes, frontmatter };
}

function scanSkillDirectorySync(root: string, origin: SkillOrigin): SkillRecord[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const records: SkillRecord[] = [];
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    if (entry.endsWith('.md')) {
      const record = readSkillFileSync(join(root, entry), origin);
      if (record) records.push(record);
      continue;
    }
    const record = readSkillFileSync(join(root, entry, 'SKILL.md'), origin);
    if (record) records.push(record);
  }
  return records;
}

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

function discoverSkillsSync(
  shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>,
  ecosystemPaths?: EcosystemCatalogPathOptions,
): SkillRecord[] {
  const cwd = shellPaths.workingDirectory;
  const homeDir = shellPaths.homeDirectory;
  const seen = new Set<string>();
  const records: SkillRecord[] = [];
  for (const { root, origin } of getSkillDirectories(cwd, homeDir)) {
    for (const record of scanSkillDirectorySync(root, origin)) {
      if (seen.has(record.name.toLowerCase())) continue;
      seen.add(record.name.toLowerCase());
      records.push(record);
    }
  }
  const tagged = ecosystemPaths ? applyMarketplaceProvenance(records, ecosystemPaths) : records;
  return tagged.sort((a, b) => {
    const originRank = a.origin === b.origin ? 0 : a.origin === 'project-local' ? -1 : 1;
    return originRank || a.name.localeCompare(b.name);
  });
}

function originLabel(origin: SkillOrigin): string {
  switch (origin) {
    case 'project-local':
      return 'project';
    case 'global':
      return 'global';
    case 'custom':
      return 'custom';
  }
}

function matchesQuery(skill: SkillRecord, q: string): boolean {
  if (q === '') return true;
  const haystack = [
    skill.name,
    skill.description,
    skill.path,
    skill.origin,
    skill.marketplaceProvenance ?? '',
    skill.dependencies.join(' '),
    skill.includes.join(' '),
  ].join(' ').toLowerCase();
  return haystack.includes(q.toLowerCase());
}

/**
 * Skills → modal. Project-local and global skill-pack discovery. Disk scans
 * happen only in refresh() (never in buildConfig), mirroring the panel's
 * explicit onActivate()-triggered load. Browse-only: this panel never had a
 * command-routable mutation verb (no /skills delete/remove subcommand exists
 * — see skills-runtime.ts), so the only action is refresh/navigate.
 */
export function bindSkillsModal(deps: SkillsModalDeps): BoundModalSurface {
  let cached: SkillRecord[] = [];

  const refresh = (): void => {
    cached = discoverSkillsSync(deps.shellPaths, deps.ecosystemPaths);
  };

  const visibleSkills = (view: ModalViewState): SkillRecord[] => cached.filter((skill) => matchesQuery(skill, view.query));

  const selectedSkill = (view: ModalViewState): SkillRecord | undefined => {
    const visible = visibleSkills(view);
    if (visible.length === 0) return undefined;
    return visible[Math.max(0, Math.min(view.selectedIndex, visible.length - 1))];
  };

  const buildConfig = (view: ModalViewState): ModalConfig => {
    if (cached.length === 0) {
      return {
        title: 'Skills',
        width: 76,
        sections: [
          { type: 'text', content: 'No skills discovered.' },
          { type: 'separator' },
          { type: 'title', content: 'Next steps' },
          { type: 'text', content: '.goodvibes/skills       — place skill .md files here (project-local) or ~/.goodvibes/skills (global)', style: { dim: true } },
          { type: 'text', content: '/registry search skills — inspect the same skill directories from the shell', style: { dim: true } },
        ],
        footer: 'no skills discovered · esc close',
      };
    }

    const sections: ModalSection[] = [];
    const projectCount = cached.filter((s) => s.origin === 'project-local').length;
    const globalCount = cached.filter((s) => s.origin === 'global').length;
    sections.push({
      type: 'text',
      content: `skills ${cached.length}  project ${projectCount}  global ${globalCount}`,
      style: { dim: true },
    });
    sections.push({ type: 'separator' });

    const visible = visibleSkills(view);
    const clampedIndex = Math.max(0, Math.min(view.selectedIndex, visible.length - 1));
    const items: ModalListItem[] = visible.map((skill, index) => {
      const badge = skill.marketplaceProvenance ? '★' : ' ';
      const dot = skill.origin === 'project-local' ? '◆' : '•';
      return {
        label: `${dot} ${badge} ${skill.name.padEnd(24)} ${(skill.description || 'No description provided.')}`,
        selected: index === clampedIndex,
      };
    });
    if (items.length === 0) {
      sections.push({ type: 'text', content: `No skills match “${view.query}”.`, style: { dim: true } });
    } else {
      sections.push({ type: 'list', items });
    }

    const selected = visible[clampedIndex];
    if (selected) {
      sections.push({ type: 'separator' });
      sections.push({ type: 'text', content: `[${originLabel(selected.origin)}]  ${selected.path}`, style: { dim: true } });
      sections.push({ type: 'text', content: selected.description || 'No description provided.' });
      sections.push({ type: 'text', content: `depends: ${selected.dependencies.length > 0 ? selected.dependencies.join(', ') : 'none'}`, style: { dim: true } });
      sections.push({ type: 'text', content: `includes: ${selected.includes.length > 0 ? selected.includes.join(', ') : 'none'}`, style: { dim: true } });
      sections.push({
        type: 'text',
        content: `provenance: ${selected.marketplaceProvenance ?? 'not installed via marketplace'}`,
        style: { fg: selected.marketplaceProvenance ? MODAL_TONES.info : undefined, dim: !selected.marketplaceProvenance },
      });
    }

    return {
      title: 'Skills',
      width: 76,
      search: view.query,
      sections,
      hints: ['up/down move', 'r refresh', '/ filter'],
    };
  };

  return {
    name: 'skills',
    title: 'Skills',
    refresh,
    buildConfig,
    rowIds: (view) => visibleSkills(view).map((skill) => skill.path),
    actions: {
      refresh: () => ({ kind: 'refresh' }),
    },
  };
}

/**
 * Deterministic golden fixture: a fresh, empty tmp directory tree wired as
 * both cwd and homeDir, so refresh() finds no `.goodvibes/skills` directories
 * anywhere and renders the static empty-state copy. The random tmp path
 * never appears in the rendered lines, so the golden is byte-stable; the dir
 * is removed after refresh() since buildConfig() never touches disk itself.
 */
export function skillsModalGoldenSurface(): BoundModalSurface {
  const root = mkdtempSync(join(tmpdir(), 'gv-skills-golden-'));
  const surface = bindSkillsModal({ shellPaths: { workingDirectory: root, homeDirectory: root } });
  surface.refresh();
  rmSync(root, { recursive: true, force: true });
  return surface;
}
