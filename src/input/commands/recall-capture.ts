import type { CommandContext } from '../command-registry.ts';
import type { ProvenanceLink } from '@pellux/goodvibes-sdk/platform/state';
import {
  buildIncidentMemoryAddOptions,
  buildMcpSecurityMemoryAddOptions,
  buildPluginSecurityMemoryAddOptions,
  buildPolicyPreflightMemoryAddOptions,
} from '@pellux/goodvibes-sdk/platform/state';
import { VALID_CLASSES, VALID_SCOPES, isValidClass, isValidScope } from './recall-shared.ts';
import { getMemoryApi } from './recall-query.ts';

export async function handleRecallAdd(args: string[], context: CommandContext): Promise<void> {
  const memory = getMemoryApi(context);
  if (!memory) {
    return;
  }

  const cls = args[0];
  if (!cls || !isValidClass(cls)) {
    context.print(`[recall] Invalid class "${cls ?? ''}". Valid: ${VALID_CLASSES.join(', ')}`);
    return;
  }

  const flagArgs = args.slice(1);
  const detailIdx = flagArgs.indexOf('--detail');
  const tagsIdx = flagArgs.indexOf('--tags');
  const sessionIdx = flagArgs.indexOf('--session');
  const taskIdx = flagArgs.indexOf('--task');
  const fileIdx = flagArgs.indexOf('--file');
  const scopeIdx = flagArgs.indexOf('--scope');

  const detail = detailIdx !== -1 ? flagArgs[detailIdx + 1] : undefined;
  const tagsRaw = tagsIdx !== -1 ? flagArgs[tagsIdx + 1] : undefined;
  const scopeRaw = scopeIdx !== -1 ? flagArgs[scopeIdx + 1] : undefined;
  const tags = tagsRaw ? tagsRaw.split(',').map((token) => token.trim()).filter(Boolean) : [];
  const scope = scopeRaw && isValidScope(scopeRaw) ? scopeRaw : 'project';

  if (scopeRaw && !isValidScope(scopeRaw)) {
    context.print(`[recall] Invalid scope "${scopeRaw}". Valid: ${VALID_SCOPES.join(', ')}`);
    return;
  }

  const provenance: ProvenanceLink[] = [];
  if (sessionIdx !== -1 && flagArgs[sessionIdx + 1]) provenance.push({ kind: 'session', ref: flagArgs[sessionIdx + 1] });
  if (taskIdx !== -1 && flagArgs[taskIdx + 1]) provenance.push({ kind: 'task', ref: flagArgs[taskIdx + 1] });
  if (fileIdx !== -1 && flagArgs[fileIdx + 1]) provenance.push({ kind: 'file', ref: flagArgs[fileIdx + 1] });
  if (!provenance.some((entry) => entry.kind === 'session') && context.session.runtime.sessionId) {
    provenance.push({ kind: 'session', ref: context.session.runtime.sessionId });
  }

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

  const record = await memory.add({ scope, cls, summary, detail, tags, provenance });
  context.print(`[recall] Added ${cls}: ${record.id}`);
  context.print(`  Scope:   ${record.scope}`);
  context.print(`  Summary: ${record.summary}`);
  if (record.tags.length) context.print(`  Tags: ${record.tags.join(', ')}`);
  if (record.provenance.length) {
    context.print(`  Provenance: ${record.provenance.map((entry) => `${entry.kind}:${entry.ref}`).join(', ')}`);
  }
}

export async function handleRecallCapture(args: string[], context: CommandContext): Promise<void> {
  const memory = getMemoryApi(context);
  const pluginManager = context.extensions.pluginManager;
  if (!memory) {
    return;
  }
  if (!context.extensions.forensicsRegistry) {
    context.print('[recall] Forensics registry not available.');
    return;
  }

  const target = args[0];
  if (target === 'incident') {
    const requestedId = args[1];
    const report = !requestedId || requestedId === 'latest'
      ? context.extensions.forensicsRegistry.latest()
      : context.extensions.forensicsRegistry.getById(requestedId);
    if (!report) {
      context.print(`[recall] Incident not found: ${requestedId ?? 'latest'}`);
      return;
    }
    const bundle = context.extensions.forensicsRegistry.buildBundle(report.id);
    if (!bundle) {
      context.print(`[recall] Failed to build incident bundle: ${report.id}`);
      return;
    }
    const record = await memory.add(buildIncidentMemoryAddOptions(bundle));
    context.print(`[recall] Captured incident ${report.id} into memory as ${record.id}`);
    return;
  }

  if (target === 'policy') {
    const review = context.extensions.policyRuntimeState?.getSnapshot().lastPreflightReview;
    if (!review) {
      context.print('[recall] No policy preflight review is available to capture.');
      return;
    }
    const record = await memory.add(buildPolicyPreflightMemoryAddOptions(review));
    context.print(`[recall] Captured policy preflight into memory as ${record.id}`);
    return;
  }

  if (target === 'mcp') {
    const serverName = args[1];
    if (!serverName) {
      context.print('[recall] Usage: /recall capture mcp <server>');
      return;
    }
    const server = context.extensions.mcpRegistry.listServerSecurity().find((entry) => entry.name === serverName);
    if (!server) {
      context.print(`[recall] MCP server not found: ${serverName}`);
      return;
    }
    const record = await memory.add(buildMcpSecurityMemoryAddOptions(server));
    context.print(`[recall] Captured MCP server ${server.name} into memory as ${record.id}`);
    return;
  }

  if (target === 'plugin') {
    if (!pluginManager) {
      context.print('[recall] Plugin manager not available.');
      return;
    }
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
    const record = await memory.add(buildPluginSecurityMemoryAddOptions(plugin, quarantineReason));
    context.print(`[recall] Captured plugin ${plugin.name} into memory as ${record.id}`);
    return;
  }

  context.print('[recall] Usage: /recall capture incident <id|latest> | /recall capture policy | /recall capture mcp <server> | /recall capture plugin <name>');
}
