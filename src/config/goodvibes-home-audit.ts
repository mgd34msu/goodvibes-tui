import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createReadStream } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { CONFIG_SCHEMA, DEFAULT_CONFIG } from '@pellux/goodvibes-sdk/platform/config';

export type HomeFileOwner = 'tui' | 'daemon' | 'foreign-goodvibes-product' | 'unknown-root';

export type SettingsKeyClassification =
  | 'current-schema'
  | 'known-dynamic'
  | 'default-config-dynamic'
  | 'unknown-stale-candidate';

export interface HomeAuditOptions {
  readonly homeDir: string;
  readonly includeHashes?: boolean;
}

export interface HomeFileSummary {
  readonly owner: HomeFileOwner;
  readonly files: number;
  readonly directories: number;
  readonly bytes: number;
}

export interface HomeFileRecord {
  readonly relativePath: string;
  readonly owner: HomeFileOwner;
  readonly bytes: number;
  readonly mode: string;
  readonly mtimeIso: string;
  readonly sha256?: string;
}

export interface SettingsKeyAudit {
  readonly key: string;
  readonly classification: SettingsKeyClassification;
}

export interface SettingsAudit {
  readonly path: string;
  readonly exists: boolean;
  readonly schemaKeyCount: number;
  readonly leafKeyCount: number;
  readonly recognizedKeyCount: number;
  readonly missingSchemaKeys: readonly string[];
  readonly keys: readonly SettingsKeyAudit[];
  readonly staleCandidates: readonly string[];
}

export interface HomeAuditFinding {
  readonly severity: 'info' | 'warn' | 'error';
  readonly code: string;
  readonly path?: string;
  readonly message: string;
}

export interface DuplicateProfilePattern {
  readonly normalizedName: string;
  readonly count: number;
}

export interface GoodVibesHomeAudit {
  readonly homeDir: string;
  readonly generatedAt: string;
  readonly summaries: readonly HomeFileSummary[];
  readonly files: readonly HomeFileRecord[];
  readonly settings: SettingsAudit;
  readonly duplicateProfilePatterns: readonly DuplicateProfilePattern[];
  readonly findings: readonly HomeAuditFinding[];
  readonly allowedWriteRoots: readonly string[];
  readonly readOnlyRoots: readonly string[];
}

export interface HomeSnapshotEntry {
  readonly relativePath: string;
  readonly bytes: number;
  readonly mode: string;
  readonly sha256: string;
}

export type HomeSnapshot = Readonly<Record<string, HomeSnapshotEntry>>;

export interface HomeSnapshotDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

const KNOWN_FOREIGN_ROOTS = new Set([
  '.backups',
  '.exec-output',
  'archive',
  'companion-chat',
  'events',
  'full-suite',
  'hooks',
  'logs',
  'memory',
  'providers',
  'scripts',
  'sdk',
  'skills',
  'state',
  'telemetry',
]);

const KNOWN_DYNAMIC_KEYS = [
  /^featureFlags(?:\.|$)/,
  /^notifications\.webhookUrls$/,
  /^wrfc\.gates$/,
  // TUI-bridged setting awaiting SDK schema registration (handoff Item 5b)
  /^tts\.speed$/,
];

export const GOODVIBES_ALLOWED_WRITE_ROOTS = ['tui/', 'daemon/'] as const;
export const GOODVIBES_READ_ONLY_ROOTS = [
  '*.api.json',
  'archive/',
  'sdk/',
  'state/',
  'events/',
  'companion-chat/',
  'full-suite/',
] as const;

function toPosixRelative(path: string): string {
  return path.split(sep).join('/');
}

function flattenObject(value: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix) out[prefix] = value;
    return out;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      flattenObject(entry, nextPrefix, out);
    } else {
      out[nextPrefix] = entry;
    }
  }
  return out;
}

function classifyFile(relativePath: string): HomeFileOwner {
  if (relativePath.startsWith('tui/')) return 'tui';
  if (relativePath.startsWith('daemon/')) return 'daemon';
  if (!relativePath.includes('/')) return 'foreign-goodvibes-product';
  if (basename(relativePath).endsWith('.api.json')) return 'foreign-goodvibes-product';
  const firstSegment = relativePath.split('/')[0] ?? '';
  if (KNOWN_FOREIGN_ROOTS.has(firstSegment)) return 'foreign-goodvibes-product';
  return 'unknown-root';
}

function isKnownDynamicKey(key: string): boolean {
  return KNOWN_DYNAMIC_KEYS.some((pattern) => pattern.test(key));
}

function classifySettingsKey(
  key: string,
  schemaKeys: ReadonlySet<string>,
  defaultKeys: ReadonlySet<string>,
): SettingsKeyClassification {
  if (schemaKeys.has(key)) return 'current-schema';
  if (isKnownDynamicKey(key)) return 'known-dynamic';
  if (defaultKeys.has(key)) return 'default-config-dynamic';
  return 'unknown-stale-candidate';
}

function walkFiles(root: string): { files: string[]; directoryCountByOwner: Map<HomeFileOwner, number> } {
  const files: string[] = [];
  const directoryCountByOwner = new Map<HomeFileOwner, number>();
  if (!existsSync(root)) return { files, directoryCountByOwner };

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const rel = toPosixRelative(relative(root, absolute));
      if (entry.isDirectory()) {
        const owner = classifyFile(`${rel}/`);
        directoryCountByOwner.set(owner, (directoryCountByOwner.get(owner) ?? 0) + 1);
        visit(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  };

  visit(root);
  files.sort((a, b) => a.localeCompare(b));
  return { files, directoryCountByOwner };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function auditSettings(homeDir: string): SettingsAudit {
  const path = join(homeDir, 'tui', 'settings.json');
  const settings = readJsonObject(path);
  const flatSettings = flattenObject(settings ?? {});
  const schemaKeys = new Set(CONFIG_SCHEMA.map((entry) => entry.key));
  const defaultKeys = new Set(Object.keys(flattenObject(DEFAULT_CONFIG)));
  const keys = Object.keys(flatSettings)
    .sort((a, b) => a.localeCompare(b))
    .map((key): SettingsKeyAudit => ({
      key,
      classification: classifySettingsKey(key, schemaKeys, defaultKeys),
    }));
  const missingSchemaKeys = [...schemaKeys]
    .filter((key) => !(key in flatSettings))
    .sort((a, b) => a.localeCompare(b));
  const staleCandidates = keys
    .filter((entry) => entry.classification === 'unknown-stale-candidate')
    .map((entry) => entry.key);

  return {
    path,
    exists: settings !== null,
    schemaKeyCount: schemaKeys.size,
    leafKeyCount: keys.length,
    recognizedKeyCount: keys.filter((entry) => entry.classification === 'current-schema').length,
    missingSchemaKeys,
    keys,
    staleCandidates,
  };
}

function modeString(path: string): string {
  return (statSync(path).mode & 0o777).toString(8).padStart(3, '0');
}

function collectPermissionFindings(homeDir: string): HomeAuditFinding[] {
  const findings: HomeAuditFinding[] = [];
  const sensitiveFiles = [
    join(homeDir, 'tui', 'secrets.enc'),
    join(homeDir, 'tui', 'auth-users.json'),
    join(homeDir, 'daemon', 'operator-tokens.json'),
    join(homeDir, 'daemon', '.goodvibes', 'daemon', 'operator-tokens.json'),
    join(homeDir, 'daemon', '.goodvibes', 'tui', 'auth-users.json'),
    join(homeDir, 'daemon', '.goodvibes', 'tui', 'auth-bootstrap.txt'),
  ];

  for (const path of sensitiveFiles) {
    if (!existsSync(path)) continue;
    const mode = modeString(path);
    if (mode !== '600') {
      findings.push({
        severity: 'warn',
        code: 'sensitive-file-permissions',
        path,
        message: `Sensitive file mode is ${mode}; expected 600.`,
      });
    }
  }

  return findings;
}

function collectDuplicateProfilePatterns(homeDir: string): DuplicateProfilePattern[] {
  const profilesDir = join(homeDir, 'tui', 'profiles');
  if (!existsSync(profilesDir)) return [];

  const counts = new Map<string, number>();
  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const normalizedName = entry.name.replace(/^(team-)+/, 'team-');
    counts.set(normalizedName, (counts.get(normalizedName) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([normalizedName, count]) => ({ normalizedName, count }));
}

export async function auditGoodVibesHome(options: HomeAuditOptions): Promise<GoodVibesHomeAudit> {
  const homeDir = resolve(options.homeDir);
  const { files, directoryCountByOwner } = walkFiles(homeDir);
  const summaries = new Map<HomeFileOwner, { files: number; directories: number; bytes: number }>();
  const records: HomeFileRecord[] = [];

  for (const file of files) {
    const stats = statSync(file);
    const relativePath = toPosixRelative(relative(homeDir, file));
    const owner = classifyFile(relativePath);
    const summary = summaries.get(owner) ?? { files: 0, directories: directoryCountByOwner.get(owner) ?? 0, bytes: 0 };
    summary.files += 1;
    summary.bytes += stats.size;
    summaries.set(owner, summary);
    records.push({
      relativePath,
      owner,
      bytes: stats.size,
      mode: (stats.mode & 0o777).toString(8).padStart(3, '0'),
      mtimeIso: stats.mtime.toISOString(),
      sha256: options.includeHashes ? await hashFile(file) : undefined,
    });
  }

  const settings = auditSettings(homeDir);
  const findings = [
    ...collectPermissionFindings(homeDir),
    ...settings.staleCandidates.map((key): HomeAuditFinding => ({
      severity: 'warn',
      code: 'stale-settings-key',
      path: settings.path,
      message: `Setting '${key}' is not in CONFIG_SCHEMA, DEFAULT_CONFIG, or known dynamic config.`,
    })),
  ];

  return {
    homeDir,
    generatedAt: new Date().toISOString(),
    summaries: [...summaries.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([owner, summary]) => ({ owner, ...summary })),
    files: records,
    settings,
    duplicateProfilePatterns: collectDuplicateProfilePatterns(homeDir),
    findings,
    allowedWriteRoots: [...GOODVIBES_ALLOWED_WRITE_ROOTS],
    readOnlyRoots: [...GOODVIBES_READ_ONLY_ROOTS],
  };
}

export async function snapshotGoodVibesHome(homeDir: string): Promise<HomeSnapshot> {
  const root = resolve(homeDir);
  const { files } = walkFiles(root);
  const entries: Record<string, HomeSnapshotEntry> = {};
  for (const file of files) {
    const stats = statSync(file);
    const relativePath = toPosixRelative(relative(root, file));
    entries[relativePath] = {
      relativePath,
      bytes: stats.size,
      mode: (stats.mode & 0o777).toString(8).padStart(3, '0'),
      sha256: await hashFile(file),
    };
  }
  return entries;
}

export function diffHomeSnapshots(before: HomeSnapshot, after: HomeSnapshot): HomeSnapshotDiff {
  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(after));
  const added = [...afterKeys].filter((key) => !beforeKeys.has(key)).sort((a, b) => a.localeCompare(b));
  const removed = [...beforeKeys].filter((key) => !afterKeys.has(key)).sort((a, b) => a.localeCompare(b));
  const changed = [...afterKeys]
    .filter((key) => beforeKeys.has(key))
    .filter((key) => {
      const prior = before[key];
      const next = after[key];
      return prior.sha256 !== next.sha256 || prior.mode !== next.mode || prior.bytes !== next.bytes;
    })
    .sort((a, b) => a.localeCompare(b));
  return { added, removed, changed };
}

export function findDisallowedHomeMutations(
  diff: HomeSnapshotDiff,
  allowedRoots: readonly string[] = GOODVIBES_ALLOWED_WRITE_ROOTS,
): string[] {
  const touched = [...diff.added, ...diff.removed, ...diff.changed];
  return touched
    .filter((relativePath) => !allowedRoots.some((root) => relativePath.startsWith(root)))
    .sort((a, b) => a.localeCompare(b));
}

export function renderGoodVibesHomeAuditMarkdown(audit: GoodVibesHomeAudit): string {
  const lines: string[] = [
    '# GoodVibes Home Audit',
    '',
    `Generated: ${audit.generatedAt}`,
    `Home: \`${audit.homeDir}\``,
    '',
    '## Ownership Summary',
    '',
    '| Owner | Files | Directories | Bytes |',
    '|---|---:|---:|---:|',
    ...audit.summaries.map((summary) => (
      `| ${summary.owner} | ${summary.files} | ${summary.directories} | ${summary.bytes} |`
    )),
    '',
    '## Settings',
    '',
    `Path: \`${audit.settings.path}\``,
    '',
    '| Metric | Count |',
    '|---|---:|',
    `| Schema keys | ${audit.settings.schemaKeyCount} |`,
    `| Persisted leaf keys | ${audit.settings.leafKeyCount} |`,
    `| Current-schema keys | ${audit.settings.recognizedKeyCount} |`,
    `| Missing schema keys | ${audit.settings.missingSchemaKeys.length} |`,
    `| Stale candidates | ${audit.settings.staleCandidates.length} |`,
    '',
  ];

  if (audit.settings.missingSchemaKeys.length > 0) {
    lines.push('### Missing Schema Keys', '');
    for (const key of audit.settings.missingSchemaKeys) lines.push(`- \`${key}\``);
    lines.push('');
  }

  if (audit.settings.staleCandidates.length > 0) {
    lines.push('### Stale Setting Candidates', '');
    for (const key of audit.settings.staleCandidates) lines.push(`- \`${key}\``);
    lines.push('');
  }

  if (audit.duplicateProfilePatterns.length > 0) {
    lines.push('## Duplicate Profile Patterns', '');
    for (const pattern of audit.duplicateProfilePatterns) {
      lines.push(`- \`${pattern.normalizedName}\`: ${pattern.count}`);
    }
    lines.push('');
  }

  lines.push('## Findings', '');
  if (audit.findings.length === 0) {
    lines.push('No findings.');
  } else {
    for (const finding of audit.findings) {
      const path = finding.path ? ` \`${finding.path}\`` : '';
      lines.push(`- ${finding.severity.toUpperCase()} ${finding.code}:${path} ${finding.message}`);
    }
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

export function writeAuditReportFiles(audit: GoodVibesHomeAudit, outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'goodvibes-home-audit.json'), `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
  writeFileSync(join(outputDir, 'goodvibes-home-audit.md'), renderGoodVibesHomeAuditMarkdown(audit), 'utf8');
}
