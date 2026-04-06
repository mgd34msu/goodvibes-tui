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
import type { MemoryBundle, MemoryClass, MemoryReviewState, MemoryScope, MemorySearchFilter } from '../../state/memory-store.ts';
import {
  buildIncidentMemoryAddOptions,
  buildMcpSecurityMemoryAddOptions,
  buildPluginSecurityMemoryAddOptions,
  buildPolicyPreflightMemoryAddOptions,
} from '../../state/memory-ingest.ts';
import { buildKnowledgeInjectionPrompt, selectKnowledgeForTask } from '../../state/knowledge-injection.ts';
import { getPolicyRuntimeState } from '../../runtime/permissions/policy-runtime.ts';
import { pluginManager } from '../../plugins/manager.ts';
import { dirname, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const VALID_CLASSES: MemoryClass[] = ['decision', 'constraint', 'incident', 'pattern', 'fact', 'risk', 'runbook', 'architecture', 'ownership'];
const VALID_SCOPES: MemoryScope[] = ['session', 'project', 'team'];
const VALID_REVIEW_STATES: MemoryReviewState[] = ['fresh', 'reviewed', 'stale', 'contradicted'];

function isValidClass(s: string): s is MemoryClass {
  return VALID_CLASSES.includes(s as MemoryClass);
}

function isValidScope(s: string): s is MemoryScope {
  return VALID_SCOPES.includes(s as MemoryScope);
}

function isValidReviewState(s: string): s is MemoryReviewState {
  return VALID_REVIEW_STATES.includes(s as MemoryReviewState);
}

function resolveBundlePath(pathArg: string): string {
  return resolve(process.cwd(), pathArg);
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
  const scopeIdx  = flagArgs.indexOf('--scope');

  const detail  = detailIdx !== -1 ? flagArgs[detailIdx + 1] : undefined;
  const tagsRaw = tagsIdx   !== -1 ? flagArgs[tagsIdx + 1]   : undefined;
  const scopeRaw = scopeIdx !== -1 ? flagArgs[scopeIdx + 1] : undefined;
  const tags    = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
  const scope = scopeRaw && isValidScope(scopeRaw) ? scopeRaw : 'project';

  if (scopeRaw && !isValidScope(scopeRaw)) {
    context.print(`[recall] Invalid scope "${scopeRaw}". Valid: ${VALID_SCOPES.join(', ')}`);
    return;
  }

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

  const record = await registry.add({ scope, cls, summary, detail, tags, provenance });
  context.print(`[recall] Added ${cls}: ${record.id}`);
  context.print(`  Scope:   ${record.scope}`);
  context.print(`  Summary: ${record.summary}`);
  if (record.tags.length) context.print(`  Tags: ${record.tags.join(', ')}`);
  if (record.provenance.length) {
    context.print(`  Provenance: ${record.provenance.map(p => `${p.kind}:${p.ref}`).join(', ')}`);
  }
}

async function handleCapture(args: string[], context: CommandContext): Promise<void> {
  const registry = context.memoryRegistry;
  if (!registry) {
    context.print('[recall] Memory registry not available.');
    return;
  }
  if (!context.forensicsRegistry) {
    context.print('[recall] Forensics registry not available.');
    return;
  }

  const target = args[0];
  if (target === 'incident') {
    const requestedId = args[1];
    const report = !requestedId || requestedId === 'latest'
      ? context.forensicsRegistry.latest()
      : context.forensicsRegistry.getById(requestedId);
    if (!report) {
      context.print(`[recall] Incident not found: ${requestedId ?? 'latest'}`);
      return;
    }

    const bundle = context.forensicsRegistry.buildBundle(report.id);
    if (!bundle) {
      context.print(`[recall] Failed to build incident bundle: ${report.id}`);
      return;
    }

    const record = await registry.add(buildIncidentMemoryAddOptions(bundle));
    context.print(`[recall] Captured incident ${report.id} into memory as ${record.id}`);
    return;
  }

  if (target === 'policy') {
    const review = getPolicyRuntimeState().getSnapshot().lastPreflightReview;
    if (!review) {
      context.print('[recall] No policy preflight review is available to capture.');
      return;
    }
    const record = await registry.add(buildPolicyPreflightMemoryAddOptions(review));
    context.print(`[recall] Captured policy preflight into memory as ${record.id}`);
    return;
  }

  if (target === 'mcp') {
    const serverName = args[1];
    if (!serverName) {
      context.print('[recall] Usage: /recall capture mcp <server>');
      return;
    }
    const server = context.mcpRegistry.listServerSecurity().find((entry) => entry.name === serverName);
    if (!server) {
      context.print(`[recall] MCP server not found: ${serverName}`);
      return;
    }
    const record = await registry.add(buildMcpSecurityMemoryAddOptions(server));
    context.print(`[recall] Captured MCP server ${server.name} into memory as ${record.id}`);
    return;
  }

  if (target === 'plugin') {
    const pluginName = args[1];
    if (!pluginName) {
      context.print('[recall] Usage: /recall capture plugin <name>');
      return;
    }
    const plugin = pluginManager.list().find((entry) => entry.name === pluginName);
    if (!plugin) {
      context.print(`[recall] Plugin not found: ${pluginName}`);
      return;
    }
    const quarantineReason = pluginManager.getQuarantineRecord(plugin.name)?.reason;
    const record = await registry.add(buildPluginSecurityMemoryAddOptions(plugin, quarantineReason));
    context.print(`[recall] Captured plugin ${plugin.name} into memory as ${record.id}`);
    return;
  }

  context.print('[recall] Usage: /recall capture incident <id|latest> | /recall capture policy | /recall capture mcp <server> | /recall capture plugin <name>');
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
  context.print(`  Scope:   ${record.scope}`);
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
  for (const r of records) {
    if (!grouped[r.cls]) grouped[r.cls] = [];
    grouped[r.cls].push(r);
  }

  for (const [c, group] of Object.entries(grouped)) {
    context.print(`\n[recall] ${c.toUpperCase()} (${group.length}):`);
    for (const r of group) {
      const tagStr = r.tags.length ? ` [${r.tags.join(', ')}]` : '';
      context.print(`  ${r.id} [${r.scope}]${tagStr}  ${r.summary}`);
    }
  }
}

function handleQueue(args: string[], context: CommandContext): void {
  const registry = context.memoryRegistry;
  if (!registry) {
    context.print('[recall] Memory registry not available.');
    return;
  }

  const limit = Math.max(1, parseInt(args[0] ?? '10', 10) || 10);
  const queue = registry.reviewQueue(limit);
  if (!queue.length) {
    context.print('[recall] Review queue is empty.');
    return;
  }

  context.print(`[recall] Review queue (${queue.length}):`);
  for (const record of queue) {
    const reason = record.staleReason ? ` — ${record.staleReason}` : '';
    context.print(`  ${record.id} [${record.scope}/${record.cls}] ${record.reviewState} ${record.confidence}%  ${record.summary}${reason}`);
  }
}

function handleReview(args: string[], context: CommandContext): void {
  const registry = context.memoryRegistry;
  if (!registry) {
    context.print('[recall] Memory registry not available.');
    return;
  }

  const [id, stateRaw, ...rest] = args;
  if (!id || !stateRaw || !isValidReviewState(stateRaw)) {
    context.print(`[recall] Usage: /recall review <id> <${VALID_REVIEW_STATES.join('|')}> [--confidence <0-100>] [--by <name>] [--reason <text>]`);
    return;
  }

  const confidenceIdx = rest.indexOf('--confidence');
  const byIdx = rest.indexOf('--by');
  const reasonIdx = rest.indexOf('--reason');
  const confidence = confidenceIdx !== -1 ? parseInt(rest[confidenceIdx + 1] ?? '', 10) : undefined;
  const reviewedBy = byIdx !== -1 ? rest[byIdx + 1] : 'operator';
  const staleReason = reasonIdx !== -1 ? rest.slice(reasonIdx + 1).join(' ') : undefined;

  const record = registry.review(id, {
    state: stateRaw,
    confidence: Number.isFinite(confidence) ? confidence : undefined,
    reviewedBy,
    staleReason,
  });

  if (!record) {
    context.print(`[recall] Record not found: ${id}`);
    return;
  }

  context.print(`[recall] Reviewed ${record.id}: ${record.reviewState} ${record.confidence}%`);
}

function handleExplain(args: string[], context: CommandContext): void {
  const registry = context.memoryRegistry;
  if (!registry) {
    context.print('[recall] Memory registry not available.');
    return;
  }

  const scopeIdx = args.indexOf('--scope');
  const scopeValues = scopeIdx !== -1
    ? args.slice(scopeIdx + 1).filter((token) => !token.startsWith('--'))
    : [];
  const taskTokens = args.filter((token, index) => {
    if (token === '--scope') return false;
    if (scopeIdx !== -1 && index > scopeIdx) return false;
    return true;
  });
  const task = taskTokens.join(' ').trim();
  if (!task) {
    context.print('[recall] Usage: /recall explain <task description...> [--scope <write-scope> ...]');
    return;
  }

  const injections = selectKnowledgeForTask(task, scopeValues);
  if (injections.length === 0) {
    context.print('[recall] No reviewed project knowledge was selected for that task.');
    return;
  }

  const prompt = buildKnowledgeInjectionPrompt(injections);
  context.print(prompt ?? '[recall] No explainable project knowledge was selected.');
}

function handlePromote(args: string[], context: CommandContext): void {
  const registry = context.memoryRegistry;
  if (!registry) {
    context.print('[recall] Memory registry not available.');
    return;
  }

  const id = args[0];
  const scope = args[1];
  if (!id || !scope || !isValidScope(scope)) {
    context.print(`[recall] Usage: /recall promote <id> <${VALID_SCOPES.join('|')}>`);
    return;
  }

  const record = registry.update(id, { scope });
  if (!record) {
    context.print(`[recall] Record not found: ${id}`);
    return;
  }

  context.print(`[recall] Promoted ${record.id} to ${record.scope} scope.`);
}

function handleExport(args: string[], context: CommandContext): void {
  const registry = context.memoryRegistry;
  if (!registry) {
    context.print('[recall] Memory registry not available.');
    return;
  }

  const pathArg = args[0];
  if (!pathArg) {
    context.print('[recall] Usage: /recall export <path> [--scope <scope>] [--cls <class>]');
    return;
  }

  const filter: MemorySearchFilter = {};
  const scopeIdx = args.indexOf('--scope');
  if (scopeIdx !== -1 && args[scopeIdx + 1]) {
    const scope = args[scopeIdx + 1];
    if (!isValidScope(scope)) {
      context.print(`[recall] Unknown scope "${scope}". Valid: ${VALID_SCOPES.join(', ')}`);
      return;
    }
    filter.scope = scope;
  }
  const clsIdx = args.indexOf('--cls');
  if (clsIdx !== -1 && args[clsIdx + 1]) {
    const cls = args[clsIdx + 1];
    if (!isValidClass(cls)) {
      context.print(`[recall] Unknown class "${cls}". Valid: ${VALID_CLASSES.join(', ')}`);
      return;
    }
    filter.cls = cls;
  }

  const bundle = registry.exportBundle(filter);
  const targetPath = resolveBundlePath(pathArg);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
  context.print(`[recall] Exported ${bundle.recordCount} record(s) and ${bundle.linkCount} link(s) to ${targetPath}`);
}

async function handleImport(args: string[], context: CommandContext): Promise<void> {
  const registry = context.memoryRegistry;
  if (!registry) {
    context.print('[recall] Memory registry not available.');
    return;
  }

  const pathArg = args[0];
  if (!pathArg) {
    context.print('[recall] Usage: /recall import <path>');
    return;
  }

  const targetPath = resolveBundlePath(pathArg);
  let bundle: MemoryBundle;
  try {
    bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as MemoryBundle;
  } catch (error) {
    context.print(`[recall] Failed to read memory bundle: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const result = await registry.importBundle(bundle);
  context.print(`[recall] Imported bundle from ${targetPath}`);
  context.print(`  Records: imported=${result.importedRecords} skipped=${result.skippedRecords}`);
  context.print(`  Links:   imported=${result.importedLinks}`);
}

function handleHandoffExport(args: string[], context: CommandContext): void {
  const registry = context.memoryRegistry;
  if (!registry) {
    context.print('[recall] Memory registry not available.');
    return;
  }

  const pathArg = args[0];
  if (!pathArg) {
    context.print('[recall] Usage: /recall handoff-export <path> [--scope <scope>]');
    return;
  }

  const scopeIdx = args.indexOf('--scope');
  const scopeRaw = scopeIdx !== -1 ? args[scopeIdx + 1] : 'team';
  if (!scopeRaw || !isValidScope(scopeRaw)) {
    context.print(`[recall] Unknown scope "${scopeRaw ?? ''}". Valid: ${VALID_SCOPES.join(', ')}`);
    return;
  }
  const bundle = registry.exportBundle({ scope: scopeRaw });
  const targetPath = resolveBundlePath(pathArg);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
  context.print(`[recall] Exported ${scopeRaw} handoff bundle to ${targetPath}`);
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

      case 'capture':
        await handleCapture(rest, context);
        break;

      case 'get':
      case 'show':
        handleGet(rest, context);
        break;

      case 'queue':
        handleQueue(rest, context);
        break;

      case 'review':
        handleReview(rest, context);
        break;

      case 'stale':
        handleReview([rest[0] ?? '', 'stale', '--reason', ...rest.slice(1)], context);
        break;

      case 'contradict':
      case 'contradicted':
        handleReview([rest[0] ?? '', 'contradicted', '--reason', ...rest.slice(1)], context);
        break;

      case 'explain':
        handleExplain(rest, context);
        break;

      case 'promote':
        handlePromote(rest, context);
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

      case 'export':
        handleExport(rest, context);
        break;

      case 'import':
        await handleImport(rest, context);
        break;

      case 'handoff-export':
      case 'share':
        handleHandoffExport(rest, context);
        break;

      default: {
        const usage = [
          'Usage: /recall <subcommand>',
          '  add <class> <summary> [--scope <session|project|team>] [--detail <text>] [--tags <t,t>] [--session <id>] [--task <id>] [--file <path>]',
          `       classes: ${VALID_CLASSES.join(', ')}`,
          '  capture incident <id|latest>                    — Capture a forensics incident as durable memory',
          '  capture policy                                  — Capture the latest policy preflight review as durable memory',
          '  capture mcp <server>                            — Capture MCP trust/quarantine posture as durable memory',
          '  capture plugin <name>                           — Capture plugin trust/quarantine posture as durable memory',
          '  search [query] [--cls <class>] [--scope <scope>] [--limit <n>]  — Full-text + filter search',
          '  get <id>                                       — Show record with provenance + links',
          '  link <fromId> <toId> <relation>               — Create a directed relation between records',
          '  queue [limit]                                  — Show the operator review queue',
          '  review <id> <state> [--confidence <n>] [--by <name>] [--reason <text>]',
          '  stale <id> [reason...]                          — Mark a record stale with an operator reason',
          '  contradict <id> [reason...]                     — Mark a record contradicted with an operator reason',
          '  explain <task...> [--scope <path> ...]         — Show the knowledge records that would be injected for a task',
          '  promote <id> <scope>                           — Promote a memory record into session|project|team scope',
          '  export <path> [--scope <scope>] [--cls <class>] — Export a durable knowledge bundle',
          '  import <path>                                  — Import a durable knowledge bundle',
          '  handoff-export <path> [--scope <scope>]        — Export a reviewable handoff bundle for team/shared use',
          '  list [class] [--scope <scope>]                 — List all records grouped by class',
          '  remove <id>                                    — Delete a record',
        ].join('\n');
        context.print(usage);
        break;
      }
    }
  },
};
