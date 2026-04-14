import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { statSync } from 'node:fs';
import type { HookDefinition, HookResult, HookEvent } from '../types.ts';
import { logger } from '../../utils/logger.ts';
import { summarizeError } from '../../utils/error-display.ts';

/** Expected shape of a TypeScript hook module's default export */
type TsHookHandler = (event: HookEvent) => Promise<HookResult> | HookResult;

/**
 * TypeScript hook runner.
 * Dynamically imports the module at hook.path and calls its default export with the event.
 */
export async function run(hook: HookDefinition, event: HookEvent, projectRoot: string): Promise<HookResult> {
  const path = hook.path;
  if (!path) {
    return { ok: false, error: 'ts hook missing "path" field' };
  }

  // Validate path is within the project directory to prevent arbitrary module loading
  const resolvedPath = resolve(projectRoot, path);
  if (!resolvedPath.startsWith(projectRoot + '/')) {
    return { ok: false, error: `ts hook path '${path}' is outside the project directory` };
  }

  try {
    let moduleUrl = pathToFileURL(resolvedPath).href;
    try {
      const { mtimeMs } = statSync(resolvedPath);
      moduleUrl += `?mtime=${mtimeMs}`;
    } catch {
      // Ignore stat failures and fall back to the bare file URL so import can surface the real error.
    }

    const mod = await import(moduleUrl);
    const handler = mod.default as TsHookHandler | undefined;

    if (typeof handler !== 'function') {
      return { ok: false, error: `ts hook at ${path} does not export a default function` };
    }

    const result = await handler(event);
    return result;
  } catch (err) {
    const message = summarizeError(err);
    logger.error('ts hook error', { path, error: message });
    return { ok: false, error: message };
  }
}
