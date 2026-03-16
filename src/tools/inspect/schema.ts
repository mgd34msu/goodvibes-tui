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
      enum: ['project', 'api', 'database', 'components', 'layout', 'accessibility', 'scaffold'],
      description:
        'Analysis mode. project: detect project type and structure; api: scan route definitions;'
        + ' database: parse schema models; components: extract React components;'
        + ' layout: analyze CSS/Tailwind layout; accessibility: detect a11y issues;'
        + ' scaffold: generate module skeleton.',
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
  | 'database'
  | 'components'
  | 'layout'
  | 'accessibility'
  | 'scaffold';

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
