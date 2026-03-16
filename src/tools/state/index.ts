import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KVState } from '../../state/kv-state.ts';
import { ProjectIndex } from '../../state/project-index.ts';
import { logger } from '../../utils/logger.ts';
import type { Tool, ToolDefinition } from '../../types/tools.ts';
import { STATE_TOOL_SCHEMA } from './schema.ts';
import type { StateInput } from './schema.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reserved keys that KVState silently drops on set.
 * Duplicated here to filter them out of `keys_written` reporting.
 */
const RESERVED_KEYS = new Set(['id', 'started_at', '__proto__', 'constructor', 'prototype']);

/**
 * Sanitize a memory key to prevent path traversal.
 * Only alphanumeric characters, hyphens, and underscores are allowed.
 * Returns null if the key is invalid.
 */
function sanitizeMemoryKey(key: string): string | null {
  if (!key) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) return null;
  return key;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the `state` tool bound to the given KVState and ProjectIndex.
 *
 * Returns a Tool object conforming to the Tool interface.
 * Never throws from execute().
 */
export function createStateTool(
  kvState: KVState,
  projectIndex: ProjectIndex,
): Tool {
  // Session start time and telemetry are scoped per-instance so multiple
  // createStateTool() calls don't share state.
  const SESSION_START_MS = Date.now();
  const _telemetry = {
    toolCalls: 0,
    errors: 0,
  };

  const definition: ToolDefinition = {
    name: 'state',
    description:
      'Access and manipulate session state. Modes: get/set/list/clear operate on KVState;'
      + ' budget reports token usage; context reports conversation info;'
      + ' memory reads/writes persistent .goodvibes/memory files; telemetry reports session metrics.',
    parameters: STATE_TOOL_SCHEMA as unknown as Record<string, unknown>,
  };

  async function execute(
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    _telemetry.toolCalls++;
    try {
      if (typeof args.mode !== 'string') {
        _telemetry.errors++;
        return { success: false, error: 'Missing or invalid "mode" field (string required)' };
      }
      const input = args as unknown as StateInput;
      const { mode } = input;

      switch (mode) {
        case 'get':   return runGet(input, kvState);
        case 'set':   return runSet(input, kvState);
        case 'list':  return runList(input, kvState);
        case 'clear': return runClear(input, kvState);
        case 'budget': return runBudget(kvState, projectIndex);
        case 'context': return runContext(kvState, projectIndex);
        case 'memory': return runMemory(input);
        case 'telemetry': return runTelemetry();
        default: {
          _telemetry.errors++;
          return { success: false, error: `Unknown mode: ${String(mode)}` };
        }
      }
    } catch (err) {
      _telemetry.errors++;
      const message = err instanceof Error ? err.message : String(err);
      logger.debug('state tool: unexpected error', { error: message });
      return { success: false, error: `Unexpected error: ${message}` };
    }
  }

  function runTelemetry(): { success: boolean; output?: string; error?: string } {
    const durationMs = Date.now() - SESSION_START_MS;
    return {
      success: true,
      output: JSON.stringify({
        mode: 'telemetry',
        session_duration_ms: durationMs,
        tool_calls: _telemetry.toolCalls,
        errors: _telemetry.errors,
      }),
    };
  }

  return { definition, execute };
}

// ---------------------------------------------------------------------------
// Mode handlers
// ---------------------------------------------------------------------------

async function runGet(
  input: StateInput,
  kvState: KVState,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const keys = input.keys ?? [];
  if (keys.length === 0) {
    return { success: false, error: 'mode "get" requires a non-empty "keys" array' };
  }
  const values = await kvState.get(keys);
  return { success: true, output: JSON.stringify({ mode: 'get', values }) };
}

async function runSet(
  input: StateInput,
  kvState: KVState,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const values = input.values;
  if (!values || typeof values !== 'object') {
    return { success: false, error: 'mode "set" requires a "values" object' };
  }
  await kvState.set(values);
  // Only report keys that KVState actually persists (exclude reserved keys).
  const written = Object.keys(values).filter((k) => !RESERVED_KEYS.has(k));
  return {
    success: true,
    output: JSON.stringify({
      mode: 'set',
      keys_written: written.length,
      keys: written,
    }),
  };
}

async function runList(
  input: StateInput,
  kvState: KVState,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const entries = await kvState.list(input.prefix);
  return {
    success: true,
    output: JSON.stringify({
      mode: 'list',
      prefix: input.prefix ?? null,
      count: Object.keys(entries).length,
      entries,
    }),
  };
}

async function runClear(
  input: StateInput,
  kvState: KVState,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const keys = input.clearKeys ?? [];
  if (keys.length === 0) {
    return { success: false, error: 'mode "clear" requires a non-empty "clearKeys" array' };
  }
  await kvState.clear(keys);
  return {
    success: true,
    output: JSON.stringify({
      mode: 'clear',
      keys_cleared: keys.length,
      keys,
    }),
  };
}

async function runBudget(
  kvState: KVState,
  projectIndex: ProjectIndex,
): Promise<{ success: boolean; output?: string; error?: string }> {
  // Fetch session metrics stored in KVState if available.
  const metricsKeys = ['tokens_used', 'files_modified', 'commands_run', 'agents_spawned'];
  const metrics = await kvState.get(metricsKeys);

  const totalProjectTokens = projectIndex.getTotalTokens();
  const fileCount = projectIndex.getFiles().length;

  return {
    success: true,
    output: JSON.stringify({
      mode: 'budget',
      session_id: kvState.getSessionId(),
      project_index: {
        file_count: fileCount,
        total_tokens: totalProjectTokens,
      },
      session_metrics: {
        tokens_used: (metrics.tokens_used as number | undefined) ?? null,
        files_modified: (metrics.files_modified as number | undefined) ?? null,
        commands_run: (metrics.commands_run as number | undefined) ?? null,
        agents_spawned: (metrics.agents_spawned as number | undefined) ?? null,
      },
    }),
  };
}

async function runContext(
  kvState: KVState,
  projectIndex: ProjectIndex,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const fileCount = projectIndex.getFiles().length;
  const totalTokens = projectIndex.getTotalTokens();

  return {
    success: true,
    output: JSON.stringify({
      mode: 'context',
      session_id: kvState.getSessionId(),
      project_index: {
        file_count: fileCount,
        total_tokens: totalTokens,
      },
    }),
  };
}

async function runMemory(
  input: StateInput,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const action = input.memoryAction ?? 'list';
  const memoryDir = join(process.cwd(), '.goodvibes', 'memory');

  if (action === 'list') {
    try {
      if (!existsSync(memoryDir)) {
        return {
          success: true,
          output: JSON.stringify({ mode: 'memory', action: 'list', keys: [] }),
        };
      }
      const keys = readdirSync(memoryDir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5)); // strip .json
      return {
        success: true,
        output: JSON.stringify({ mode: 'memory', action: 'list', keys }),
      };
    } catch (err) {
      return {
        success: false,
        error: `Memory list failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (action === 'get') {
    const key = input.memoryKey;
    if (!key) {
      return { success: false, error: 'memory action "get" requires "memoryKey"' };
    }
    const safeKey = sanitizeMemoryKey(key);
    if (!safeKey) {
      return { success: false, error: 'Invalid memoryKey: must be alphanumeric, hyphens, or underscores only' };
    }
    const filePath = join(memoryDir, `${safeKey}.json`);
    try {
      if (!existsSync(filePath)) {
        return {
          success: true,
          output: JSON.stringify({ mode: 'memory', action: 'get', key: safeKey, value: null }),
        };
      }
      const raw = readFileSync(filePath, 'utf-8');
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
      return {
        success: true,
        output: JSON.stringify({ mode: 'memory', action: 'get', key: safeKey, value }),
      };
    } catch (err) {
      return {
        success: false,
        error: `Memory get failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (action === 'set') {
    const key = input.memoryKey;
    const value = input.memoryValue;
    if (!key) {
      return { success: false, error: 'memory action "set" requires "memoryKey"' };
    }
    const safeKey = sanitizeMemoryKey(key);
    if (!safeKey) {
      return { success: false, error: 'Invalid memoryKey: must be alphanumeric, hyphens, or underscores only' };
    }
    if (value === undefined || value === null) {
      return { success: false, error: 'memory action "set" requires "memoryValue"' };
    }
    try {
      mkdirSync(memoryDir, { recursive: true });
      const filePath = join(memoryDir, `${safeKey}.json`);
      // Write as-is; allow caller to pass JSON string or plain text
      writeFileSync(filePath, value, 'utf-8');
      return {
        success: true,
        output: JSON.stringify({ mode: 'memory', action: 'set', key: safeKey, bytes_written: value.length }),
      };
    } catch (err) {
      return {
        success: false,
        error: `Memory set failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    success: false,
    error: `Unknown memory action: ${String(action)}`,
  };
}
