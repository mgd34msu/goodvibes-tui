import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { walk, safeRead, resolvePath } from './shared.ts';
import type {
  ApiFramework,
  ProjectInfo,
  ApiRoute,
  DatabaseInfo,
  DbField,
  DbModel,
  DbEnum,
  ScaffoldPlan,
  ScaffoldFile,
  ApiSpec,
  OpenApiParameter,
  ApiValidateResult,
  FetchCall,
  ApiSyncResult,
} from './schema.ts';

export function detectProject(root: string): ProjectInfo {
  const has = (f: string) => existsSync(join(root, f));

  let type: ProjectInfo['type'] = 'unknown';
  if (has('package.json')) type = 'nodejs';
  else if (has('Cargo.toml')) type = 'rust';
  else if (has('pyproject.toml') || has('requirements.txt')) type = 'python';
  else if (has('go.mod')) type = 'go';
  else if (has('Makefile')) type = 'make';

  let packageManager: ProjectInfo['packageManager'] = 'none';
  if (type === 'nodejs') {
    if (has('bun.lockb')) packageManager = 'bun';
    else if (has('yarn.lock')) packageManager = 'yarn';
    else if (has('pnpm-lock.yaml')) packageManager = 'pnpm';
    else packageManager = 'npm';
  }

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

async function findNextjsAppRoutes(root: string): Promise<ApiRoute[]> {
  const routes: ApiRoute[] = [];
  const appDir = join(root, 'app');
  if (!existsSync(appDir)) return routes;

  const files = await walk(appDir, (p) => p.endsWith('route.ts') || p.endsWith('route.js'));
  for (const file of files) {
    const content = safeRead(file);
    const relFile = relative(root, file);
    const lines = content.split('\n');
    const routePath = '/' + relative(join(root, 'app'), file)
      .replace(/\/route\.[tj]s$/, '')
      .replace(/\[(.+?)\]/g, ':$1')
      .replace(/\((.+?)\)\//g, '') || '/';

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

export async function detectApiFramework(root: string): Promise<Exclude<ApiFramework, 'auto'>> {
  const raw = safeRead(join(root, 'package.json'));
  if (raw) {
    try {
      const pkg = JSON.parse(raw);
      const all = { ...pkg.dependencies, ...pkg.devDependencies };
      if (all['next']) return 'nextjs';
      if (all['fastify']) return 'fastify';
      if (all['hono']) return 'hono';
      if (all['express']) return 'express';
    } catch {
      // ignore
    }
  }
  return 'express';
}

export async function inspectApi(root: string, framework: ApiFramework): Promise<ApiRoute[]> {
  const fw = framework === 'auto' ? await detectApiFramework(root) : framework;
  switch (fw) {
    case 'nextjs': {
      const app = await findNextjsAppRoutes(root);
      const pages = await findNextjsPagesRoutes(root);
      return [...app, ...pages];
    }
    case 'express':
      return findExpressRoutes(root);
    case 'fastify':
      return findFastifyRoutes(root);
    case 'hono':
      return findHonoRoutes(root);
    default:
      return findExpressRoutes(root);
  }
}

function parseModelFields(body: string): DbField[] {
  const fields: DbField[] = [];
  const FIELD_RE = /^\s*(\w+)\s+(\w+)(\[\])?([?!])?/;
  for (const line of body.split('\n')) {
    const m = FIELD_RE.exec(line.trim());
    if (!m) continue;
    const name = m[1];
    if (['@@', '@'].some((p) => name.startsWith(p))) continue;
    const type = m[2];
    const isOptional = m[4] === '?';
    const isRelation = /^[A-Z]/.test(type);
    fields.push({ name, type, isRelation, isOptional });
  }
  return fields;
}

export function parsePrismaSchema(content: string): DatabaseInfo {
  const models: DbModel[] = [];
  const enums: DbEnum[] = [];

  const MODEL_RE = /^model\s+(\w+)\s*\{([^}]*)\}/gm;
  let m: RegExpExecArray | null;
  while ((m = MODEL_RE.exec(content)) !== null) {
    models.push({ name: m[1], fields: parseModelFields(m[2]) });
  }

  const ENUM_RE = /^enum\s+(\w+)\s*\{([^}]*)\}/gm;
  while ((m = ENUM_RE.exec(content)) !== null) {
    const values = m[2]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//'))
      .filter((l) => /^\w+$/.test(l));
    enums.push({ name: m[1], values });
  }

  return { models, enums };
}

function normalizeScaffoldModuleName(moduleName: string): { kebab: string; pascal: string } {
  const parts = moduleName
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error('moduleName must include at least one alphanumeric segment');
  }
  const kebab = parts.map((part) => part.toLowerCase()).join('-');
  const pascal = parts
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).replace(/[^A-Za-z0-9]/g, '')}`)
    .join('');
  const identifier = /^[A-Za-z]/.test(pascal) ? pascal : `Module${pascal}`;
  return { kebab, pascal: identifier };
}

export function buildScaffold(
  moduleName: string,
  projectRoot: string,
  dryRun: boolean,
): ScaffoldPlan {
  const { kebab, pascal } = normalizeScaffoldModuleName(moduleName);

  const files: ScaffoldFile[] = [
    {
      path: `src/${kebab}/index.ts`,
      content: `export * from './${kebab}.ts';\nexport * from './types.ts';\n`,
    },
    {
      path: `src/${kebab}/types.ts`,
      content: `export interface ${pascal} {\n  id: string;\n}\n\nexport interface ${pascal}Input {\n    name: string;\n  // add more fields as needed\n}\n`,
    },
    {
      path: `src/${kebab}/${kebab}.ts`,
      content: `import type { ${pascal}, ${pascal}Input } from './types.ts';\n\nexport function create${pascal}(input: ${pascal}Input): ${pascal} {\n    // Simple implementation: generate a random id and spread input\n  return { id: crypto.randomUUID(), ...input };\n\n  throw new Error('Not implemented');\n}\n`,
    },
    {
      path: `src/${kebab}/${kebab}.test.ts`,
      content: `import { describe, test, expect } from 'bun:test';\nimport { create${pascal} } from './${kebab}.ts';\n\ndescribe('${pascal}', () => {\n  test('creates a ${pascal} object with id and input fields', () => {\n    const result = create${pascal}({ name: 'test' });\n    expect(result).toHaveProperty('id');\n    expect(result.name).toBe('test');\n  });\n});\n`,
    },
  ];

  if (!dryRun) {
    for (const f of files) {
      const absPath = resolvePath(projectRoot, f.path);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, f.content, 'utf-8');
    }
  }

  return { moduleName, dryRun, files };
}

function toOpenApiPath(path: string): { openApiPath: string; params: string[] } {
  const params: string[] = [];
  const openApiPath = path.replace(/:([\w]+)/g, (_, name) => {
    params.push(name);
    return `{${name}}`;
  });
  return { openApiPath, params };
}

export function generateApiSpec(routes: ApiRoute[], title = 'API', version = '1.0.0'): ApiSpec {
  const paths: ApiSpec['paths'] = {};

  for (const route of routes) {
    const { openApiPath, params } = toOpenApiPath(route.path);
    if (!paths[openApiPath]) paths[openApiPath] = {};

    const method = route.method.toLowerCase();
    if (method === 'any') {
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

export function validateApiSpec(specContent: string, routes: ApiRoute[]): ApiValidateResult {
  let specObj: Record<string, unknown>;
  try {
    specObj = JSON.parse(specContent);
  } catch {
    throw new Error('specPath must be a valid JSON OpenAPI spec file');
  }

  const specPaths = (specObj.paths ?? {}) as Record<string, Record<string, unknown>>;
  const specRouteMap = new Map<string, Set<string>>();
  for (const [rawPath, pathItem] of Object.entries(specPaths)) {
    const normalPath = rawPath.replace(/\{([^}]+)\}/g, ':$1');
    const methods = new Set(
      Object.keys(pathItem)
        .filter((k) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(k))
        .map((m) => m.toUpperCase()),
    );
    specRouteMap.set(normalPath, methods);
  }

  const codeRouteMap = new Map<string, Set<string>>();
  for (const route of routes) {
    const methods = codeRouteMap.get(route.path) ?? new Set<string>();
    if (route.method !== 'ANY') methods.add(route.method);
    codeRouteMap.set(route.path, methods);
  }

  const missing_from_spec: string[] = [];
  const missing_from_code: string[] = [];
  const mismatched_methods: ApiValidateResult['mismatched_methods'] = [];

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

function normalizeUrlForMatch(url: string): string {
  return url
    .replace(/\/:\w+/g, '/:p')
    .replace(/\/\{\w+\}/g, '/:p')
    .replace(/\/$/, '') || '/';
}

async function findFetchCalls(root: string): Promise<FetchCall[]> {
  const calls: FetchCall[] = [];
  const frontendDirs = ['src/app', 'src/pages', 'app', 'pages'].map((d) => join(root, d));
  const dirsToScan = frontendDirs.filter(existsSync);
  if (dirsToScan.length === 0) {
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

export async function inspectApiSync(root: string, framework: ApiFramework): Promise<ApiSyncResult> {
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

  const unmatched_routes = normalizedRoutes
    .filter((r) => !matchedRouteNorms.has(r._normalized))
    .map(({ _normalized: _, ...rest }) => rest);

  const drift_detected = unmatched_fetches.length > 0;

  return { fetch_calls: fetchCalls, unmatched_fetches, unmatched_routes, drift_detected };
}

