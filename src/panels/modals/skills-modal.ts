import { MODAL_TONES } from './modal-theme.ts';
import { infoRow } from './modal-surface-helpers.ts';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { ConfigModalActionContext, ConfigModalRow, ConfigModalSurface, ConfigModalView } from '../../input/config-modal-types.ts';
import type { SkillOrigin, SkillRecord } from '../skills-panel.ts';
import { listInstalledEcosystemEntries, type EcosystemCatalogPathOptions, type ShellPathService } from '@/runtime/index.ts';

// ---------------------------------------------------------------------------
// Skills → config-modal surface (group-B port). Project-local and global
// skill-pack discovery. Disk scans happen only in refresh() (never in
// buildView), mirroring the panel's onActivate()-triggered load. Browse-only:
// the panel never had a command-routable mutation verb (no /skills delete/remove
// subcommand exists), so the only action is refresh/navigate. Selection-blind
// port: the panel's selected-skill path/deps/includes detail is folded into
// each row label.
//
// discoverSkills() in the panel was async; the sync re-implementation below
// mirrors the same directory/frontmatter/marketplace-provenance conventions
// (the two are independent implementations of the same on-disk contract).
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
    if (key && rest.length > 0) result[key.trim()] = rest.join(':').trim();
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
  try { content = readFileSync(path, 'utf-8'); } catch { return null; }
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
  while ((match = includeRegex.exec(body)) !== null) includes.push(match[1]);
  return { name, description, path, origin, dependencies, includes, frontmatter };
}

function scanSkillDirectorySync(root: string, origin: SkillOrigin): SkillRecord[] {
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return []; }
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
  try { receipts = listInstalledEcosystemEntries('skill', ecosystemPaths); } catch { return records; }
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
  const seen = new Set<string>();
  const records: SkillRecord[] = [];
  for (const { root, origin } of getSkillDirectories(shellPaths.workingDirectory, shellPaths.homeDirectory)) {
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
    case 'project-local': return 'project';
    case 'global': return 'global';
    case 'custom': return 'custom';
  }
}

class SkillsModalSurface implements ConfigModalSurface {
  readonly name = 'skills-modal';
  readonly title = 'Skills';
  private cached: SkillRecord[] = [];
  private requestRender: () => void = () => {};

  constructor(private readonly deps: SkillsModalDeps) {}

  readonly actions = [{ key: 'r', id: 'refresh', label: 'refresh' }];

  onOpen(requestRender: () => void): void { this.requestRender = requestRender; this.refresh(); }

  private refresh(): void { this.cached = discoverSkillsSync(this.deps.shellPaths, this.deps.ecosystemPaths); }

  buildView(): ConfigModalView {
    const rows: ConfigModalRow[] = [];
    if (this.cached.length === 0) {
      rows.push(infoRow('empty:0', 'No skills discovered.'));
      rows.push(infoRow('empty:title', 'Next steps'));
      rows.push(infoRow('empty:dir', '.goodvibes/skills       — place skill .md files here (project-local) or ~/.goodvibes/skills (global)', { dim: true }));
      rows.push(infoRow('empty:registry', '/registry search skills — inspect the same skill directories from the shell', { dim: true }));
      return { title: 'Skills', tabs: [{ id: 'skills', label: 'Skills', rows, emptyText: '' }] };
    }

    const projectCount = this.cached.filter((s) => s.origin === 'project-local').length;
    const globalCount = this.cached.filter((s) => s.origin === 'global').length;
    const header = [`skills ${this.cached.length}  project ${projectCount}  global ${globalCount}`];

    for (const skill of this.cached) {
      const badge = skill.marketplaceProvenance ? '★' : ' ';
      const dot = skill.origin === 'project-local' ? '◆' : '•';
      const detail = [
        `[${originLabel(skill.origin)}]`,
        skill.description || 'No description provided.',
        skill.dependencies.length > 0 ? `deps ${skill.dependencies.length}` : null,
        skill.includes.length > 0 ? `inc ${skill.includes.length}` : null,
        skill.marketplaceProvenance ?? null,
      ].filter((s): s is string => s !== null).join(' · ');
      rows.push({
        id: skill.path,
        label: `${dot} ${badge} ${skill.name.padEnd(24)} ${detail}`,
        ...(skill.marketplaceProvenance ? { style: { fg: MODAL_TONES.info } } : {}),
      });
    }

    return { title: 'Skills', tabs: [{ id: 'skills', label: 'Skills', header, rows }] };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') { this.refresh(); ctx.setStatus('Rescanned skill directories.'); }
  }
}

export function createSkillsModalSurface(deps: SkillsModalDeps): ConfigModalSurface {
  return new SkillsModalSurface(deps);
}

/**
 * Deterministic golden fixture: a fresh tmp directory tree wired as both cwd and
 * homeDir and removed immediately (scanSkillDirectorySync catches missing dirs →
 * []), so refresh() finds no `.goodvibes/skills` directories and renders the
 * static empty-state copy. The random tmp path never appears in the output.
 *
 * This is production code (ships in the real binary), not test scratch, so
 * it stays rooted at the real OS temp dir rather than the test-only
 * makeProjectTempDir helper. Created and removed synchronously in the same
 * call, so the on-disk window is negligible.
 */
export function skillsModalGoldenSurface(): ConfigModalSurface {
  const root = mkdtempSync(join(tmpdir(), 'gv-skills-golden-'));
  const surface = createSkillsModalSurface({ shellPaths: { workingDirectory: root, homeDirectory: root } });
  rmSync(root, { recursive: true, force: true });
  return surface;
}
