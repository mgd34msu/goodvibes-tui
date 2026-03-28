import { resolve } from 'node:path';
import type { HookDefinition, HookResult, HookEvent } from '../types.ts';
import { logger } from '../../utils/logger.ts';

/** Expected shape of a TypeScript hook module's default export */
type TsHookHandler = (event: HookEvent) => Promise<HookResult> | HookResult;

/**
 * TypeScript hook runner.
 * Dynamically imports the module at hook.path and calls its default export with the event.
 */
export async function run(hook: HookDefinition, event: HookEvent): Promise<HookResult> {
  const path = hook.path;
  if (!path) {
    return { ok: false, error: 'ts hook missing "path" field' };
  }

  // Validate path is within the project directory to prevent arbitrary module loading
  const projectRoot = process.cwd();
  const resolvedPath = resolve(projectRoot, path);
  if (!resolvedPath.startsWith(projectRoot + '/')) {
    return { ok: false, error: `ts hook path '${path}' is outside the project directory` };
  }

  try {
    const mod = await import(resolvedPath);
    const handler = mod.default as TsHookHandler | undefined;

    if (typeof handler !== 'function') {
      return { ok: false, error: `ts hook at ${path} does not export a default function` };
    }

    const result = await handler(event);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('ts hook error', { path, error: message });
    return { ok: false, error: message };
  }
}
