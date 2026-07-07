import { dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { CommandContext } from '../command-registry.ts';
import type { MemoryBundle, MemorySearchFilter } from '@pellux/goodvibes-sdk/platform/state';
import { VALID_CLASSES, VALID_SCOPES, isValidClass, isValidScope, resolveBundlePath } from './recall-shared.ts';
import { requireShellPaths } from './runtime-services.ts';
import { getMemorySpine } from './recall-query.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

export async function handleRecallExport(args: string[], context: CommandContext): Promise<void> {
  const memory = getMemorySpine(context);
  if (!memory) {
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

  const bundle = await memory.exportBundle(filter);
  const targetPath = resolveBundlePath(pathArg, requireShellPaths(context));
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
  context.print(`[recall] Exported ${bundle.recordCount} record(s) and ${bundle.linkCount} link(s) to ${targetPath}`);
}

export async function handleRecallImport(args: string[], context: CommandContext): Promise<void> {
  const memory = getMemorySpine(context);
  if (!memory) {
    return;
  }

  const pathArg = args[0];
  if (!pathArg) {
    context.print('[recall] Usage: /recall import <path>');
    return;
  }

  const targetPath = resolveBundlePath(pathArg, requireShellPaths(context));
  let bundle: MemoryBundle;
  try {
    bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as MemoryBundle;
  } catch (error) {
    context.print(`[recall] Failed to read memory bundle: ${summarizeError(error)}`);
    return;
  }

  const result = await memory.importBundle(bundle);
  context.print(`[recall] Imported bundle from ${targetPath}`);
  context.print(`  Records: imported=${result.importedRecords} skipped=${result.skippedRecords}`);
  context.print(`  Links:   imported=${result.importedLinks}`);
}

function inspectBundle(bundle: MemoryBundle): string {
  return [
    'Memory Handoff Review',
    `  scope: ${bundle.scope}`,
    `  records: ${bundle.recordCount}`,
    `  links: ${bundle.linkCount}`,
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
  ].join('\n');
}

export async function handleRecallHandoffExport(args: string[], context: CommandContext): Promise<void> {
  const memory = getMemorySpine(context);
  if (!memory) {
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
  const bundle = await memory.exportBundle({ scope: scopeRaw });
  const targetPath = resolveBundlePath(pathArg, requireShellPaths(context));
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
  context.print(`[recall] Exported ${scopeRaw} handoff bundle to ${targetPath}`);
}

export function handleRecallHandoffInspect(args: string[], context: CommandContext): void {
  const pathArg = args[0];
  if (!pathArg) {
    context.print('[recall] Usage: /recall handoff-inspect <path>');
    return;
  }
  const targetPath = resolveBundlePath(pathArg, requireShellPaths(context));
  try {
    const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as MemoryBundle;
    context.print(inspectBundle(bundle));
  } catch (error) {
    context.print(`[recall] Failed to inspect handoff bundle: ${summarizeError(error)}`);
  }
}

export async function handleRecallHandoffImport(args: string[], context: CommandContext): Promise<void> {
  const pathArg = args[0];
  if (!pathArg) {
    context.print('[recall] Usage: /recall handoff-import <path>');
    return;
  }
  await handleRecallImport([pathArg], context);
}
