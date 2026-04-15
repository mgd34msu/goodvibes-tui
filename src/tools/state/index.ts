import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KVState } from '@pellux/goodvibes-sdk/platform/state/kv-state';
import { ProjectIndex } from '@pellux/goodvibes-sdk/platform/state/project-index';
import { ModeManager } from '@pellux/goodvibes-sdk/platform/state/mode-manager';
import { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks/dispatcher';
import { TelemetryDB } from '@pellux/goodvibes-sdk/platform/state/telemetry';
import type { TelemetryFilter } from '@pellux/goodvibes-sdk/platform/state/telemetry';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { Tool, ToolDefinition } from '@pellux/goodvibes-sdk/platform/types/tools';
import { STATE_TOOL_SCHEMA } from '@pellux/goodvibes-sdk/platform/tools/state/schema';
import type { StateInput } from '@pellux/goodvibes-sdk/platform/tools/state/schema';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reserved keys that KVState silently drops on set.
 * Duplicated here to filter them out of `keys_written` reporting.
 */
const RESERVED_KEYS = new Set(['id', 'started_at', '__proto__', 'constructor', 'prototype']);

function summarizeEntries(entries: Record<string, unknown>): Array<{ key: string; type: string }> {
  return Object.entries(entries).map(([key, value]) => ({
    key,
    type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
  }));
}

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

export interface StateToolOptions {
  readonly memoryDir: string;
  readonly hookDispatcher?: HookDispatcher;
  readonly modeManager?: ModeManager;
  readonly telemetryDB?: TelemetryDB;
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
  options: StateToolOptions,
): Tool {
  if (!options.memoryDir || options.memoryDir.trim().length === 0) {
    throw new Error('createStateTool requires an explicit memoryDir');
  }
  const memoryDir = options.memoryDir;
  const hookDispatcher = options.hookDispatcher;
  const modeManager = options.modeManager;
  const telemetryDB = options.telemetryDB;
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
      + ' memory reads/writes persistent .goodvibes/memory files; telemetry reports session metrics;'
      + ' hooks manages registered hooks (list/enable/disable/add/remove);'
      + ' mode manages output verbosity mode (get/set/list).'
      + ' Discovery: use mode=list to see existing KV keys, mode=hooks hookAction=list to see registered hooks,'
      + ' mode=mode modeAction=get to see the current output mode.'
      + ' Also: mode=memory memoryAction=list to list persistent memory keys, mode=analytics analyticsAction=summary for session metrics.',
    parameters: STATE_TOOL_SCHEMA as unknown as Record<string, unknown>,
    sideEffects: ['state'],
    concurrency: 'serial',
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
        case 'memory': return runMemory(input, memoryDir);
        case 'telemetry': return runTelemetry();
        case 'hooks': return runHooks(input, hookDispatcher);
        case 'mode': return runMode(input, modeManager);
        case 'analytics': return runAnalytics(input, telemetryDB);
        default: {
          _telemetry.errors++;
          return { success: false, error: `Unknown mode: ${String(mode)}` };
        }
      }
    } catch (err) {
      _telemetry.errors++;
      const message = summarizeError(err);
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
// Analytics handler
// ---------------------------------------------------------------------------

async function runAnalytics(
  input: StateInput,
  db: TelemetryDB | undefined,
): Promise<{ success: boolean; output?: string; error?: string }> {
  if (!db) {
    return {
      success: false,
      error: 'analytics mode requires a TelemetryDB instance (not provided at startup)',
    };
  }

  if (!db.isReady) {
    try {
      await db.init();
    } catch (err) {
      return {
        success: false,
        error: `TelemetryDB init failed: ${summarizeError(err)}`,
      };
    }
  }

  const action = input.analyticsAction ?? 'summary';
  const view = input.view ?? 'summary';

  if (action === 'record') {
    const tool = input.analyticsTool;
    if (!tool) return { success: false, error: 'analytics action "record" requires "analyticsTool"' };
    const args = input.analyticsArgs ?? {};
    const result = input.analyticsResult ?? {};
    const duration = input.analyticsDuration ?? 0;
    const tokens = input.analyticsTokens ?? 0;
    try {
      db.recordToolCall(tool, args, result, duration, tokens);
      return {
        success: true,
        output: JSON.stringify({ mode: 'analytics', action: 'record', tool, duration, tokens }),
      };
    } catch (err) {
      return { success: false, error: `record failed: ${summarizeError(err)}` };
    }
  }

  if (action === 'query') {
    const rawFilter = input.analyticsFilter ?? {};
    const filter: TelemetryFilter = {
      tool: typeof rawFilter.tool === 'string' ? rawFilter.tool : undefined,
      status: rawFilter.status === 'ok' || rawFilter.status === 'error' ? rawFilter.status : undefined,
      since: typeof rawFilter.since === 'number' ? rawFilter.since : undefined,
      until: typeof rawFilter.until === 'number' ? rawFilter.until : undefined,
      limit: typeof rawFilter.limit === 'number' ? rawFilter.limit : undefined,
    };
    try {
      const records = db.query(filter);
      return {
        success: true,
        output: JSON.stringify({
          mode: 'analytics',
          action: 'query',
          view,
          count: records.length,
          records: view === 'full'
            ? records
            : records.map((record) => ({
              tool: record.tool,
              status: record.status,
              durationMs: record.duration_ms,
              tokenCount: record.tokens,
              timestamp: record.timestamp,
            })),
        }),
      };
    } catch (err) {
      return { success: false, error: `query failed: ${summarizeError(err)}` };
    }
  }

  if (action === 'summary') {
    try {
      const summary = db.getSummary();
      return {
        success: true,
        output: JSON.stringify({ mode: 'analytics', action: 'summary', ...summary }),
      };
    } catch (err) {
      return { success: false, error: `summary failed: ${summarizeError(err)}` };
    }
  }

  if (action === 'export') {
    const format = input.analyticsFormat ?? 'json';
    try {
      const data = db.export(format);
      return {
        success: true,
        output: JSON.stringify({ mode: 'analytics', action: 'export', format, data }),
      };
    } catch (err) {
      return { success: false, error: `export failed: ${summarizeError(err)}` };
    }
  }

  if (action === 'dashboard') {
    try {
      const summary = db.getSummary();
      const recentRecords = db.query({ limit: 10 });
      return {
        success: true,
        output: JSON.stringify({
          mode: 'analytics',
          action: 'dashboard',
          view,
          summary,
          recent: view === 'full'
            ? recentRecords
            : recentRecords.map((record) => ({
              tool: record.tool,
              status: record.status,
              durationMs: record.duration_ms,
              tokenCount: record.tokens,
              timestamp: record.timestamp,
            })),
        }),
      };
    } catch (err) {
      return { success: false, error: `dashboard failed: ${summarizeError(err)}` };
    }
  }

  if (action === 'sync') {
    try {
      const saved = await db.save();
      return {
        success: true,
        output: JSON.stringify({ mode: 'analytics', action: 'sync', persisted: saved }),
      };
    } catch (err) {
      return { success: false, error: `sync failed: ${summarizeError(err)}` };
    }
  }

  return { success: false, error: `Unknown analytics action: ${String(action)}` };
}

// ---------------------------------------------------------------------------
// Mode handlers
// ---------------------------------------------------------------------------

function runHooks(
  input: StateInput,
  dispatcher: HookDispatcher | undefined,
): { success: boolean; output?: string; error?: string } {
  if (!dispatcher) {
    return { success: false, error: 'hooks mode requires a HookDispatcher (not provided at startup)' };
  }

  const action = input.hookAction ?? 'list';

  if (action === 'list') {
    const entries = dispatcher.listHooks();
    const view = input.view ?? 'summary';
    return {
      success: true,
      output: JSON.stringify({
        mode: 'hooks',
        action: 'list',
        view,
        count: entries.length,
        hooks: entries.map(({ pattern, hook }) => {
          const summary = {
            pattern,
            name: hook.name ?? null,
            type: hook.type,
            match: hook.match,
            enabled: hook.enabled !== false,
            description: hook.description ?? null,
          };
          return view === 'full' ? { ...summary, hook } : summary;
        }),
      }),
    };
  }

  if (action === 'enable') {
    const name = input.hookName;
    if (!name) return { success: false, error: 'hooks action "enable" requires "hookName"' };
    const found = dispatcher.enableHook(name);
    if (!found) return { success: false, error: `No hook named "${name}" found` };
    return { success: true, output: JSON.stringify({ mode: 'hooks', action: 'enable', name, enabled: true }) };
  }

  if (action === 'disable') {
    const name = input.hookName;
    if (!name) return { success: false, error: 'hooks action "disable" requires "hookName"' };
    const found = dispatcher.disableHook(name);
    if (!found) return { success: false, error: `No hook named "${name}" found` };
    return { success: true, output: JSON.stringify({ mode: 'hooks', action: 'disable', name, enabled: false }) };
  }

  if (action === 'remove') {
    const name = input.hookName;
    if (!name) return { success: false, error: 'hooks action "remove" requires "hookName"' };
    const removed = dispatcher.unregister(name);
    if (!removed) return { success: false, error: `No hook named "${name}" found` };
    return { success: true, output: JSON.stringify({ mode: 'hooks', action: 'remove', name }) };
  }

  if (action === 'add') {
    const def = input.hookDefinition;
    if (!def) return { success: false, error: 'hooks action "add" requires "hookDefinition"' };
    const { eventPattern, ...hookDef } = def;
    if (!eventPattern) return { success: false, error: 'hookDefinition.eventPattern is required' };
    if (!hookDef.type) return { success: false, error: 'hookDefinition.type is required' };
    if (!hookDef.match) return { success: false, error: 'hookDefinition.match is required' };
    const VALID_HOOK_TYPES = new Set(['command', 'http', 'ts']);
    if (!VALID_HOOK_TYPES.has(hookDef.type)) {
      return { success: false, error: `hookDefinition.type must be one of: command, http, ts` };
    }
    dispatcher.register(eventPattern, hookDef as import('@pellux/goodvibes-sdk/platform/hooks/types').HookDefinition);
    return {
      success: true,
      output: JSON.stringify({ mode: 'hooks', action: 'add', eventPattern, name: hookDef.name ?? null }),
    };
  }

  return { success: false, error: `Unknown hooks action: ${String(action)}` };
}

function runMode(
  input: StateInput,
  manager: ModeManager | undefined,
): { success: boolean; output?: string; error?: string } {
  if (!manager) {
    return {
      success: false,
      error: 'mode mode requires a ModeManager instance (not provided at startup)',
    };
  }
  const mm = manager;
  const action = input.modeAction ?? 'get';

  if (action === 'get') {
    const name = mm.getMode();
    const verbosityDefaults = mm.getVerbosityDefaults();
    return {
      success: true,
      output: JSON.stringify({ mode: 'mode', action: 'get', name, verbosityDefaults }),
    };
  }

  if (action === 'list') {
    const modes = mm.listModes();
    const view = input.view ?? 'full';
    return {
      success: true,
      output: JSON.stringify({
        mode: 'mode',
        action: 'list',
        view,
        count: modes.length,
        modes: modes.map((m) => view === 'full'
          ? {
            name: m.name,
            description: m.description,
            verbosityDefaults: m.verbosityDefaults,
            enforcement: m.enforcement,
          }
          : {
            name: m.name,
            description: m.description,
            enforcement: m.enforcement,
          }),
      }),
    };
  }

  if (action === 'set') {
    const name = input.modeName;
    if (!name) return { success: false, error: 'mode action "set" requires "modeName"' };
    try {
      mm.setMode(name);
    } catch (err) {
      return { success: false, error: summarizeError(err) };
    }
    const verbosityDefaults = mm.getVerbosityDefaults();
    return {
      success: true,
      output: JSON.stringify({ mode: 'mode', action: 'set', name, verbosityDefaults }),
    };
  }

  return { success: false, error: `Unknown mode action: ${String(action)}` };
}

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
  const view = input.view ?? 'full';
  return {
    success: true,
    output: JSON.stringify({
      mode: 'list',
      view,
      prefix: input.prefix ?? null,
      count: Object.keys(entries).length,
      entries: view === 'full' ? entries : summarizeEntries(entries),
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
  memoryDir: string,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const action = input.memoryAction ?? 'list';
  const view = action === 'get' ? (input.view ?? 'full') : (input.view ?? 'summary');

  if (action === 'list') {
    try {
      if (!existsSync(memoryDir)) {
        return {
          success: true,
          output: JSON.stringify({ mode: 'memory', action: 'list', view, keys: [] }),
        };
      }
      const keys = readdirSync(memoryDir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5)); // strip .json
      return {
        success: true,
        output: JSON.stringify({
          mode: 'memory',
          action: 'list',
          view,
          keys,
          entries: view === 'full'
            ? keys.map((key) => {
              const filePath = join(memoryDir, `${key}.json`);
              const raw = readFileSync(filePath, 'utf-8');
              return { key, bytes: raw.length };
            })
            : undefined,
        }),
      };
    } catch (err) {
      return {
        success: false,
        error: `Memory list failed: ${summarizeError(err)}`,
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
        output: JSON.stringify(view === 'full'
          ? { mode: 'memory', action: 'get', view, key: safeKey, value }
          : {
            mode: 'memory',
            action: 'get',
            view,
            key: safeKey,
            type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
            bytes: raw.length,
          }),
      };
    } catch (err) {
      return {
        success: false,
        error: `Memory get failed: ${summarizeError(err)}`,
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
        error: `Memory set failed: ${summarizeError(err)}`,
      };
    }
  }

  return {
    success: false,
    error: `Unknown memory action: ${String(action)}`,
  };
}
