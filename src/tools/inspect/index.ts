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

function parseModelFields(body: string): DbField[] {
  const fields: DbField[] = [];
  // Prisma field: name Type modifiers attributes
  // e.g.: id String @id @default(cuid())
  //       posts Post[]
  //       userId String?
  const FIELD_RE = /^\s*(\w+)\s+(\w+)(\[\])?([?!])?/;
  const PRISMA_SCALARS = new Set([
    'String', 'Int', 'Float', 'Boolean', 'DateTime',
    'BigInt', 'Bytes', 'Decimal', 'Json',
  ]);

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@')) continue;
    const fm = FIELD_RE.exec(trimmed);
    if (!fm) continue;
    const fieldName = fm[1];
    const fieldType = fm[2] + (fm[3] || '');
    const isOptional = fm[4] === '?';
    // Relation: uppercase type that is not a Prisma scalar, or has @relation
    const isRelation = (!PRISMA_SCALARS.has(fm[2]) && /^[A-Z]/.test(fm[2])) || trimmed.includes('@relation');
    fields.push({ name: fieldName, type: fieldType, isRelation, isOptional });
  }
  return fields;
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
      content: `export interface ${pascal} {\n  id: string;\n}\n\nexport interface ${pascal}Input {\n  // TODO: define input fields\n}\n`,
    },
    {
      path: `src/${kebab}/${kebab}.ts`,
      content: `import type { ${pascal}, ${pascal}Input } from './types.ts';\n\nexport function create${pascal}(input: ${pascal}Input): ${pascal} {\n  // TODO: implement\n  throw new Error('Not implemented');\n}\n`,
    },
    {
      path: `src/${kebab}/${kebab}.test.ts`,
      content: `import { describe, test, expect } from 'bun:test';\nimport { create${pascal} } from './${kebab}.ts';\n\ndescribe('${pascal}', () => {\n  test('TODO', () => {\n    expect(true).toBe(true);\n  });\n});\n`,
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
// Tool class
// ---------------------------------------------------------------------------

export class InspectTool implements Tool {
  readonly definition = {
    name: 'inspect',
    description:
      'Inspect and analyze a project or file. Modes: project (structure), api (routes),'
      + ' database (schema), components (React), layout (CSS/Tailwind),'
      + ' accessibility (a11y issues), scaffold (module skeleton generator).',
    parameters: INSPECT_TOOL_SCHEMA,
  };

  async execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> {
    if (!args.mode || typeof args.mode !== 'string') {
      return { success: false, error: 'mode is required' };
    }

    const input = args as InspectInput;

    const VALID_MODES = ['project', 'api', 'database', 'components', 'layout', 'accessibility', 'scaffold'];
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

        case 'scaffold': {
          if (!input.moduleName) {
            return { success: false, error: 'moduleName is required for scaffold mode' };
          }
          const dryRun = input.dryRun !== false; // default true
          const plan = buildScaffold(input.moduleName, projectRoot, dryRun);
          return { success: true, output: JSON.stringify(plan, null, format === 'json' ? 2 : 0) };
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
