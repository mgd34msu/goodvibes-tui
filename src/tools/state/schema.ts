/**
 * JSON Schema and TypeScript types for the `state` tool.
 */
export const STATE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['get', 'set', 'list', 'clear', 'budget', 'context', 'memory', 'telemetry'],
      description:
        'Operation mode: get/set/list/clear manipulate KVState; budget returns token usage;'
        + ' context returns conversation info; memory accesses persistent .goodvibes/memory files;'
        + ' telemetry returns session telemetry summary.',
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
  | 'telemetry';

/** Memory sub-action. */
export type MemoryAction = 'get' | 'set' | 'list';

/** Full input shape for the state tool. */
export interface StateInput {
  mode: StateMode;

  // mode: get
  keys?: string[];

  // mode: set
  values?: Record<string, unknown>;

  // mode: list
  prefix?: string;

  // mode: clear
  clearKeys?: string[];

  // mode: memory
  memoryAction?: MemoryAction;
  memoryKey?: string;
  memoryValue?: string;
}
