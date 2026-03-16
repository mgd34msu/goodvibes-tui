/**
 * JSON Schema definition for the `inspect` tool.
 *
 * The inspect tool performs static analysis of a project or file and returns
 * structured information about its structure, APIs, database schema, components,
 * layout, accessibility, or a scaffold plan.
 */
export const INSPECT_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['project', 'api', 'api_spec', 'api_validate', 'api_sync', 'database', 'components', 'layout', 'accessibility', 'scaffold', 'component_state', 'render_triggers', 'hooks', 'overflow', 'sizing', 'stacking', 'responsive', 'events', 'tailwind', 'client_boundary', 'error_boundary'],
      description:
        'Analysis mode. project: detect project type and structure; api: scan route definitions;'
        + ' api_spec: generate OpenAPI 3.0 spec from discovered routes;'
        + ' api_validate: compare existing OpenAPI spec against discovered routes;'
        + ' api_sync: detect frontend/backend type drift via fetch() call analysis;'
        + ' database: parse schema models; components: extract React components;'
        + ' layout: analyze CSS/Tailwind layout; accessibility: detect a11y issues;'
        + ' scaffold: generate module skeleton;'
        + ' component_state: trace useState/useReducer/useContext; render_triggers: find re-render causes;'
        + ' hooks: analyze hook dependency arrays; overflow: find CSS overflow issues;'
        + ' sizing: analyze sizing strategy; stacking: z-index and stacking context;'
        + ' responsive: Tailwind breakpoint analysis; events: event handling analysis;'
        + ' tailwind: detect class conflicts; client_boundary: Next.js directive analysis;'
        + ' error_boundary: error boundary coverage.',
    },
    projectRoot: {
      type: 'string',
      description:
        'Root directory for the analysis. Defaults to the current working directory.',
    },
    file: {
      type: 'string',
      description:
        'Path to a specific file. Required for component, layout, and accessibility modes.',
    },
    framework: {
      type: 'string',
      enum: ['auto', 'nextjs', 'express', 'fastify', 'hono'],
      description:
        'Web framework for api mode. auto detects from package.json. Default: auto.',
    },
    schemaPath: {
      type: 'string',
      description:
        'Path to database schema file (Prisma/Drizzle). For database mode. '
        + 'Defaults to prisma/schema.prisma.',
    },
    moduleName: {
      type: 'string',
      description: 'Module name for scaffold mode. Used to name generated files.',
    },
    dryRun: {
      type: 'boolean',
      description:
        'scaffold mode: return file plan without writing. Default true.',
    },
    output: {
      type: 'object',
      description: 'Output formatting options.',
      properties: {
        format: {
          type: 'string',
          enum: ['summary', 'detailed', 'json'],
          description: 'summary: condensed overview; detailed: full analysis; json: raw JSON. Default: detailed.',
        },
        max_tokens: {
          type: 'integer',
          minimum: 1,
          description: 'Hard token cap for the response.',
        },
      },
    },
  },
  required: ['mode'],
} as const;

// ---------------------------------------------------------------------------
// TypeScript types
// ---------------------------------------------------------------------------

export type InspectMode =
  | 'project'
  | 'api'
  | 'api_spec'
  | 'api_validate'
  | 'api_sync'
  | 'database'
  | 'components'
  | 'layout'
  | 'accessibility'
  | 'scaffold'
  | 'component_state'
  | 'render_triggers'
  | 'hooks'
  | 'overflow'
  | 'sizing'
  | 'stacking'
  | 'responsive'
  | 'events'
  | 'tailwind'
  | 'client_boundary'
  | 'error_boundary';

export type ApiFramework = 'auto' | 'nextjs' | 'express' | 'fastify' | 'hono';
export type OutputFormat = 'summary' | 'detailed' | 'json';

export interface InspectOutput {
  format?: OutputFormat;
  max_tokens?: number;
}

export interface InspectInput {
  mode: InspectMode;
  projectRoot?: string;
  file?: string;
  framework?: ApiFramework;
  schemaPath?: string;
  specPath?: string;
  moduleName?: string;
  dryRun?: boolean;
  output?: InspectOutput;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ProjectInfo {
  type: 'nodejs' | 'rust' | 'python' | 'go' | 'make' | 'unknown';
  name?: string;
  version?: string;
  packageManager: 'npm' | 'bun' | 'yarn' | 'pnpm' | 'none';
  scripts: Record<string, string>;
  dependencies: number;
  devDependencies: number;
  hasTypeScript: boolean;
  testFramework?: string;
  isMonorepo: boolean;
  entryPoints: string[];
}

export interface ApiRoute {
  method: string;
  path: string;
  file: string;
  line: number;
}

export interface DbField {
  name: string;
  type: string;
  isRelation: boolean;
  isOptional: boolean;
}

export interface DbModel {
  name: string;
  fields: DbField[];
}

export interface DbEnum {
  name: string;
  values: string[];
}

export interface DatabaseInfo {
  models: DbModel[];
  enums: DbEnum[];
}

export interface ComponentInfo {
  name: string;
  kind: 'function' | 'arrow' | 'class';
  line: number;
  props: string[];
  hooks: string[];
  children: string[];
}

export interface LayoutInfo {
  file: string;
  displays: string[];
  flex: string[];
  grid: string[];
  sizing: string[];
  overflow: string[];
}

export interface A11yIssue {
  line: number;
  code: string;
  message: string;
  wcag: string;
}

export interface ScaffoldFile {
  path: string;
  content: string;
}

export interface ScaffoldPlan {
  moduleName: string;
  dryRun: boolean;
  files: ScaffoldFile[];
}

// ---------------------------------------------------------------------------
// api_spec result types
// ---------------------------------------------------------------------------

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: { type: string };
}

export interface OpenApiOperation {
  operationId: string;
  parameters?: OpenApiParameter[];
  responses: Record<string, { description: string }>;
}

export interface OpenApiPathItem {
  [method: string]: OpenApiOperation;
}

export interface ApiSpec {
  openapi: '3.0.0';
  info: { title: string; version: string };
  paths: Record<string, OpenApiPathItem>;
}

// ---------------------------------------------------------------------------
// api_validate result types
// ---------------------------------------------------------------------------

export interface ApiValidateResult {
  valid: boolean;
  missing_from_spec: string[];
  missing_from_code: string[];
  mismatched_methods: Array<{ path: string; spec_methods: string[]; code_methods: string[] }>;
}

// ---------------------------------------------------------------------------
// api_sync result types
// ---------------------------------------------------------------------------

export interface FetchCall {
  url: string;
  file: string;
  line: number;
}

export interface ApiSyncResult {
  fetch_calls: FetchCall[];
  unmatched_fetches: FetchCall[];
  unmatched_routes: ApiRoute[];
  drift_detected: boolean;
}

// ---------------------------------------------------------------------------
// Frontend analysis result types (C12)
// ---------------------------------------------------------------------------

export interface StateVar {
  name: string;
  kind: 'useState' | 'useReducer' | 'useContext';
  line: number;
}

export interface ComponentStateInfo {
  file: string;
  stateVars: StateVar[];
  count: number;
}

export interface RenderTrigger {
  kind: 'state_setter' | 'effect_dep' | 'memo_dep' | 'callback_dep' | 'memo_boundary';
  name: string;
  line: number;
}

export interface RenderTriggersInfo {
  file: string;
  triggers: RenderTrigger[];
  count: number;
}

export interface HookDep {
  hookKind: 'useEffect' | 'useMemo' | 'useCallback';
  line: number;
  deps: string[];
  missing: string[];
}

export interface HooksInfo {
  file: string;
  hooks: HookDep[];
  missingDepsCount: number;
}

export interface OverflowIssue {
  line: number;
  kind: 'hidden_clip' | 'scroll_no_height';
  snippet: string;
}

export interface OverflowInfo {
  file: string;
  issues: OverflowIssue[];
  count: number;
}

export interface SizingItem {
  line: number;
  kind: 'fixed_px' | 'fixed_rem' | 'percentage' | 'flex' | 'grid' | 'viewport';
  value: string;
  flagged: boolean;
}

export interface SizingInfo {
  file: string;
  items: SizingItem[];
  hardcodedCount: number;
}

export interface ZIndexItem {
  line: number;
  value: string;
  context: string;
}

export interface StackingInfo {
  file: string;
  zIndexItems: ZIndexItem[];
  potentialConflicts: Array<{ values: string[]; lines: number[] }>;
}

export interface BreakpointUsage {
  prefix: string;
  count: number;
  classes: string[];
}

export interface ResponsiveInfo {
  file: string;
  breakpoints: BreakpointUsage[];
  hasMobileFirst: boolean;
}

export interface EventHandler {
  line: number;
  event: string;
  hasPreventDefault: boolean;
  hasStopPropagation: boolean;
  isDelegated: boolean;
}

export interface EventsInfo {
  file: string;
  handlers: EventHandler[];
  count: number;
}

export interface TailwindConflict {
  line: number;
  classes: string[];
  reason: string;
}

export interface TailwindInfo {
  file: string;
  conflicts: TailwindConflict[];
  count: number;
}

export interface ClientBoundaryInfo {
  file: string;
  directive: 'use client' | 'use server' | null;
  importsServerOnly: boolean;
  serverOnlyImports: string[];
}

export interface ErrorBoundaryInfo {
  file: string;
  hasErrorBoundary: boolean;
  boundaryComponents: string[];
  coveredRoutes: string[];
}
