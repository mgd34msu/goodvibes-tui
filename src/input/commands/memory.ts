/**
 * /recall command handler.
 *
 * Implements the Project Memory Substrate commands:
 *
 *   /recall add <class> <summary>           — Add a new memory record
 *   /recall add <class> <summary> --detail <text> --tags <tag,tag>
 *   /recall search [query]                  — Search memory records
 *   /recall search --cls <class>            — Filter by class
 *   /recall link <fromId> <toId> <relation> — Link two records
 *   /recall get <id>                        — Show a single record with provenance
 *   /recall list [class]                    — List all records (optionally by class)
 *   /recall remove <id>                     — Delete a record
 */

import type { SlashCommand, CommandContext } from '../command-registry.ts';
import type { MemoryClass, MemorySearchFilter } from '../../state/memory-store.ts';

const VALID_CLASSES: MemoryClass[] = ['decision', 'constraint', 'incident', 'pattern'];

function isValidClass(s: string): s is MemoryClass {
  return VALID_CLASSES.includes(s as MemoryClass);
}

// ── /recall add ───────────────────────────────────────────────────────────────

async function handleAdd(args: string[], context: CommandContext): Promise<void> {
  const registry = context.memoryRegistry;
  if (!registry) {
    context.print('[recall] Memory registry not available.');
    return;
  }

  const cls = args[0];
  if (!cls || !isValidClass(cls)) {
    context.print(
      `[recall] Invalid class "${cls ?? ''}". Valid: ${VALID_CLASSES.join(', ')}`,
    );
    return;
  }

  // Parse flags: --detail <text> --tags <t1,t2> --session <id> --task <id> --file <path>
  const flagArgs = args.slice(1);
  const detailIdx = flagArgs.indexOf('--detail');
  const tagsIdx   = flagArgs.indexOf('--tags');
  const sessionIdx = flagArgs.indexOf('--session');
  const taskIdx   = flagArgs.indexOf('--task');
  const fileIdx   = flagArgs.indexOf('--file');

  const detail  = detailIdx !== -1 ? flagArgs[detailIdx + 1] : undefined;
  const tagsRaw = tagsIdx   !== -1 ? flagArgs[tagsIdx + 1]   : undefined;
  const tags    = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

  // Build provenance from flags
  const provenance: import('../../state/memory-store.ts').ProvenanceLink[] = [];
  if (sessionIdx !== -1 && flagArgs[sessionIdx + 1]) {
    provenance.push({ kind: 'session', ref: flagArgs[sessionIdx + 1] });
  }
  if (taskIdx !== -1 && flagArgs[taskIdx + 1]) {
    provenance.push({ kind: 'task', ref: flagArgs[taskIdx + 1] });
  }
  if (fileIdx !== -1 && flagArgs[fileIdx + 1]) {
    provenance.push({ kind: 'file', ref: flagArgs[fileIdx + 1] });
  }
  // Auto-link to current session if available
  if (!provenance.some(p => p.kind === 'session') && context.runtime.sessionId) {
    provenance.push({ kind: 'session', ref: context.runtime.sessionId });
  }

  // Summary: everything before the first flag (or everything if no flags)
  const summaryTokens: string[] = [];
  for (const token of flagArgs) {
    if (token.startsWith('--')) break;
    summaryTokens.push(token);
  }
  const summary = summaryTokens.join(' ');

  if (!summary.trim()) {
    context.print('[recall] Usage: /recall add <class> <summary> [--detail <text>] [--tags <t1,t2>]');
    return;
  }

  const record = await registry.add({ cls, summary, detail, tags, provenance });
  context.print(`[recall] Added ${cls}: ${record.id}`);
  context.print(`  Summary: ${record.summary}`);
  if (record.tags.length) context.print(`  Tags: ${record.tags.join(', ')}`);
  if (record.provenance.length) {
    context.print(`  Provenance: ${record.provenance.map(p => `${p.kind}:${p.ref}`).join(', ')}`);
  }
}

// ── /recall search ─────────────────────────────────────────────────────────

function handleSearch(args: string[], context: CommandContext): void {
  const registry = context.memoryRegistry;
  if (!registry) {
    context.print('[recall] Memory registry not available.');
    return;
  }

  const clsIdx = args.indexOf('--cls');
  const limitIdx = args.indexOf('--limit');

  const filter: MemorySearchFilter = {};

  if (clsIdx !== -1 && args[clsIdx + 1]) {
    const c = args[clsIdx + 1];
    if (isValidClass(c)) filter.cls = c;
    else {
      context.print(`[recall] Unknown class "${c}". Valid: ${VALID_CLASSES.join(', ')}`);
      return;
    }
  }

  if (limitIdx !== -1 && args[limitIdx + 1]) {
    filter.limit = parseInt(args[limitIdx + 1], 10) || 20;
  }

  // Everything that isn't a flag is treated as free-text query
  const queryTokens = args.filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (i > 0 && args[i - 1].startsWith('--')) return false;
    return true;
  });
  if (queryTokens.length) filter.query = queryTokens.join(' ');

  const results = registry.search(filter);

  if (!results.length) {
    context.print('[recall] No records found.');
    return;
  }

  context.print(`[recall] ${results.length} record(s):`);
  for (const r of results) {
    const ts = new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    const tagStr = r.tags.length ? ` [${r.tags.join(', ')}]` : '';
    context.print(`  ${r.id}  [${r.cls}]${tagStr}  ${ts}`);
    context.print(`    ${r.summary}`);
    if (r.provenance.length) {
      context.print(`    via: ${r.provenance.map(p => `${p.kind}:${p.ref}`).join(', ')}`);
    }
  }
}

// ── /recall get ───────────────────────────────────────────────────────────────

function handleGet(args: string[], context: CommandContext): void {
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
  context.print(`  Class:   ${record.cls}`);
  context.print(`  Summary: ${record.summary}`);
  if (record.detail) context.print(`  Detail:  ${record.detail}`);
  if (record.tags.length) context.print(`  Tags:    ${record.tags.join(', ')}`);
  context.print(`  Created: ${ts}`);

  if (record.provenance.length) {
    context.print('  Provenance:');
    for (const p of record.provenance) {
      const label = p.label ? ` (${p.label})` : '';
      context.print(`    ${p.kind}: ${p.ref}${label}`);
    }
  }

  const links = registry.linksFor(id);
  if (links.length) {
    context.print('  Links:');
    for (const l of links) {
      const dir = l.fromId === id ? '->' : '<-';
      const other = l.fromId === id ? l.toId : l.fromId;
      context.print(`    ${dir} ${other}  [${l.relation}]`);
    }
  }
}

// ── /recall link ──────────────────────────────────────────────────────────────

async function handleLink(args: string[], context: CommandContext): Promise<void> {
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

// ── /recall remove ────────────────────────────────────────────────────────────

function handleRemove(args: string[], context: CommandContext): void {
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

// ── /recall list ──────────────────────────────────────────────────────────────

function handleList(args: string[], context: CommandContext): void {
  const registry = context.memoryRegistry;
  if (!registry) {
    context.print('[recall] Memory registry not available.');
    return;
  }

  const cls = args[0];
  const filter: MemorySearchFilter = { limit: 50 };
  if (cls && isValidClass(cls)) filter.cls = cls;

  const records = registry.search(filter);

  if (!records.length) {
    context.print('[recall] No records.');
    return;
  }

  const grouped: Record<string, typeof records> = {};
  for (const r of records) {
    if (!grouped[r.cls]) grouped[r.cls] = [];
    grouped[r.cls].push(r);
  }

  for (const [c, group] of Object.entries(grouped)) {
    context.print(`\n[recall] ${c.toUpperCase()} (${group.length}):`);
    for (const r of group) {
      const tagStr = r.tags.length ? ` [${r.tags.join(', ')}]` : '';
      context.print(`  ${r.id}${tagStr}  ${r.summary}`);
    }
  }
}

// ── Top-level command ─────────────────────────────────────────────────────────

export const recallCommand: SlashCommand = {
  name: 'recall',
  aliases: ['rc'],
  description: 'Project memory: add decisions, constraints, incidents, and patterns with provenance.',
  usage: '<subcommand> [args]',
  argsHint: 'add|search|link|get|list|remove',
  handler: async (args: string[], context: CommandContext): Promise<void> => {
    const [sub, ...rest] = args;

    switch (sub) {
      case 'add':
        await handleAdd(rest, context);
        break;

      case 'search':
      case 'find':
        handleSearch(rest, context);
        break;

      case 'get':
      case 'show':
        handleGet(rest, context);
        break;

      case 'link':
        await handleLink(rest, context);
        break;

      case 'list':
      case 'ls':
        handleList(rest, context);
        break;

      case 'remove':
      case 'delete':
      case 'rm':
        handleRemove(rest, context);
        break;

      default: {
        const usage = [
          'Usage: /recall <subcommand>',
          '  add <class> <summary> [--detail <text>] [--tags <t,t>] [--session <id>] [--task <id>] [--file <path>]',
          `       classes: ${VALID_CLASSES.join(', ')}`,
          '  search [query] [--cls <class>] [--limit <n>]  — Full-text + filter search',
          '  get <id>                                       — Show record with provenance + links',
          '  link <fromId> <toId> <relation>               — Create a directed relation between records',
          '  list [class]                                   — List all records grouped by class',
          '  remove <id>                                    — Delete a record',
        ].join('\n');
        context.print(usage);
        break;
      }
    }
  },
};
