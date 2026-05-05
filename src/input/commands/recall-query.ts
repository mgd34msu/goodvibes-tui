import type { CommandContext } from '../command-registry.ts';
import type { MemoryApi } from '@pellux/goodvibes-sdk/platform/knowledge';
import type { MemorySearchFilter } from '@pellux/goodvibes-sdk/platform/state';
import { VALID_CLASSES, VALID_SCOPES, isValidClass, isValidScope } from './recall-shared.ts';

export function getMemoryApi(context: CommandContext): MemoryApi | null {
  const memoryApi = context.clients?.knowledgeApi?.memory;
  if (!memoryApi) {
    context.print('[recall] Memory API is not available in this runtime.');
    return null;
  }
  return memoryApi;
}

export function handleRecallSearch(args: string[], context: CommandContext): void {
  const memory = getMemoryApi(context);
  if (!memory) {
    return;
  }

  const clsIdx = args.indexOf('--cls');
  const limitIdx = args.indexOf('--limit');
  const semantic = args.includes('--semantic') || args.includes('--vector');
  const filter: MemorySearchFilter = {};

  if (clsIdx !== -1 && args[clsIdx + 1]) {
    const cls = args[clsIdx + 1];
    if (isValidClass(cls)) filter.cls = cls;
    else {
      context.print(`[recall] Unknown class "${cls}". Valid: ${VALID_CLASSES.join(', ')}`);
      return;
    }
  }

  const scopeIdx = args.indexOf('--scope');
  if (scopeIdx !== -1 && args[scopeIdx + 1]) {
    const scope = args[scopeIdx + 1];
    if (isValidScope(scope)) filter.scope = scope;
    else {
      context.print(`[recall] Unknown scope "${scope}". Valid: ${VALID_SCOPES.join(', ')}`);
      return;
    }
  }

  if (limitIdx !== -1 && args[limitIdx + 1]) {
    filter.limit = parseInt(args[limitIdx + 1], 10) || 20;
  }

  const queryTokens = args.filter((token, index) => {
    if (token.startsWith('--')) return false;
    if (index > 0 && ['--cls', '--limit', '--scope'].includes(args[index - 1]!)) return false;
    return true;
  });
  if (queryTokens.length) filter.query = queryTokens.join(' ');
  if (semantic) filter.semantic = true;

  const semanticResults = semantic ? memory.searchSemantic(filter) : [];
  const results = semantic ? semanticResults.map((entry) => entry.record) : memory.search(filter);
  if (!results.length) {
    context.print('[recall] No records found.');
    return;
  }

  context.print(`[recall] ${results.length} ${semantic ? 'semantic ' : ''}record(s):`);
  for (const record of results) {
    const semanticEntry = semanticResults.find((entry) => entry.record.id === record.id);
    const ts = new Date(record.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    const tagStr = record.tags.length ? ` [${record.tags.join(', ')}]` : '';
    const scoreStr = semanticEntry ? `  sim ${Math.round(semanticEntry.similarity * 100)}%` : '';
    context.print(`  ${record.id}  [${record.cls}]${tagStr}  ${ts}${scoreStr}`);
    context.print(`    ${record.summary}`);
    if (record.provenance.length) {
      context.print(`    via: ${record.provenance.map((entry) => `${entry.kind}:${entry.ref}`).join(', ')}`);
    }
  }
}

export function handleRecallVector(args: string[], context: CommandContext): void {
  const memory = getMemoryApi(context);
  if (!memory) {
    return;
  }

  const sub = (args[0] ?? 'status').toLowerCase();
  if (sub === 'rebuild') {
    const stats = memory.rebuildVectors();
    context.print(formatVectorStats(stats, 'rebuild complete'));
    return;
  }
  if (sub === 'status' || sub === 'doctor') {
    context.print(formatVectorStats(memory.vectorStats(), sub));
    return;
  }
  context.print('[recall] Usage: /recall vector [status|doctor|rebuild]');
}

function formatVectorStats(
  stats: ReturnType<MemoryApi['vectorStats']>,
  label: string,
): string {
  return [
    `[recall] Vector index ${label}`,
    `  backend: ${stats.backend}`,
    `  enabled: ${stats.enabled ? 'yes' : 'no'}`,
    `  available: ${stats.available ? 'yes' : 'no'}`,
    `  dimensions: ${stats.dimensions}`,
    `  indexed records: ${stats.indexedRecords}`,
    ...(stats.path ? [`  path: ${stats.path}`] : []),
    ...(stats.error ? [`  error: ${stats.error}`] : []),
  ].join('\n');
}

export function handleRecallGet(args: string[], context: CommandContext): void {
  const memory = getMemoryApi(context);
  if (!memory) {
    return;
  }
  const id = args[0];
  if (!id) {
    context.print('[recall] Usage: /recall get <id>');
    return;
  }
  const record = memory.get(id);
  if (!record) {
    context.print(`[recall] Record not found: ${id}`);
    return;
  }
  const ts = new Date(record.createdAt).toISOString().slice(0, 19).replace('T', ' ');
  context.print(`[recall] ${record.id}`);
  context.print(`  Scope:   ${record.scope}`);
  context.print(`  Class:   ${record.cls}`);
  context.print(`  Summary: ${record.summary}`);
  if (record.detail) context.print(`  Detail:  ${record.detail}`);
  if (record.tags.length) context.print(`  Tags:    ${record.tags.join(', ')}`);
  context.print(`  Created: ${ts}`);

  if (record.provenance.length) {
    context.print('  Provenance:');
    for (const provenance of record.provenance) {
      const label = provenance.label ? ` (${provenance.label})` : '';
      context.print(`    ${provenance.kind}: ${provenance.ref}${label}`);
    }
  }

  const links = memory.linksFor(id);
  if (links.length) {
    context.print('  Links:');
    for (const link of links) {
      const dir = link.fromId === id ? '->' : '<-';
      const other = link.fromId === id ? link.toId : link.fromId;
      context.print(`    ${dir} ${other}  [${link.relation}]`);
    }
  }
}

export async function handleRecallLink(args: string[], context: CommandContext): Promise<void> {
  const memory = getMemoryApi(context);
  if (!memory) {
    return;
  }
  const [fromId, toId, relation] = args;
  if (!fromId || !toId || !relation) {
    context.print('[recall] Usage: /recall link <fromId> <toId> <relation>');
    return;
  }
  const link = await memory.link(fromId, toId, relation);
  if (!link) {
    context.print('[recall] Link failed — check that both IDs exist.');
    return;
  }
  context.print(`[recall] Linked: ${fromId} -> ${toId} [${relation}]`);
}

export function handleRecallRemove(args: string[], context: CommandContext): void {
  const memory = getMemoryApi(context);
  if (!memory) {
    return;
  }
  const id = args[0];
  if (!id) {
    context.print('[recall] Usage: /recall remove <id>');
    return;
  }
  const removed = memory.delete(id);
  if (!removed) {
    context.print(`[recall] Record not found: ${id}`);
    return;
  }
  context.print(`[recall] Deleted: ${id}`);
}

export function handleRecallList(args: string[], context: CommandContext): void {
  const memory = getMemoryApi(context);
  if (!memory) {
    return;
  }
  const cls = args.find((arg) => !arg.startsWith('--'));
  const filter: MemorySearchFilter = { limit: 50 };
  if (cls && isValidClass(cls)) filter.cls = cls;
  const scopeIdx = args.indexOf('--scope');
  if (scopeIdx !== -1 && args[scopeIdx + 1]) {
    const scope = args[scopeIdx + 1];
    if (!isValidScope(scope)) {
      context.print(`[recall] Unknown scope "${scope}". Valid: ${VALID_SCOPES.join(', ')}`);
      return;
    }
    filter.scope = scope;
  }

  const records = memory.search(filter);
  if (!records.length) {
    context.print('[recall] No records.');
    return;
  }

  const grouped: Record<string, Array<(typeof records)[number]>> = {};
  for (const record of records) {
    if (!grouped[record.cls]) grouped[record.cls] = [];
    grouped[record.cls].push(record);
  }

  for (const [clsName, group] of Object.entries(grouped)) {
    context.print(`\n[recall] ${clsName.toUpperCase()} (${group.length}):`);
    for (const record of group) {
      const tagStr = record.tags.length ? ` [${record.tags.join(', ')}]` : '';
      context.print(`  ${record.id} [${record.scope}]${tagStr}  ${record.summary}`);
    }
  }
}
