import type { CommandContext } from '../command-registry.ts';
import type { MemorySearchFilter } from '../../state/memory-store.ts';
import { VALID_CLASSES, VALID_SCOPES, isValidClass, isValidScope } from './recall-shared.ts';

export function handleRecallSearch(args: string[], context: CommandContext): void {
  const registry = context.memoryRegistry;
  if (!registry) {
    context.print('[recall] Memory registry not available.');
    return;
  }

  const clsIdx = args.indexOf('--cls');
  const limitIdx = args.indexOf('--limit');
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
    if (index > 0 && args[index - 1].startsWith('--')) return false;
    return true;
  });
  if (queryTokens.length) filter.query = queryTokens.join(' ');

  const results = registry.search(filter);
  if (!results.length) {
    context.print('[recall] No records found.');
    return;
  }

  context.print(`[recall] ${results.length} record(s):`);
  for (const record of results) {
    const ts = new Date(record.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    const tagStr = record.tags.length ? ` [${record.tags.join(', ')}]` : '';
    context.print(`  ${record.id}  [${record.cls}]${tagStr}  ${ts}`);
    context.print(`    ${record.summary}`);
    if (record.provenance.length) {
      context.print(`    via: ${record.provenance.map((entry) => `${entry.kind}:${entry.ref}`).join(', ')}`);
    }
  }
}

export function handleRecallGet(args: string[], context: CommandContext): void {
  const registry = context.memoryRegistry;
  if (!registry) {
    context.print('[recall] Memory registry not available.');
    return;
  }
  const id = args[0];
  if (!id) {
    context.print('[recall] Usage: /recall get <id>');
    return;
  }
  const record = registry.get(id);
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

  const links = registry.linksFor(id);
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
  const registry = context.memoryRegistry;
  if (!registry) {
    context.print('[recall] Memory registry not available.');
    return;
  }
  const [fromId, toId, relation] = args;
  if (!fromId || !toId || !relation) {
    context.print('[recall] Usage: /recall link <fromId> <toId> <relation>');
    return;
  }
  const link = await registry.link(fromId, toId, relation);
  if (!link) {
    context.print('[recall] Link failed — check that both IDs exist.');
    return;
  }
  context.print(`[recall] Linked: ${fromId} -> ${toId} [${relation}]`);
}

export function handleRecallRemove(args: string[], context: CommandContext): void {
  const registry = context.memoryRegistry;
  if (!registry) {
    context.print('[recall] Memory registry not available.');
    return;
  }
  const id = args[0];
  if (!id) {
    context.print('[recall] Usage: /recall remove <id>');
    return;
  }
  const removed = registry.delete(id);
  if (!removed) {
    context.print(`[recall] Record not found: ${id}`);
    return;
  }
  context.print(`[recall] Deleted: ${id}`);
}

export function handleRecallList(args: string[], context: CommandContext): void {
  const registry = context.memoryRegistry;
  if (!registry) {
    context.print('[recall] Memory registry not available.');
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

  const records = registry.search(filter);
  if (!records.length) {
    context.print('[recall] No records.');
    return;
  }

  const grouped: Record<string, typeof records> = {};
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
