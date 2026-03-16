import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { Tool } from '../../types/tools.ts';
import { INSPECT_TOOL_SCHEMA } from './schema.ts';
import type {
  InspectInput,
  InspectMode,
  ApiFramework,
  ProjectInfo,
  ApiRoute,
  DatabaseInfo,
  DbModel,
  DbField,
  DbEnum,
  ComponentInfo,
  LayoutInfo,
  A11yIssue,
  ScaffoldPlan,
  ScaffoldFile,
  ApiSpec,
  OpenApiParameter,
  ApiValidateResult,
  FetchCall,
  ApiSyncResult,
  ComponentStateInfo,
  StateVar,
  RenderTriggersInfo,
  RenderTrigger,
  HooksInfo,
  HookDep,
  OverflowInfo,
  OverflowIssue,
  SizingInfo,
  SizingItem,
  StackingInfo,
  ZIndexItem,
  ResponsiveInfo,
  BreakpointUsage,
  EventsInfo,
  EventHandler,
  TailwindInfo,
  TailwindConflict,
  ClientBoundaryInfo,
  ErrorBoundaryInfo,
} from './schema.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a path relative to projectRoot, enforcing that the result stays
 * within the project root to prevent path traversal attacks.
 */
function resolvePath(projectRoot: string, inputPath: string): string {
  const resolved = resolve(inputPath.startsWith('/') ? inputPath : join(projectRoot, inputPath));
  const rel = relative(projectRoot, resolved);
  if (rel.startsWith('..')) {
    throw new Error(`Path '${inputPath}' resolves outside the project root`);
  }
  return resolved;
}

/**
 * Walk a directory tree, returning all file paths that pass the filter.
 * Skips common noise directories.
 */
async function walk(
  dir: string,
  filter: (p: string) => boolean,
  skipDirs: Set<string> = new Set(['.git', 'node_modules', 'dist', '.next', '.cache', '__pycache__']),
  depth = 0,
): Promise<string[]> {
  if (depth > 10) return [];
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) {
        const sub = await walk(full, filter, skipDirs, depth + 1);
        results.push(...sub);
      }
    } else if (filter(full)) {
      results.push(full);
    }
  }
  return results;
}

/** Read a text file, returning empty string on error. */
function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Mode: project
// ---------------------------------------------------------------------------

function detectProject(root: string): ProjectInfo {
  const has = (f: string) => existsSync(join(root, f));

  // Detect type from marker files
  let type: ProjectInfo['type'] = 'unknown';
  if (has('package.json')) type = 'nodejs';
  else if (has('Cargo.toml')) type = 'rust';
  else if (has('pyproject.toml') || has('requirements.txt')) type = 'python';
  else if (has('go.mod')) type = 'go';
  else if (has('Makefile')) type = 'make';

  // Package manager
  let packageManager: ProjectInfo['packageManager'] = 'none';
  if (type === 'nodejs') {
    if (has('bun.lockb')) packageManager = 'bun';
    else if (has('yarn.lock')) packageManager = 'yarn';
    else if (has('pnpm-lock.yaml')) packageManager = 'pnpm';
    else packageManager = 'npm';
  }

  // Parse package.json
  let name: string | undefined;
  let version: string | undefined;
  let scripts: Record<string, string> = {};
  let dependencies = 0;
  let devDependencies = 0;
  let isMonorepo = false;
  let testFramework: string | undefined;

  if (type === 'nodejs') {
    const raw = safeRead(join(root, 'package.json'));
    if (raw) {
      try {
        const pkg = JSON.parse(raw);
        name = pkg.name;
        version = pkg.version;
        scripts = pkg.scripts ?? {};
        dependencies = Object.keys(pkg.dependencies ?? {}).length;
        devDependencies = Object.keys(pkg.devDependencies ?? {}).length;
        isMonorepo = !!(pkg.workspaces);

        // Detect test framework
        const allDeps: Record<string, string> = {
          ...pkg.dependencies,
          ...pkg.devDependencies,
        };
        if (allDeps['vitest']) testFramework = 'vitest';
        else if (allDeps['jest']) testFramework = 'jest';
        else if (allDeps['bun']) testFramework = 'bun:test';
        else if (scripts['test']?.includes('bun test')) testFramework = 'bun:test';
        else if (scripts['test']?.includes('vitest')) testFramework = 'vitest';
        else if (scripts['test']?.includes('jest')) testFramework = 'jest';
      } catch {
        // malformed JSON
      }
    }
  }

  const hasTypeScript = has('tsconfig.json') || has('tsconfig.base.json');

  // Entry points — common conventions
  const entryPoints: string[] = [];
  for (const ep of ['src/index.ts', 'src/index.js', 'index.ts', 'index.js', 'src/main.ts', 'src/main.js', 'main.ts']) {
    if (has(ep)) entryPoints.push(ep);
  }

  return {
    type,
    name,
    version,
    packageManager,
    scripts,
    dependencies,
    devDependencies,
    hasTypeScript,
    testFramework,
    isMonorepo,
    entryPoints,
  };
}

// ---------------------------------------------------------------------------
// Mode: api
// ---------------------------------------------------------------------------

// Detect Next.js App Router: scan app/ for route.ts files and extract HTTP method exports.
async function findNextjsAppRoutes(root: string): Promise<ApiRoute[]> {
  const routes: ApiRoute[] = [];
  const appDir = join(root, 'app');
  if (!existsSync(appDir)) return routes;

  const files = await walk(appDir, (p) => p.endsWith('route.ts') || p.endsWith('route.js'));
  for (const file of files) {
    const content = safeRead(file);
    const relFile = relative(root, file);
    const lines = content.split('\n');
    // Derive the URL path from file path: app/users/route.ts -> /users
    const routePath = '/' + relative(join(root, 'app'), file)
      .replace(/\/route\.[tj]s$/, '')
      .replace(/\[(.+?)\]/g, ':$1')
      .replace(/\((.+?)\)\//g, '') // route groups
      || '/';

    const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const method of HTTP_METHODS) {
        if (
          line.match(new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`)) ||
          line.match(new RegExp(`export\\s+const\\s+${method}\\s*=`))
        ) {
          routes.push({ method, path: routePath, file: relFile, line: i + 1 });
        }
      }
    }
  }
  return routes;
}

// Detect Next.js Pages Router: scan pages/api/ for handler files.
async function findNextjsPagesRoutes(root: string): Promise<ApiRoute[]> {
  const routes: ApiRoute[] = [];
  const apiDir = join(root, 'pages', 'api');
  if (!existsSync(apiDir)) return routes;

  const files = await walk(apiDir, (p) => /\.[tj]sx?$/.test(p));
  for (const file of files) {
    const relFile = relative(root, file);
    const routePath = '/' + relative(join(root, 'pages'), file)
      .replace(/\.[tj]sx?$/, '')
      .replace(/\[(.+?)\]/g, ':$1');
    routes.push({ method: 'ANY', path: routePath, file: relFile, line: 1 });
  }
  return routes;
}

/** Detect Express routes: app.get/post/put/delete pattern. */
async function findExpressRoutes(root: string): Promise<ApiRoute[]> {
  const routes: ApiRoute[] = [];
  const files = await walk(root, (p) => /\.[tj]sx?$/.test(p));
  const EXPRESS_RE = /(?:router|app|server)\.(get|post|put|delete|patch|options|head)\s*\(\s*['"](.*?)['"]|(?:router|app|server)\.(get|post|put|delete|patch|options|head)\s*\(\s*`(.*?)`/i;

  for (const file of files) {
    const content = safeRead(file);
    const relFile = relative(root, file);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = EXPRESS_RE.exec(lines[i]);
      if (m) {
        const method = (m[1] || m[3] || 'get').toUpperCase();
        const path = m[2] || m[4] || '/';
        routes.push({ method, path, file: relFile, line: i + 1 });
      }
    }
  }
  return routes;
}

/** Detect Fastify routes: fastify.get/post/... */
async function findFastifyRoutes(root: string): Promise<ApiRoute[]> {
  const routes: ApiRoute[] = [];
  const files = await walk(root, (p) => /\.[tj]sx?$/.test(p));
  const FASTIFY_RE = /fastify\.(get|post|put|delete|patch|options|head)\s*\(\s*['"](.*?)['"]|fastify\.(get|post|put|delete|patch|options|head)\s*\(\s*`(.*?)`/i;

  for (const file of files) {
    const content = safeRead(file);
    const relFile = relative(root, file);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = FASTIFY_RE.exec(lines[i]);
      if (m) {
        const method = (m[1] || m[3] || 'get').toUpperCase();
        const path = m[2] || m[4] || '/';
        routes.push({ method, path, file: relFile, line: i + 1 });
      }
    }
  }
  return routes;
}

/** Detect Hono routes: app.get/post/... */
async function findHonoRoutes(root: string): Promise<ApiRoute[]> {
  const routes: ApiRoute[] = [];
  const files = await walk(root, (p) => /\.[tj]sx?$/.test(p));
  const HONO_RE = /app\.(get|post|put|delete|patch|options|head)\s*\(\s*['"](.*?)['"]|app\.(get|post|put|delete|patch|options|head)\s*\(\s*`(.*?)`/i;

  for (const file of files) {
    const content = safeRead(file);
    const relFile = relative(root, file);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = HONO_RE.exec(lines[i]);
      if (m) {
        const method = (m[1] || m[3] || 'get').toUpperCase();
        const path = m[2] || m[4] || '/';
        routes.push({ method, path, file: relFile, line: i + 1 });
      }
    }
  }
  return routes;
}

async function detectApiFramework(root: string): Promise<Exclude<ApiFramework, 'auto'>> {
  const raw = safeRead(join(root, 'package.json'));
  if (raw) {
    try {
      const pkg = JSON.parse(raw);
      const all = { ...pkg.dependencies, ...pkg.devDependencies };
      if (all['next']) return 'nextjs';
      if (all['fastify']) return 'fastify';
      if (all['hono']) return 'hono';
      if (all['express']) return 'express';
    } catch { /* ignore */ }
  }
  return 'express'; // fallback
}

async function inspectApi(root: string, framework: ApiFramework): Promise<ApiRoute[]> {
  const fw = framework === 'auto' ? await detectApiFramework(root) : framework;
  switch (fw) {
    case 'nextjs': {
      const app = await findNextjsAppRoutes(root);
      const pages = await findNextjsPagesRoutes(root);
      return [...app, ...pages];
    }
    case 'express': return findExpressRoutes(root);
    case 'fastify': return findFastifyRoutes(root);
    case 'hono': return findHonoRoutes(root);
    default: return findExpressRoutes(root);
  }
}

// ---------------------------------------------------------------------------
// Mode: database
// ---------------------------------------------------------------------------

function parseModelFields(body: string): DbField[] {
  const fields: DbField[] = [];
  const FIELD_RE = /^\s*(\w+)\s+(\w+)(\[\])?([?!])?/;
  for (const line of body.split('\n')) {
    const m = FIELD_RE.exec(line.trim());
    if (!m) continue;
    const name = m[1];
    // Skip keywords
    if (['@@', '@'].some((p) => name.startsWith(p))) continue;
    const type = m[2];
    const isOptional = m[4] === '?';
    const isRelation = /^[A-Z]/.test(type);
    fields.push({ name, type, isRelation, isOptional });
  }
  return fields;
}

function parsePrismaSchema(content: string): DatabaseInfo {
  const models: DbModel[] = [];
  const enums: DbEnum[] = [];

  // Parse models
  const MODEL_RE = /^model\s+(\w+)\s*\{([^}]*)\}/gm;
  let m: RegExpExecArray | null;
  while ((m = MODEL_RE.exec(content)) !== null) {
    const modelName = m[1];
    const body = m[2];
    const fields = parseModelFields(body);
    models.push({ name: modelName, fields });
  }

  // Parse enums
  const ENUM_RE = /^enum\s+(\w+)\s*\{([^}]*)\}/gm;
  while ((m = ENUM_RE.exec(content)) !== null) {
    const enumName = m[1];
    const body = m[2];
    const values = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//'))
      .filter((l) => /^\w+$/.test(l));
    enums.push({ name: enumName, values });
  }

  return { models, enums };
}

// ---------------------------------------------------------------------------
// Mode: components
// ---------------------------------------------------------------------------

function inspectComponents(content: string): ComponentInfo[] {
  const components: ComponentInfo[] = [];
  const lines = content.split('\n');

  // Patterns for component detection
  const FN_COMP_RE = /^(?:export\s+(?:default\s+)?)?function\s+(\w+)\s*\(/;
  const ARROW_COMP_RE = /^(?:export\s+(?:const|default)\s+)(\w+)\s*(?::\s*React\.FC[^=]*)?=\s*(?:(?:\([^)]*\)|\w+)\s*=>|React\.memo)/;
  const CLASS_COMP_RE = /^(?:export\s+(?:default\s+)?)?class\s+(\w+)\s+extends\s+(?:React\.)?(?:Component|PureComponent)/;

  // Hooks pattern
  const HOOK_RE = /\b(use[A-Z]\w*)\s*\(/g;
  // JSX child components (uppercase tags)
  const CHILD_COMP_RE = /<([A-Z]\w*)(?:\s|>|\/)/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let name: string | null = null;
    let kind: ComponentInfo['kind'] = 'function';

    let fnMatch = FN_COMP_RE.exec(line);
    if (fnMatch) {
      name = fnMatch[1];
      kind = 'function';
    }

    if (!name) {
      const arrowMatch = ARROW_COMP_RE.exec(line);
      if (arrowMatch) {
        name = arrowMatch[1];
        kind = 'arrow';
      }
    }

    if (!name) {
      const classMatch = CLASS_COMP_RE.exec(line);
      if (classMatch) {
        name = classMatch[1];
        kind = 'class';
      }
    }

    // Only record names that look like components (PascalCase)
    if (!name || !/^[A-Z]/.test(name)) continue;

    // Collect the next ~50 lines for hook/child analysis (until next top-level fn or end)
    let body = '';
    let end = Math.min(i + 50, lines.length);
    for (let j = i; j < end; j++) body += lines[j] + '\n';

    // Extract hooks
    const hooks: string[] = [];
    const hooksSeen = new Set<string>();
    let hm: RegExpExecArray | null;
    const hookRe = new RegExp(HOOK_RE.source, 'g');
    while ((hm = hookRe.exec(body)) !== null) {
      if (!hooksSeen.has(hm[1])) {
        hooksSeen.add(hm[1]);
        hooks.push(hm[1]);
      }
    }

    // Extract child components
    const children: string[] = [];
    const childSeen = new Set<string>();
    let cm: RegExpExecArray | null;
    const childRe = new RegExp(CHILD_COMP_RE.source, 'g');
    while ((cm = childRe.exec(body)) !== null) {
      if (!childSeen.has(cm[1]) && cm[1] !== name) {
        childSeen.add(cm[1]);
        children.push(cm[1]);
      }
    }

    // Extract props from the function signature (rough approximation)
    const props: string[] = [];
    const propLine = lines.slice(i, Math.min(i + 5, lines.length)).join(' ');
    const PROPS_DESTRUCTURE_RE = /\{\s*([^}]+)\s*\}/;
    const pm = PROPS_DESTRUCTURE_RE.exec(propLine);
    if (pm) {
      props.push(
        ...pm[1]
          .split(',')
          .map((p) => p.trim().replace(/[=:][^,]*/g, '').trim())
          .filter((p) => /^\w+$/.test(p)),
      );
    }

    components.push({ name, kind, line: i + 1, props, hooks, children });
  }

  return components;
}

// ---------------------------------------------------------------------------
// Mode: layout
// ---------------------------------------------------------------------------

function inspectLayout(content: string, file: string): LayoutInfo {
  const displays: string[] = [];
  const flex: string[] = [];
  const grid: string[] = [];
  const sizing: string[] = [];
  const overflow: string[] = [];

  // Tailwind and CSS class patterns
  const DISPLAY_RE = /\b(flex|grid|block|inline|inline-flex|inline-grid|inline-block|hidden|contents|flow-root)\b/g;
  const FLEX_RE = /\b(flex-(?:row|col|wrap|nowrap|1|auto|none|grow|shrink)|justify-(?:start|end|center|between|around|evenly)|items-(?:start|end|center|stretch|baseline)|gap-\w+|space-[xy]-\w+|self-\w+)\b/g;
  const GRID_RE = /\b(grid-cols-\w+|grid-rows-\w+|col-span-\w+|row-span-\w+|place-\w+-\w+)\b/g;
  const SIZING_RE = /\b(w-\w+|h-\w+|min-w-\w+|min-h-\w+|max-w-\w+|max-h-\w+|size-\w+)\b/g;
  const OVERFLOW_RE = /\b(overflow-(?:hidden|auto|scroll|visible|x-\w+|y-\w+)|truncate|text-ellipsis|whitespace-\w+)\b/g;

  const extract = (re: RegExp, target: string[]): void => {
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, 'g');
    while ((m = r.exec(content)) !== null) {
      if (!seen.has(m[1])) { seen.add(m[1]); target.push(m[1]); }
    }
  };

  extract(DISPLAY_RE, displays);
  extract(FLEX_RE, flex);
  extract(GRID_RE, grid);
  extract(SIZING_RE, sizing);
  extract(OVERFLOW_RE, overflow);

  return { file, displays, flex, grid, sizing, overflow };
}

// ---------------------------------------------------------------------------
// Mode: accessibility
// ---------------------------------------------------------------------------

function inspectAccessibility(content: string): A11yIssue[] {
  const issues: A11yIssue[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // img without alt attribute
    if (/<img\b(?![^>]*\balt=)/i.test(line)) {
      issues.push({
        line: lineNo,
        code: 'img-alt',
        message: 'img element is missing an alt attribute',
        wcag: 'WCAG 1.1.1 (Level A)',
      });
    }

    // button without accessible name (no text, no aria-label, no title)
    if (/<button\b(?![^>]*(?:aria-label|aria-labelledby|title))/i.test(line)) {
      // Check if it has content on the same line or nearby
      const hasContent = />[^<]+<\/button>/i.test(line) || />[^<]+/.test(line);
      if (!hasContent) {
        issues.push({
          line: lineNo,
          code: 'button-name',
          message: 'button element may be missing an accessible name',
          wcag: 'WCAG 4.1.2 (Level A)',
        });
      }
    }

    // onClick on non-interactive elements (div, span) without role
    if (/onClick/.test(line)) {
      if (/<(?:div|span)\b(?![^>]*\brole=)[^>]*onClick/i.test(line)) {
        issues.push({
          line: lineNo,
          code: 'click-events-have-key-events',
          message: 'Non-interactive element has onClick without a role attribute',
          wcag: 'WCAG 4.1.2 (Level A)',
        });
      }
    }

    // input without associated label (heuristic: no id or no aria-label)
    if (/<input\b/i.test(line) && !/type=['"]hidden['"]/.test(line)) {
      if (!/<label/i.test(line) && !/aria-label/.test(line) && !/aria-labelledby/.test(line)) {
        // Only flag if the previous few lines don't have a label
        const context = lines.slice(Math.max(0, i - 3), i + 1).join(' ');
        if (!/<label/i.test(context) && !/aria-label/.test(context)) {
          issues.push({
            line: lineNo,
            code: 'label',
            message: 'input element may be missing an associated label',
            wcag: 'WCAG 1.3.1 (Level A)',
          });
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Mode: scaffold
// ---------------------------------------------------------------------------

function buildScaffold(
  moduleName: string,
  projectRoot: string,
  dryRun: boolean,
): ScaffoldPlan {
  const pascal = moduleName.charAt(0).toUpperCase() + moduleName.slice(1);
  const kebab = moduleName.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');

  const files: ScaffoldFile[] = [
    {
      path: `src/${kebab}/index.ts`,
      content: `export * from './${kebab}.ts';\nexport * from './types.ts';\n`,
    },
    {
      path: `src/${kebab}/types.ts`,
      content: `export interface ${pascal} {\n  id: string;\n}\n\nexport interface ${pascal}Input {\n    name: string;
  // add more fields as needed\n}\n`,
    },
    {
      path: `src/${kebab}/${kebab}.ts`,
      content: `import type { ${pascal}, ${pascal}Input } from './types.ts';\n\nexport function create${pascal}(input: ${pascal}Input): ${pascal} {\n    // Simple implementation: generate a random id and spread input
  return { id: crypto.randomUUID(), ...input };
\n  throw new Error('Not implemented');\n}\n`,
    },
    {
      path: `src/${kebab}/${kebab}.test.ts`,
      content: `import { describe, test, expect } from 'bun:test';\nimport { create${pascal} } from './${kebab}.ts';\n\ndescribe('${pascal}', () => {\n  test('creates a ${pascal} object with id and input fields', () => {\n    const result = create${pascal}({ name: 'test' });
    expect(result).toHaveProperty('id');
    expect(result.name).toBe('test');\n  });\n});\n`,
    },
  ];

  if (!dryRun) {
    for (const f of files) {
      const absPath = join(projectRoot, f.path);
      mkdirSync(resolve(absPath, '..'), { recursive: true });
      writeFileSync(absPath, f.content, 'utf-8');
    }
  }

  return { moduleName, dryRun, files };
}

// ---------------------------------------------------------------------------
// Mode: api_spec
// ---------------------------------------------------------------------------

/**
 * Convert an Express-style path (e.g. /users/:id) to an OpenAPI path (/users/{id})
 * and extract path parameter names.
 */
function toOpenApiPath(path: string): { openApiPath: string; params: string[] } {
  const params: string[] = [];
  const openApiPath = path.replace(/:([\w]+)/g, (_, name) => {
    params.push(name);
    return `{${name}}`;
  });
  return { openApiPath, params };
}

function generateApiSpec(routes: ApiRoute[], title = 'API', version = '1.0.0'): ApiSpec {
  const paths: ApiSpec['paths'] = {};

  for (const route of routes) {
    const { openApiPath, params } = toOpenApiPath(route.path);
    if (!paths[openApiPath]) paths[openApiPath] = {};

    const method = route.method.toLowerCase();
    if (method === 'any') {
      // Pages Router catch-all: emit GET as representative
      const opId = `get_${openApiPath.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;
      const parameters: OpenApiParameter[] = params.map((p) => ({
        name: p,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      }));
      paths[openApiPath]['get'] = {
        operationId: opId,
        ...(parameters.length ? { parameters } : {}),
        responses: { '200': { description: 'OK' } },
      };
      continue;
    }

    const opId = `${method}_${openApiPath.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;
    const parameters: OpenApiParameter[] = params.map((p) => ({
      name: p,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));

    paths[openApiPath][method] = {
      operationId: opId,
      ...(parameters.length ? { parameters } : {}),
      responses: { '200': { description: 'OK' } },
    };
  }

  return { openapi: '3.0.0', info: { title, version }, paths };
}

// ---------------------------------------------------------------------------
// Mode: api_validate
// ---------------------------------------------------------------------------

function validateApiSpec(specContent: string, routes: ApiRoute[]): ApiValidateResult {
  let specObj: Record<string, unknown>;
  try {
    specObj = JSON.parse(specContent);
  } catch {
    throw new Error('specPath must be a valid JSON OpenAPI spec file');
  }

  const specPaths = (specObj.paths ?? {}) as Record<string, Record<string, unknown>>;

  // Build a map of path -> Set<method> from the spec
  const specRouteMap = new Map<string, Set<string>>();
  for (const [rawPath, pathItem] of Object.entries(specPaths)) {
    // Normalize OpenAPI {param} -> :param for comparison
    const normalPath = rawPath.replace(/\{([^}]+)\}/g, ':$1');
    const methods = new Set(
      Object.keys(pathItem)
        .filter((k) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(k))
        .map((m) => m.toUpperCase()),
    );
    specRouteMap.set(normalPath, methods);
  }

  // Build a map of path -> Set<method> from discovered code routes
  const codeRouteMap = new Map<string, Set<string>>();
  for (const route of routes) {
    const methods = codeRouteMap.get(route.path) ?? new Set<string>();
    if (route.method !== 'ANY') methods.add(route.method);
    codeRouteMap.set(route.path, methods);
  }

  const missing_from_spec: string[] = [];
  const missing_from_code: string[] = [];
  const mismatched_methods: ApiValidateResult['mismatched_methods'] = [];

  // Routes in code but not in spec (or method mismatch)
  for (const [path, codeMethods] of codeRouteMap) {
    const specMethods = specRouteMap.get(path);
    if (!specMethods) {
      for (const m of codeMethods) {
        missing_from_spec.push(`${m} ${path}`);
      }
    } else {
      const specArr = [...specMethods];
      const codeArr = [...codeMethods];
      const onlyInSpec = specArr.filter((m) => !codeMethods.has(m));
      const onlyInCode = codeArr.filter((m) => !specMethods.has(m));
      if (onlyInSpec.length || onlyInCode.length) {
        mismatched_methods.push({ path, spec_methods: specArr, code_methods: codeArr });
      }
    }
  }

  // Routes in spec but not in code
  for (const [path, specMethods] of specRouteMap) {
    if (!codeRouteMap.has(path)) {
      for (const m of specMethods) {
        missing_from_code.push(`${m} ${path}`);
      }
    }
  }

  const valid = missing_from_spec.length === 0 && missing_from_code.length === 0 && mismatched_methods.length === 0;
  return { valid, missing_from_spec, missing_from_code, mismatched_methods };
}

// ---------------------------------------------------------------------------
// Mode: api_sync
// ---------------------------------------------------------------------------

/**
 * Scan frontend directories for fetch() calls and extract URL strings.
 * Heuristic: look for fetch("/...") or fetch(`/...`) patterns.
 */
async function findFetchCalls(root: string): Promise<FetchCall[]> {
  const calls: FetchCall[] = [];
  // Scan common frontend dirs
  const frontendDirs = ['src/app', 'src/pages', 'app', 'pages'].map((d) => join(root, d));
  const dirsToScan = frontendDirs.filter(existsSync);
  if (dirsToScan.length === 0) {
    // Fallback: scan src/ broadly
    dirsToScan.push(join(root, 'src'));
  }

  const FETCH_RE = /fetch\(\s*[`'"](\/[^`'"?#]*)[`'"]/g;

  for (const dir of dirsToScan) {
    if (!existsSync(dir)) continue;
    const files = await walk(dir, (p) => /\.[tj]sx?$/.test(p));
    for (const file of files) {
      const content = safeRead(file);
      const relFile = relative(root, file);
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let m: RegExpExecArray | null;
        const re = new RegExp(FETCH_RE.source, 'g');
        while ((m = re.exec(line)) !== null) {
          calls.push({ url: m[1], file: relFile, line: i + 1 });
        }
      }
    }
  }

  return calls;
}

/**
 * Normalize a URL for comparison: strip trailing slash, convert {param} and :param
 * to a placeholder so /users/123 and /users/:id can be compared.
 */
function normalizeUrlForMatch(url: string): string {
  return url
    .replace(/\/:\w+/g, '/:p')
    .replace(/\/\{\w+\}/g, '/:p')
    .replace(/\/$/, '') || '/';
}

async function inspectApiSync(root: string, framework: ApiFramework): Promise<ApiSyncResult> {
  const [routes, fetchCalls] = await Promise.all([
    inspectApi(root, framework),
    findFetchCalls(root),
  ]);

  const normalizedRoutes = routes.map((r) => ({
    ...r,
    _normalized: normalizeUrlForMatch(r.path),
  }));

  const unmatched_fetches: FetchCall[] = [];
  const matchedRouteNorms = new Set<string>();

  for (const fc of fetchCalls) {
    const norm = normalizeUrlForMatch(fc.url);
    const matched = normalizedRoutes.some((r) => r._normalized === norm);
    if (matched) {
      matchedRouteNorms.add(norm);
    } else {
      unmatched_fetches.push(fc);
    }
  }

  // Routes not matched by any fetch call
  const unmatched_routes = normalizedRoutes
    .filter((r) => !matchedRouteNorms.has(r._normalized))
    .map(({ _normalized: _, ...rest }) => rest);

  const drift_detected = unmatched_fetches.length > 0;

  return { fetch_calls: fetchCalls, unmatched_fetches, unmatched_routes, drift_detected };
}

// ---------------------------------------------------------------------------
// Frontend analysis functions (C12)
// ---------------------------------------------------------------------------

/** Trace state/props through React components via useState/useReducer/useContext. */
function inspectComponentState(content: string, file: string): ComponentStateInfo {
  const lines = content.split('\n');
  const stateVars: StateVar[] = [];
  const useStateRe = /const\s*\[\s*(\w+)\s*,/;
  const useContextRe = /(?:const|let|var)\s+(\w+)\s*=\s*useContext\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    if (/\buseState\s*\(/.test(line)) {
      const m = useStateRe.exec(line);
      stateVars.push({ name: m ? m[1] : '(unknown)', kind: 'useState', line: ln });
    } else if (/\buseReducer\s*\(/.test(line)) {
      const m = useStateRe.exec(line);
      stateVars.push({ name: m ? m[1] : '(unknown)', kind: 'useReducer', line: ln });
    } else if (/\buseContext\s*\(/.test(line)) {
      const m = useContextRe.exec(line);
      stateVars.push({ name: m ? m[1] : '(unknown)', kind: 'useContext', line: ln });
    }
  }
  return { file, stateVars, count: stateVars.length };
}

/** Find what causes re-renders: state setters, effect deps, memo boundaries. */
function inspectRenderTriggers(content: string, file: string): RenderTriggersInfo {
  const lines = content.split('\n');
  const triggers: RenderTrigger[] = [];
  const setterRe = /const\s*\[\s*\w+\s*,\s*(set\w+)\s*\]/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    if (setterRe.test(line)) {
      const m = setterRe.exec(line);
      if (m) triggers.push({ kind: 'state_setter', name: m[1], line: ln });
    }
    if (/\buseEffect\s*\(/.test(line)) triggers.push({ kind: 'effect_dep', name: 'useEffect', line: ln });
    if (/\buseMemo\s*\(/.test(line)) triggers.push({ kind: 'memo_dep', name: 'useMemo', line: ln });
    if (/\buseCallback\s*\(/.test(line)) triggers.push({ kind: 'callback_dep', name: 'useCallback', line: ln });
    if (/(?:React\.memo|\bmemo)\s*\(/.test(line)) triggers.push({ kind: 'memo_boundary', name: 'memo', line: ln });
  }
  return { file, triggers, count: triggers.length };
}

/** Analyze hook dependency arrays; flag variables potentially missing from deps. */
function inspectHooks(content: string, file: string): HooksInfo {
  const lines = content.split('\n');
  const hooks: HookDep[] = [];
  let missingDepsCount = 0;
  const hookRe = /\b(useEffect|useMemo|useCallback)\s*\(/;
  const inlineDepsRe = /[},]\s*\[([^\]]*)\]\s*\)/;
  const skipKeywords = new Set(['useEffect', 'useMemo', 'useCallback', 'return', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'true', 'false', 'null', 'undefined', 'async', 'await', 'function', 'new', 'this', 'of', 'in', 'console', 'Math', 'JSON', 'Array', 'Object', 'Promise', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'window', 'document', 'fetch', 'NaN', 'Infinity', 'Error', 'RegExp', 'Date', 'Map', 'Set', 'parseInt', 'parseFloat']);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hm = hookRe.exec(line);
    if (!hm) continue;
    const hookKind = hm[1] as 'useEffect' | 'useMemo' | 'useCallback';
    const ln = i + 1;
    const body = lines.slice(i, Math.min(i + 30, lines.length)).join('\n');
    const dm = inlineDepsRe.exec(body);
    const deps = dm ? dm[1].split(',').map(d => d.trim()).filter(Boolean) : [];
    const callbackBody = body.slice(0, body.lastIndexOf(']'));
    const usedVarsRe = /\b([a-zA-Z_$][\w$]*)\b/g;
    const usedVars = new Set<string>();
    let vm: RegExpExecArray | null;
    while ((vm = usedVarsRe.exec(callbackBody)) !== null) {
      if (!skipKeywords.has(vm[1]) && vm[1].length > 1) usedVars.add(vm[1]);
    }
    const missing = [...usedVars].filter(v => !deps.includes(v) && /^[a-z]/.test(v)).slice(0, 5);
    if (missing.length) missingDepsCount++;
    hooks.push({ hookKind, line: ln, deps, missing });
  }
  return { file, hooks, missingDepsCount };
}

/** Find CSS overflow issues. */
function inspectOverflow(content: string, file: string): OverflowInfo {
  const lines = content.split('\n');
  const issues: OverflowIssue[] = [];
  const hasHeightRe = /\b(?:h-|max-h-|height)\b/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    if (/\boverflow-hidden\b/.test(line) || /overflow\s*:\s*hidden/.test(line)) {
      if (!hasHeightRe.test(line)) {
        issues.push({ line: ln, kind: 'hidden_clip', snippet: line.trim().slice(0, 80) });
      }
    } else if (/\b(?:overflow-(?:scroll|auto|y-scroll|y-auto|x-scroll|x-auto))\b/.test(line) || /overflow(?:-y|-x)?\s*:\s*(?:scroll|auto)/.test(line)) {
      if (!hasHeightRe.test(line)) {
        issues.push({ line: ln, kind: 'scroll_no_height', snippet: line.trim().slice(0, 80) });
      }
    }
  }
  return { file, issues, count: issues.length };
}

/** Analyze sizing strategy: fixed px, percentages, flex/grid, viewport units. */
function inspectSizing(content: string, file: string): SizingInfo {
  const lines = content.split('\n');
  const items: SizingItem[] = [];
  let hardcodedCount = 0;
  const tailwindFixedRe = /\b(?:w|h|min-w|max-w|min-h|max-h)-(\d+)\b/g;
  const tailwindPctRe = /\b(?:w|h)-(\d+\/\d+|full|screen)\b/g;
  const tailwindFlexRe = /\bflex-(?:1|auto|none|initial|grow|shrink)\b/g;
  const tailwindGridRe = /\bgrid-cols-\d+\b/g;
  const tailwindVpRe = /\b(?:w|h)-(?:screen|lvh|svh|dvh)\b/g;
  const cssPxRe = /(?:width|height|min-width|max-width|min-height|max-height)\s*:\s*(\d+)px/g;
  const cssPctRe = /(?:width|height)\s*:\s*(\d+%)/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    let m: RegExpExecArray | null;
    tailwindFixedRe.lastIndex = 0;
    while ((m = tailwindFixedRe.exec(line)) !== null) {
      const val = parseInt(m[1]);
      const flagged = val > 96;
      if (flagged) hardcodedCount++;
      items.push({ line: ln, kind: 'fixed_px', value: m[0], flagged });
    }
    tailwindPctRe.lastIndex = 0;
    while ((m = tailwindPctRe.exec(line)) !== null) {
      items.push({ line: ln, kind: 'percentage', value: m[0], flagged: false });
    }
    tailwindFlexRe.lastIndex = 0;
    while ((m = tailwindFlexRe.exec(line)) !== null) {
      items.push({ line: ln, kind: 'flex', value: m[0], flagged: false });
    }
    tailwindGridRe.lastIndex = 0;
    while ((m = tailwindGridRe.exec(line)) !== null) {
      items.push({ line: ln, kind: 'grid', value: m[0], flagged: false });
    }
    tailwindVpRe.lastIndex = 0;
    while ((m = tailwindVpRe.exec(line)) !== null) {
      items.push({ line: ln, kind: 'viewport', value: m[0], flagged: false });
    }
    cssPxRe.lastIndex = 0;
    while ((m = cssPxRe.exec(line)) !== null) {
      const flagged = parseInt(m[1]) > 200;
      if (flagged) hardcodedCount++;
      items.push({ line: ln, kind: 'fixed_px', value: m[0], flagged });
    }
    cssPctRe.lastIndex = 0;
    while ((m = cssPctRe.exec(line)) !== null) {
      items.push({ line: ln, kind: 'percentage', value: m[0], flagged: false });
    }
  }
  return { file, items, hardcodedCount };
}

/** Z-index and stacking context analysis. */
function inspectStacking(content: string, file: string): StackingInfo {
  const lines = content.split('\n');
  const zIndexItems: ZIndexItem[] = [];
  const tailwindZRe = /-?z-(\d+|auto)\b/g;
  const cssZRe = /z-index\s*:\s*(-?\d+)/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    let m: RegExpExecArray | null;
    tailwindZRe.lastIndex = 0;
    while ((m = tailwindZRe.exec(line)) !== null) {
      zIndexItems.push({ line: ln, value: m[0], context: line.trim().slice(0, 60) });
    }
    cssZRe.lastIndex = 0;
    while ((m = cssZRe.exec(line)) !== null) {
      zIndexItems.push({ line: ln, value: m[0], context: line.trim().slice(0, 60) });
    }
  }
  const byValue = new Map<string, number[]>();
  for (const item of zIndexItems) {
    const existing = byValue.get(item.value) ?? [];
    existing.push(item.line);
    byValue.set(item.value, existing);
  }
  const potentialConflicts: Array<{ values: string[]; lines: number[] }> = [];
  for (const [val, lineNums] of byValue) {
    if (lineNums.length > 1) potentialConflicts.push({ values: [val], lines: lineNums });
  }
  return { file, zIndexItems, potentialConflicts };
}

/** Tailwind responsive breakpoint analysis. */
function inspectResponsive(content: string, file: string): ResponsiveInfo {
  const lines = content.split('\n');
  const prefixes = ['sm', 'md', 'lg', 'xl', '2xl'] as const;
  const breakpointMap = new Map<string, string[]>();
  for (const p of prefixes) breakpointMap.set(p, []);
  const re = /\b(sm|md|lg|xl|2xl):([-\w/[\]]+)/g;
  for (const line of lines) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const arr = breakpointMap.get(m[1])!;
      arr.push(m[0]);
    }
  }
  const breakpoints: BreakpointUsage[] = [];
  for (const p of prefixes) {
    const classes = breakpointMap.get(p)!;
    if (classes.length) breakpoints.push({ prefix: p, count: classes.length, classes: [...new Set(classes)].slice(0, 20) });
  }
  return { file, breakpoints, hasMobileFirst: (breakpointMap.get('sm')?.length ?? 0) > 0 };
}

/** Event handling analysis. */
function inspectEvents(content: string, file: string): EventsInfo {
  const lines = content.split('\n');
  const handlers: EventHandler[] = [];
  const eventRe = /\bon(Click|Change|Submit|KeyDown|KeyUp|KeyPress|Focus|Blur|MouseEnter|MouseLeave|Input|Scroll|Resize)\s*[={]/gi;
  const preventDefaultRe = /\.preventDefault\s*\(/;
  const stopPropagationRe = /\.stopPropagation\s*\(/;
  const delegationRe = /(?:document|window)\s*\.\s*addEventListener\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    eventRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = eventRe.exec(line)) !== null) {
      const ln = i + 1;
      const ctx = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 4)).join('\n');
      handlers.push({
        line: ln,
        event: m[0].slice(0, -1).trim(),
        hasPreventDefault: preventDefaultRe.test(ctx),
        hasStopPropagation: stopPropagationRe.test(ctx),
        isDelegated: delegationRe.test(line),
      });
    }
  }
  return { file, handlers, count: handlers.length };
}

/** Detect contradictory Tailwind classes. */
function inspectTailwind(content: string, file: string): TailwindInfo {
  const lines = content.split('\n');
  const conflicts: TailwindConflict[] = [];
  const conflictGroups: Array<{ pattern: RegExp; name: string }> = [
    { pattern: /\bp-(\d+|px|py|\w+)\b/g, name: 'padding' },
    { pattern: /\bm-(\d+|px|py|auto|\w+)\b/g, name: 'margin' },
    { pattern: /\btext-(red|blue|green|yellow|purple|pink|gray|black|white|slate|zinc|neutral|stone|orange|amber|lime|emerald|teal|cyan|sky|violet|fuchsia|rose)-(\d+)\b/g, name: 'text-color' },
    { pattern: /\bbg-(red|blue|green|yellow|purple|pink|gray|black|white|slate|zinc|neutral|stone|orange|amber|lime|emerald|teal|cyan|sky|violet|fuchsia|rose)-(\d+)?\b/g, name: 'background' },
    { pattern: /\b(?:block|inline-block|inline|flex|inline-flex|grid|inline-grid|hidden|contents|flow-root|list-item)\b/g, name: 'display' },
    { pattern: /\btext-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/g, name: 'font-size' },
    { pattern: /\bfont-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/g, name: 'font-weight' },
    { pattern: /\bjustify-(start|end|center|between|around|evenly|stretch)\b/g, name: 'justify-content' },
    { pattern: /\bitems-(start|end|center|baseline|stretch)\b/g, name: 'align-items' },
    { pattern: /\bw-(\d+|\/\w+|full|screen|auto|min|max|fit)\b/g, name: 'width' },
    { pattern: /\bh-(\d+|\/\w+|full|screen|auto|min|max|fit)\b/g, name: 'height' },
  ];
  const classNameRe = /className\s*=\s*["']([^"']+)["']/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let cm: RegExpExecArray | null;
    classNameRe.lastIndex = 0;
    while ((cm = classNameRe.exec(line)) !== null) {
      const classStr = cm[1];
      for (const { pattern, name } of conflictGroups) {
        const found: string[] = [];
        pattern.lastIndex = 0;
        let mm: RegExpExecArray | null;
        while ((mm = pattern.exec(classStr)) !== null) found.push(mm[0]);
        if (found.length > 1) {
          conflicts.push({ line: i + 1, classes: found, reason: `Multiple ${name} classes: ${found.join(', ')}` });
        }
      }
    }
  }
  return { file, conflicts, count: conflicts.length };
}

/** Next.js 'use client'/'use server' directive analysis. */
function inspectClientBoundary(content: string, file: string): ClientBoundaryInfo {
  const lines = content.split('\n');
  let directive: 'use client' | 'use server' | null = null;
  const serverOnlyModules = ['server-only', 'next/headers', 'next-auth/server'];
  const serverOnlyImports: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "'use client';" || trimmed === '"use client";' || trimmed === "'use client'" || trimmed === '"use client"') { directive = 'use client'; break; }
    if (trimmed === "'use server';" || trimmed === '"use server";' || trimmed === "'use server'" || trimmed === '"use server"') { directive = 'use server'; break; }
    break;
  }
  const importRe = /import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/g;
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(content)) !== null) {
    if (serverOnlyModules.some(mod => im![1] === mod || im![1].startsWith(mod + '/'))) serverOnlyImports.push(im[1]);
  }
  return { file, directive, importsServerOnly: serverOnlyImports.length > 0, serverOnlyImports };
}

/** Error boundary coverage analysis. */
function inspectErrorBoundary(content: string, file: string): ErrorBoundaryInfo {
  const boundaryComponents: string[] = [];
  const coveredRoutes: string[] = [];
  const errorBoundaryRe = /(?:class\s+(\w*ErrorBoundary\w*)\s+extends|<(\w*ErrorBoundary\w*)|import\s+.*?(\w*ErrorBoundary\w*).*?from)/g;
  let m: RegExpExecArray | null;
  while ((m = errorBoundaryRe.exec(content)) !== null) {
    const name = m[1] || m[2] || m[3];
    if (name && !boundaryComponents.includes(name)) boundaryComponents.push(name);
  }
  if (/(?:^|[\/\\])error\.[jt]sx?$/.test(file)) boundaryComponents.push('error.tsx (Next.js App Router)');
  const wrappedRouteRe = /<(?:\w*ErrorBoundary\w*)[^>]*>[\s\S]*?<\/(?:\w*ErrorBoundary\w*)>/g;
  let wr: RegExpExecArray | null;
  while ((wr = wrappedRouteRe.exec(content)) !== null) {
    const routeMatch = /<(\w+)/.exec(wr[0].slice(wr[0].indexOf('>') + 1));
    if (routeMatch && !coveredRoutes.includes(routeMatch[1])) coveredRoutes.push(routeMatch[1]);
  }
  return { file, hasErrorBoundary: boundaryComponents.length > 0, boundaryComponents, coveredRoutes };
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class InspectTool implements Tool {
  readonly definition = {
    name: 'inspect',
    description:
      'Inspect and analyze a project or file. Modes: project (structure), api (routes),'
      + ' api_spec (generate OpenAPI 3.0 spec), api_validate (compare spec to code),'
      + ' api_sync (detect frontend/backend drift),'
      + ' database (schema), components (React), layout (CSS/Tailwind),'
      + ' accessibility (a11y issues), scaffold (module skeleton generator).',
    parameters: INSPECT_TOOL_SCHEMA,
  };

  async execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> {
    if (!args.mode || typeof args.mode !== 'string') {
      return { success: false, error: 'mode is required' };
    }

    const input = args as unknown as InspectInput;

    const VALID_MODES = ['project', 'api', 'api_spec', 'api_validate', 'api_sync', 'database', 'components', 'layout', 'accessibility', 'scaffold', 'component_state', 'render_triggers', 'hooks', 'overflow', 'sizing', 'stacking', 'responsive', 'events', 'tailwind', 'client_boundary', 'error_boundary'];
    if (!VALID_MODES.includes(input.mode)) {
      return { success: false, error: `Invalid mode: ${input.mode}. Valid modes: ${VALID_MODES.join(', ')}` };
    }

    const projectRoot = resolve(input.projectRoot ?? process.cwd());
    const format = input.output?.format ?? 'detailed';

    try {
      switch (input.mode as InspectMode) {
        case 'project': {
          const info = detectProject(projectRoot);
          return { success: true, output: JSON.stringify(info, null, format === 'json' ? 2 : 0) };
        }

        case 'api': {
          const framework: ApiFramework = (input.framework ?? 'auto') as ApiFramework;
          const routes = await inspectApi(projectRoot, framework);
          return { success: true, output: JSON.stringify({ routes, count: routes.length }, null, format === 'json' ? 2 : 0) };
        }

        case 'database': {
          const schemaPath = input.schemaPath
            ? resolvePath(projectRoot, input.schemaPath)
            : join(projectRoot, 'prisma', 'schema.prisma');

          if (!existsSync(schemaPath)) {
            return { success: false, error: `Database schema not found at: ${schemaPath}` };
          }

          const content = safeRead(schemaPath);
          const dbInfo = parsePrismaSchema(content);
          return { success: true, output: JSON.stringify(dbInfo, null, format === 'json' ? 2 : 0) };
        }

        case 'components': {
          if (!input.file) {
            return { success: false, error: 'file is required for components mode' };
          }
          const filePath = resolvePath(projectRoot, input.file);
          if (!existsSync(filePath)) {
            return { success: false, error: `File not found: ${filePath}` };
          }
          const content = safeRead(filePath);
          const comps = inspectComponents(content);
          return { success: true, output: JSON.stringify({ components: comps, count: comps.length }, null, format === 'json' ? 2 : 0) };
        }

        case 'layout': {
          if (!input.file) {
            return { success: false, error: 'file is required for layout mode' };
          }
          const filePath = resolvePath(projectRoot, input.file);
          if (!existsSync(filePath)) {
            return { success: false, error: `File not found: ${filePath}` };
          }
          const content = safeRead(filePath);
          const layoutInfo = inspectLayout(content, input.file);
          return { success: true, output: JSON.stringify(layoutInfo, null, format === 'json' ? 2 : 0) };
        }

        case 'accessibility': {
          if (!input.file) {
            return { success: false, error: 'file is required for accessibility mode' };
          }
          const filePath = resolvePath(projectRoot, input.file);
          if (!existsSync(filePath)) {
            return { success: false, error: `File not found: ${filePath}` };
          }
          const content = safeRead(filePath);
          const a11yIssues = inspectAccessibility(content);
          return {
            success: true,
            output: JSON.stringify({ issues: a11yIssues, count: a11yIssues.length }, null, format === 'json' ? 2 : 0),
          };
        }

        case 'api_spec': {
          const framework: ApiFramework = (input.framework ?? 'auto') as ApiFramework;
          const routes = await inspectApi(projectRoot, framework);
          const spec = generateApiSpec(routes);
          return { success: true, output: JSON.stringify(spec, null, format === 'json' ? 2 : 0) };
        }

        case 'api_validate': {
          if (!input.specPath) {
            return { success: false, error: 'specPath is required for api_validate mode' };
          }
          const resolvedSpec = resolvePath(projectRoot, input.specPath);
          if (!existsSync(resolvedSpec)) {
            return { success: false, error: `Spec file not found at: ${resolvedSpec}` };
          }
          const specContent = safeRead(resolvedSpec);
          const framework: ApiFramework = (input.framework ?? 'auto') as ApiFramework;
          const routes = await inspectApi(projectRoot, framework);
          const validationResult = validateApiSpec(specContent, routes);
          return { success: true, output: JSON.stringify(validationResult, null, format === 'json' ? 2 : 0) };
        }

        case 'api_sync': {
          const framework: ApiFramework = (input.framework ?? 'auto') as ApiFramework;
          const syncResult = await inspectApiSync(projectRoot, framework);
          return { success: true, output: JSON.stringify(syncResult, null, format === 'json' ? 2 : 0) };
        }

        case 'scaffold': {
          if (!input.moduleName) {
            return { success: false, error: 'moduleName is required for scaffold mode' };
          }
          const dryRun = input.dryRun !== false; // default true
          const plan = buildScaffold(input.moduleName, projectRoot, dryRun);
          return { success: true, output: JSON.stringify(plan, null, format === 'json' ? 2 : 0) };
        }

        case 'component_state': {
          if (!input.file) return { success: false, error: 'file is required for component_state mode' };
          const filePath = resolvePath(projectRoot, input.file);
          if (!existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
          const content = safeRead(filePath);
          const result = inspectComponentState(content, input.file);
          return { success: true, output: JSON.stringify(result, null, format === 'json' ? 2 : 0) };
        }

        case 'render_triggers': {
          if (!input.file) return { success: false, error: 'file is required for render_triggers mode' };
          const filePath = resolvePath(projectRoot, input.file);
          if (!existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
          const content = safeRead(filePath);
          const result = inspectRenderTriggers(content, input.file);
          return { success: true, output: JSON.stringify(result, null, format === 'json' ? 2 : 0) };
        }

        case 'hooks': {
          if (!input.file) return { success: false, error: 'file is required for hooks mode' };
          const filePath = resolvePath(projectRoot, input.file);
          if (!existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
          const content = safeRead(filePath);
          const result = inspectHooks(content, input.file);
          return { success: true, output: JSON.stringify(result, null, format === 'json' ? 2 : 0) };
        }

        case 'overflow': {
          if (!input.file) return { success: false, error: 'file is required for overflow mode' };
          const filePath = resolvePath(projectRoot, input.file);
          if (!existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
          const content = safeRead(filePath);
          const result = inspectOverflow(content, input.file);
          return { success: true, output: JSON.stringify(result, null, format === 'json' ? 2 : 0) };
        }

        case 'sizing': {
          if (!input.file) return { success: false, error: 'file is required for sizing mode' };
          const filePath = resolvePath(projectRoot, input.file);
          if (!existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
          const content = safeRead(filePath);
          const result = inspectSizing(content, input.file);
          return { success: true, output: JSON.stringify(result, null, format === 'json' ? 2 : 0) };
        }

        case 'stacking': {
          if (!input.file) return { success: false, error: 'file is required for stacking mode' };
          const filePath = resolvePath(projectRoot, input.file);
          if (!existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
          const content = safeRead(filePath);
          const result = inspectStacking(content, input.file);
          return { success: true, output: JSON.stringify(result, null, format === 'json' ? 2 : 0) };
        }

        case 'responsive': {
          if (!input.file) return { success: false, error: 'file is required for responsive mode' };
          const filePath = resolvePath(projectRoot, input.file);
          if (!existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
          const content = safeRead(filePath);
          const result = inspectResponsive(content, input.file);
          return { success: true, output: JSON.stringify(result, null, format === 'json' ? 2 : 0) };
        }

        case 'events': {
          if (!input.file) return { success: false, error: 'file is required for events mode' };
          const filePath = resolvePath(projectRoot, input.file);
          if (!existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
          const content = safeRead(filePath);
          const result = inspectEvents(content, input.file);
          return { success: true, output: JSON.stringify(result, null, format === 'json' ? 2 : 0) };
        }

        case 'tailwind': {
          if (!input.file) return { success: false, error: 'file is required for tailwind mode' };
          const filePath = resolvePath(projectRoot, input.file);
          if (!existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
          const content = safeRead(filePath);
          const result = inspectTailwind(content, input.file);
          return { success: true, output: JSON.stringify(result, null, format === 'json' ? 2 : 0) };
        }

        case 'client_boundary': {
          if (!input.file) return { success: false, error: 'file is required for client_boundary mode' };
          const filePath = resolvePath(projectRoot, input.file);
          if (!existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
          const content = safeRead(filePath);
          const result = inspectClientBoundary(content, input.file);
          return { success: true, output: JSON.stringify(result, null, format === 'json' ? 2 : 0) };
        }

        case 'error_boundary': {
          if (!input.file) return { success: false, error: 'file is required for error_boundary mode' };
          const filePath = resolvePath(projectRoot, input.file);
          if (!existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
          const content = safeRead(filePath);
          const result = inspectErrorBoundary(content, input.file);
          return { success: true, output: JSON.stringify(result, null, format === 'json' ? 2 : 0) };
        }

        default: {
          return { success: false, error: `Unknown mode: ${input.mode}` };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `inspect (${input.mode}): ${message}` };
    }
  }
}
