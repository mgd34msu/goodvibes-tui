import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export type EcosystemEntryKind = 'plugin' | 'skill';

export interface EcosystemCatalogEntry {
  readonly id: string;
  readonly kind: EcosystemEntryKind;
  readonly name: string;
  readonly summary: string;
  readonly source: string;
  readonly tags: readonly string[];
  readonly trustNotes?: string;
  readonly installHint?: string;
  readonly provenance?: string;
  readonly updateHint?: string;
}

export interface EcosystemCatalogFile {
  readonly version: 1;
  readonly entries: EcosystemCatalogEntry[];
}

export interface EcosystemInstallReceipt {
  readonly version: 1;
  readonly id: string;
  readonly kind: EcosystemEntryKind;
  readonly installedAt: number;
  readonly scope: 'project' | 'user';
  readonly entry: EcosystemCatalogEntry;
  readonly sourcePath: string;
  readonly targetPath: string;
}

function catalogPath(kind: EcosystemEntryKind, cwd: string, homeDir: string, scope: 'project' | 'user'): string {
  return scope === 'project'
    ? join(cwd, '.goodvibes', 'tui', 'ecosystem', `${kind}s.json`)
    : join(homeDir, '.goodvibes', 'tui', 'ecosystem', `${kind}s.json`);
}

function catalogPaths(kind: EcosystemEntryKind, cwd: string, homeDir: string): string[] {
  return [
    join(cwd, '.goodvibes', 'tui', 'ecosystem', `${kind}s.json`),
    join(homeDir, '.goodvibes', 'tui', 'ecosystem', `${kind}s.json`),
  ];
}

function installedRoot(kind: EcosystemEntryKind, cwd: string, homeDir: string, scope: 'project' | 'user'): string {
  const base = scope === 'project'
    ? join(cwd, '.goodvibes')
    : join(homeDir, '.goodvibes');
  return kind === 'plugin'
    ? join(base, 'plugins')
    : join(base, 'skills');
}

function installedReceiptsRoot(cwd: string, homeDir: string, scope: 'project' | 'user'): string {
  return scope === 'project'
    ? join(cwd, '.goodvibes', 'tui', 'ecosystem', 'installed')
    : join(homeDir, '.goodvibes', 'tui', 'ecosystem', 'installed');
}

function receiptPath(kind: EcosystemEntryKind, entryId: string, cwd: string, homeDir: string, scope: 'project' | 'user'): string {
  const base = installedReceiptsRoot(cwd, homeDir, scope);
  return join(base, `${kind}-${entryId}.json`);
}

function loadReceipt(path: string): EcosystemInstallReceipt | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as EcosystemInstallReceipt;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function readCatalogFile(path: string): EcosystemCatalogEntry[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as EcosystemCatalogFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.name === 'string' && entry.kind !== undefined);
  } catch {
    return [];
  }
}

function readCatalogDocument(path: string): EcosystemCatalogFile {
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as EcosystemCatalogFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [] };
    }
    return {
      version: 1,
      entries: parsed.entries.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.name === 'string' && entry.kind !== undefined),
    };
  } catch {
    return { version: 1, entries: [] };
  }
}

export function loadEcosystemCatalog(
  kind: EcosystemEntryKind,
  options: { cwd?: string; homeDir?: string } = {},
): EcosystemCatalogEntry[] {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const seen = new Set<string>();
  const entries: EcosystemCatalogEntry[] = [];

  for (const path of catalogPaths(kind, cwd, homeDir)) {
    for (const entry of readCatalogFile(path)) {
      if (entry.kind !== kind) continue;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function searchEcosystemCatalog(
  kind: EcosystemEntryKind,
  query: string,
  options: { cwd?: string; homeDir?: string } = {},
): EcosystemCatalogEntry[] {
  const normalized = query.trim().toLowerCase();
  const entries = loadEcosystemCatalog(kind, options);
  if (!normalized) return entries;
  return entries.filter((entry) => {
    const haystack = [
      entry.id,
      entry.name,
      entry.summary,
      entry.source,
      entry.trustNotes ?? '',
      entry.installHint ?? '',
      ...entry.tags,
    ].join(' ').toLowerCase();
    return haystack.includes(normalized);
  });
}

export function reviewEcosystemCatalogEntry(
  entry: EcosystemCatalogEntry,
  options: { cwd?: string; homeDir?: string } = {},
): {
  entry: EcosystemCatalogEntry;
  sourcePath: string;
  sourceExists: boolean;
  sourceKind: 'local-path' | 'remote' | 'unknown';
  riskLevel: 'low' | 'medium';
  recommendedScope: 'project' | 'user';
} {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const sourcePath = entry.source.startsWith('/') || entry.source.startsWith('.')
    ? resolve(cwd, entry.source)
    : resolve(homeDir, entry.source);
  const sourceExists = existsSync(sourcePath);
  const sourceKind = entry.source.startsWith('/') || entry.source.startsWith('.')
    ? 'local-path'
    : entry.source.includes('://') || entry.source.startsWith('git+') || entry.source.startsWith('repo:')
      ? 'remote'
      : 'unknown';
  return {
    entry,
    sourcePath,
    sourceExists,
    sourceKind,
    riskLevel: entry.trustNotes || sourceKind === 'remote' ? 'medium' : 'low',
    recommendedScope: entry.kind === 'plugin' ? 'project' : 'user',
  };
}

export function installEcosystemCatalogEntry(
  kind: EcosystemEntryKind,
  entryId: string,
  options: { cwd?: string; homeDir?: string; scope?: 'project' | 'user' } = {},
): { ok: true; receipt: EcosystemInstallReceipt } | { ok: false; error: string } {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const scope = options.scope ?? 'project';
  const entry = loadEcosystemCatalog(kind, { cwd, homeDir }).find((candidate) => candidate.id === entryId);
  if (!entry) return { ok: false, error: `Unknown curated ${kind} entry: ${entryId}` };
  const review = reviewEcosystemCatalogEntry(entry, { cwd, homeDir });
  if (review.sourceKind !== 'local-path') {
    return { ok: false, error: `Curated ${kind} entry ${entryId} is not a local path source and cannot be installed directly.` };
  }
  if (!review.sourceExists) {
    return { ok: false, error: `Curated ${kind} source path does not exist: ${review.sourcePath}` };
  }

  const targetPath = join(installedRoot(kind, cwd, homeDir, scope), entry.id);
  mkdirSync(installedRoot(kind, cwd, homeDir, scope), { recursive: true });
  rmSync(targetPath, { recursive: true, force: true });
  cpSync(review.sourcePath, targetPath, { recursive: true });

  const receipt: EcosystemInstallReceipt = {
    version: 1,
    id: `${kind}:${entry.id}`,
    kind,
    installedAt: Date.now(),
    scope,
    entry,
    sourcePath: review.sourcePath,
    targetPath,
  };
  const path = receiptPath(kind, entry.id, cwd, homeDir, scope);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, 'utf-8');
  return { ok: true, receipt };
}

export function uninstallEcosystemCatalogEntry(
  kind: EcosystemEntryKind,
  entryId: string,
  options: { cwd?: string; homeDir?: string; scope?: 'project' | 'user' } = {},
): { ok: true; removedPath: string } | { ok: false; error: string } {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const scope = options.scope ?? 'project';
  const receipt = loadReceipt(receiptPath(kind, entryId, cwd, homeDir, scope));
  if (!receipt) return { ok: false, error: `No installed ${kind} receipt found for ${entryId} in ${scope} scope.` };
  rmSync(receipt.targetPath, { recursive: true, force: true });
  rmSync(receiptPath(kind, entryId, cwd, homeDir, scope), { force: true });
  return { ok: true, removedPath: receipt.targetPath };
}

export function updateInstalledEcosystemEntry(
  kind: EcosystemEntryKind,
  entryId: string,
  options: { cwd?: string; homeDir?: string; scope?: 'project' | 'user' } = {},
): { ok: true; receipt: EcosystemInstallReceipt; previousReceipt: EcosystemInstallReceipt } | { ok: false; error: string } {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const scope = options.scope ?? 'project';
  const previousReceipt = loadReceipt(receiptPath(kind, entryId, cwd, homeDir, scope));
  if (!previousReceipt) {
    return { ok: false, error: `No installed ${kind} receipt found for ${entryId} in ${scope} scope.` };
  }

  const installed = installEcosystemCatalogEntry(kind, entryId, { cwd, homeDir, scope });
  if (!installed.ok) return installed;
  return { ok: true, receipt: installed.receipt, previousReceipt };
}

export function listInstalledEcosystemEntries(
  kind: EcosystemEntryKind,
  options: { cwd?: string; homeDir?: string } = {},
): EcosystemInstallReceipt[] {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const receipts = [
    installedReceiptsRoot(cwd, homeDir, 'project'),
    installedReceiptsRoot(cwd, homeDir, 'user'),
  ];
  const found: EcosystemInstallReceipt[] = [];
  for (const dir of receipts) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`${kind}-`) || !name.endsWith('.json')) continue;
      const receipt = loadReceipt(join(dir, name));
      if (receipt && receipt.kind === kind) found.push(receipt);
    }
  }
  return found.sort((a, b) => b.installedAt - a.installedAt);
}

export function upsertEcosystemCatalogEntry(
  entry: EcosystemCatalogEntry,
  options: { cwd?: string; homeDir?: string; scope?: 'project' | 'user' } = {},
): { ok: true; path: string; entry: EcosystemCatalogEntry } | { ok: false; error: string } {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const scope = options.scope ?? 'project';
  const path = catalogPath(entry.kind, cwd, homeDir, scope);
  const document = readCatalogDocument(path);
  const nextEntries = document.entries.filter((candidate) => candidate.id !== entry.id || candidate.kind !== entry.kind);
  nextEntries.push(entry);
  nextEntries.sort((a, b) => a.name.localeCompare(b.name));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, entries: nextEntries }, null, 2)}\n`, 'utf-8');
  return { ok: true, path, entry };
}

export function removeEcosystemCatalogEntry(
  kind: EcosystemEntryKind,
  entryId: string,
  options: { cwd?: string; homeDir?: string; scope?: 'project' | 'user' } = {},
): { ok: true; path: string } | { ok: false; error: string } {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const scope = options.scope ?? 'project';
  const path = catalogPath(kind, cwd, homeDir, scope);
  const document = readCatalogDocument(path);
  const nextEntries = document.entries.filter((candidate) => candidate.id !== entryId || candidate.kind !== kind);
  if (nextEntries.length === document.entries.length) {
    return { ok: false, error: `Curated ${kind} catalog entry not found: ${entryId}` };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, entries: nextEntries }, null, 2)}\n`, 'utf-8');
  return { ok: true, path };
}
