/** The 5 lifecycle phases */
export type HookPhase = 'Pre' | 'Post' | 'Fail' | 'Change' | 'Lifecycle';

/** Hook event categories */
export type HookCategory =
  | 'tool' | 'file' | 'git' | 'agent' | 'compact'
  | 'llm' | 'mcp' | 'config' | 'budget' | 'session' | 'workflow'
  | 'permission' | 'transport' | 'orchestration' | 'communication';

/** A fully qualified hook event path: Phase:Category:Specific */
export type HookEventPath = `${HookPhase}:${HookCategory}:${string}`;

/** Event payload passed to hooks */
export interface HookEvent {
  path: HookEventPath;
  phase: HookPhase;
  category: HookCategory;
  specific: string;
  sessionId: string;
  timestamp: number;
  payload: Record<string, unknown>;
  /** For agent-scoped events */
  agentId?: string;
}

/** Result returned by a hook handler */
export interface HookResult {
  /** For Pre hooks: allow, deny, or ask */
  decision?: 'allow' | 'deny' | 'ask';
  /** Reason for denial */
  reason?: string;
  /** Modified input (Pre hooks can modify tool input) */
  updatedInput?: Record<string, unknown>;
  /** Context to inject into the LLM conversation */
  additionalContext?: string;
  /** Whether the hook ran successfully */
  ok: boolean;
  /** Error message if hook failed */
  error?: string;
}

/** The 5 hook types */
export type HookType = 'command' | 'prompt' | 'agent' | 'http' | 'ts';

/** Hook definition in hooks.json */
export interface HookDefinition {
  /** Which event path to match. Supports wildcards: Pre:tool:* */
  match: string;
  /** Further filter within the match (e.g., specific tool name) */
  matcher?: string;
  /** Hook type */
  type: HookType;
  /** For command hooks: shell command to execute */
  command?: string;
  /** For prompt/agent hooks: the prompt text. $ARGUMENTS replaced with event JSON. */
  prompt?: string;
  /** For http hooks: URL to POST to */
  url?: string;
  /** For ts hooks: path to TypeScript file */
  path?: string;
  /** For http hooks: custom headers */
  headers?: Record<string, string>;
  /** For prompt/agent hooks: LLM model to use */
  model?: string;
  /** Timeout in seconds (default: 30 for command/prompt/http, 60 for agent) */
  timeout?: number;
  /** Custom status message shown while hook runs */
  statusMessage?: string;
  /** Run in background without blocking */
  async?: boolean;
  /** Run once then auto-remove */
  once?: boolean;
  /** Description for documentation */
  description?: string;
  /** Optional name for programmatic enable/disable/remove */
  name?: string;
  /** Whether the hook is enabled (default: true) */
  enabled?: boolean;
}

/** Hook chain step */
export interface ChainStep {
  match: string;
  capture?: Record<string, string>;
  within?: string;       // e.g., "30s", "5m"
  condition?: string;    // JS expression evaluated against payload
  optional?: boolean;
  debounce?: string;     // e.g., "2s"
}

/** Hook chain definition */
export interface HookChain {
  name: string;
  description?: string;
  steps: ChainStep[];
  action: HookDefinition;
}

/** Full hooks.json schema */
export interface HooksConfig {
  /** Direct hooks keyed by event path pattern */
  hooks?: Record<string, HookDefinition[]>;
  /** Multi-event chains */
  chains?: HookChain[];
}
