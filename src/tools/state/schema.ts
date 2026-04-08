/**
 * JSON Schema and TypeScript types for the `state` tool.
 */
export const STATE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['get', 'set', 'list', 'clear', 'budget', 'context', 'memory', 'telemetry', 'hooks', 'mode', 'analytics'],
      description:
        'Operation mode: get/set/list/clear manipulate KVState; budget returns token usage;'
        + ' context returns conversation info; memory accesses persistent .goodvibes/memory files;'
        + ' telemetry returns session telemetry summary;'
        + ' hooks manages registered hooks (list/enable/disable/add/remove);'
        + ' mode manages output verbosity mode (get/set/list);'
        + ' analytics manages TelemetryDB (record/query/summary/export/dashboard/sync).',
    },
    keys: {
      type: 'array',
      items: { type: 'string' },
      description: '(mode: get) Keys to retrieve from KVState.',
    },
    values: {
      type: 'object',
      additionalProperties: true,
      description: '(mode: set) Key-value pairs to write into KVState.',
    },
    prefix: {
      type: 'string',
      description: '(mode: list) Optional prefix filter. Returns only keys starting with this string.',
    },
    view: {
      type: 'string',
      enum: ['summary', 'full'],
      description: '(modes: list, memory, hooks, mode, analytics) Output detail level. Default: summary for inventory/reporting surfaces.',
    },
    clearKeys: {
      type: 'array',
      items: { type: 'string' },
      description: '(mode: clear) Keys to remove from KVState.',
    },
    memoryAction: {
      type: 'string',
      enum: ['get', 'set', 'list'],
      description: '(mode: memory) Sub-action: get reads a key, set writes a key, list shows all keys.',
    },
    memoryKey: {
      type: 'string',
      description: '(mode: memory, action: get/set) The memory file key (filename without .json extension).',
    },
    memoryValue: {
      type: 'string',
      description: '(mode: memory, action: set) JSON string or plain text to write.',
    },
    hookAction: {
      type: 'string',
      enum: ['list', 'enable', 'disable', 'add', 'remove'],
      description: '(mode: hooks) Sub-action: list all hooks; enable/disable by name; add a new hook; remove by name.',
    },
    hookName: {
      type: 'string',
      description: '(mode: hooks, action: enable/disable/remove) Name of the hook to target.',
    },
    hookDefinition: {
      type: 'object',
      description: '(mode: hooks, action: add) Hook definition object with eventPattern and hook fields.',
      properties: {
        eventPattern: { type: 'string', description: 'Event path pattern (e.g. Pre:tool:*)' },
        name: { type: 'string', description: 'Unique name for the hook.' },
        type: { type: 'string', enum: ['command', 'http', 'ts'], description: 'Hook type.' },
        match: { type: 'string', description: 'Event path to match.' },
        command: { type: 'string', description: '(type: command) Shell command to run.' },
        url: { type: 'string', description: '(type: http) URL to POST to.' },
        path: { type: 'string', description: '(type: ts) Path to TypeScript file.' },
        description: { type: 'string', description: 'Human-readable description.' },
      },
      additionalProperties: true,
    },
    modeAction: {
      type: 'string',
      enum: ['get', 'set', 'list'],
      description: '(mode: mode) Sub-action: get returns current mode; set switches to a named mode; list returns all modes.',
    },
    modeName: {
      type: 'string',
      description: '(mode: mode, action: set) Name of the mode to switch to (e.g. default, vibecoding, justvibes).',
    },
    analyticsAction: {
      type: 'string',
      enum: ['record', 'query', 'summary', 'export', 'dashboard', 'sync'],
      description: '(mode: analytics) Sub-action: record a tool call; query by filter; summary aggregation; export as JSON/CSV; dashboard top-level view; sync/persist to disk.',
    },
    analyticsTool: {
      type: 'string',
      description: '(mode: analytics, action: record/query) Tool name to record or filter by.',
    },
    analyticsArgs: {
      type: 'object',
      additionalProperties: true,
      description: '(mode: analytics, action: record) Tool args to record.',
    },
    analyticsResult: {
      type: 'object',
      additionalProperties: true,
      description: '(mode: analytics, action: record) Tool result to record.',
    },
    analyticsDuration: {
      type: 'number',
      description: '(mode: analytics, action: record) Duration in milliseconds.',
    },
    analyticsTokens: {
      type: 'number',
      description: '(mode: analytics, action: record) Token count.',
    },
    analyticsFilter: {
      type: 'object',
      additionalProperties: true,
      description: '(mode: analytics, action: query) Filter object: { tool?, status?, since?, until?, limit? }',
    },
    analyticsFormat: {
      type: 'string',
      enum: ['json', 'csv'],
      description: '(mode: analytics, action: export) Export format.',
    },
  },
  required: ['mode'],
  additionalProperties: false,
} as const;

/** All valid operation modes for the state tool. */
export type StateMode =
  | 'get'
  | 'set'
  | 'list'
  | 'clear'
  | 'budget'
  | 'context'
  | 'memory'
  | 'telemetry'
  | 'hooks'
  | 'mode'
  | 'analytics';

/** Memory sub-action. */
export type MemoryAction = 'get' | 'set' | 'list';

/** Hooks sub-action. */
export type HookAction = 'list' | 'enable' | 'disable' | 'add' | 'remove';

/** Mode sub-action. */
export type ModeAction = 'get' | 'set' | 'list';

/** Analytics sub-action. */
export type AnalyticsAction = 'record' | 'query' | 'summary' | 'export' | 'dashboard' | 'sync';

/** Full input shape for the state tool. */
export interface StateInput {
  mode: StateMode;

  // mode: get
  keys?: string[];

  // mode: set
  values?: Record<string, unknown>;

  // mode: list
  prefix?: string;
  view?: 'summary' | 'full';

  // mode: clear
  clearKeys?: string[];

  // mode: memory
  memoryAction?: MemoryAction;
  memoryKey?: string;
  memoryValue?: string;

  // mode: hooks
  hookAction?: HookAction;
  hookName?: string;
  hookDefinition?: {
    eventPattern: string;
    name?: string;
    type: 'command' | 'http' | 'ts';
    match: string;
    command?: string;
    url?: string;
    path?: string;
    description?: string;
    [key: string]: unknown;
  };

  // mode: mode
  modeAction?: ModeAction;
  modeName?: string;

  // mode: analytics
  analyticsAction?: AnalyticsAction;
  analyticsTool?: string;
  analyticsArgs?: Record<string, unknown>;
  analyticsResult?: Record<string, unknown>;
  analyticsDuration?: number;
  analyticsTokens?: number;
  analyticsFilter?: Record<string, unknown>;
  analyticsFormat?: 'json' | 'csv';
}
