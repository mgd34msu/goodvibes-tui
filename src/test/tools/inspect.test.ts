/**
 * Tests for the inspect tool.
 *
 * Temp directories are created inside the project root (.test-tmp/) because
 * the tool uses resolvePath which is root-relative. Each test suite creates
 * a realistic fixture and tears it down after.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { InspectTool } from '../../tools/inspect/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();

function makeTmpDir(): string {
  const base = join(PROJECT_ROOT, '.test-tmp');
  if (!existsSync(base)) mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, 'inspect-'));
}

function write(dir: string, relPath: string, content: string): void {
  const abs = join(dir, relPath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

async function exec(
  tool: InspectTool,
  args: Record<string, unknown>,
): Promise<{ success: boolean; output?: string; error?: string; data?: unknown }> {
  const result = await tool.execute(args);
  if (!result.success) return result;
  return { ...result, data: JSON.parse(result.output!) };
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let tool: InspectTool;
let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTmpDir();
  tool = new InspectTool();
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// project mode
// ---------------------------------------------------------------------------

describe('inspect — project mode', () => {
  test('detects Node.js project from package.json', async () => {
    write(tmpDir, 'package.json', JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      scripts: { build: 'tsc', start: 'node dist/index.js' },
      dependencies: { express: '^4.0.0', zod: '^3.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    }));

    const r = await exec(tool, { mode: 'project', projectRoot: tmpDir });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.type).toBe('nodejs');
    expect(d.name).toBe('my-app');
    expect(d.version).toBe('1.0.0');
    expect(d.dependencies).toBe(2);
    expect(d.devDependencies).toBe(1);
  });

  test('detects TypeScript from tsconfig.json', async () => {
    write(tmpDir, 'package.json', JSON.stringify({ name: 'ts-project' }));
    write(tmpDir, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }));

    const r = await exec(tool, { mode: 'project', projectRoot: tmpDir });
    expect(r.success).toBe(true);
    expect((r.data as any).hasTypeScript).toBe(true);
  });

  test('hasTypeScript is false without tsconfig.json', async () => {
    write(tmpDir, 'package.json', JSON.stringify({ name: 'plain-js' }));

    const r = await exec(tool, { mode: 'project', projectRoot: tmpDir });
    expect(r.success).toBe(true);
    expect((r.data as any).hasTypeScript).toBe(false);
  });

  test('returns scripts and dependency counts', async () => {
    write(tmpDir, 'package.json', JSON.stringify({
      name: 'app',
      scripts: { test: 'bun test', build: 'tsc', lint: 'eslint .' },
      dependencies: { a: '1', b: '2', c: '3' },
      devDependencies: { d: '1' },
    }));

    const r = await exec(tool, { mode: 'project', projectRoot: tmpDir });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(Object.keys(d.scripts)).toHaveLength(3);
    expect(d.dependencies).toBe(3);
    expect(d.devDependencies).toBe(1);
  });

  test('detects bun package manager from bun.lockb', async () => {
    write(tmpDir, 'package.json', JSON.stringify({ name: 'bun-app' }));
    write(tmpDir, 'bun.lockb', '');

    const r = await exec(tool, { mode: 'project', projectRoot: tmpDir });
    expect(r.success).toBe(true);
    expect((r.data as any).packageManager).toBe('bun');
  });

  test('detects monorepo from workspaces field', async () => {
    write(tmpDir, 'package.json', JSON.stringify({
      name: 'monorepo',
      workspaces: ['packages/*'],
    }));

    const r = await exec(tool, { mode: 'project', projectRoot: tmpDir });
    expect(r.success).toBe(true);
    expect((r.data as any).isMonorepo).toBe(true);
  });

  test('detects Rust project from Cargo.toml', async () => {
    write(tmpDir, 'Cargo.toml', '[package]\nname = "my-crate"');

    const r = await exec(tool, { mode: 'project', projectRoot: tmpDir });
    expect(r.success).toBe(true);
    expect((r.data as any).type).toBe('rust');
    expect((r.data as any).packageManager).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// api mode
// ---------------------------------------------------------------------------

describe('inspect — api mode', () => {
  test('finds Next.js App Router routes', async () => {
    // Create app/users/route.ts with GET and POST exports
    write(tmpDir, 'app/users/route.ts',
      'export async function GET(req: Request) {}\nexport async function POST(req: Request) {}\n');
    write(tmpDir, 'app/posts/[id]/route.ts',
      'export async function GET(req: Request) {}\nexport async function DELETE(req: Request) {}\n');

    const r = await exec(tool, { mode: 'api', projectRoot: tmpDir, framework: 'nextjs' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.routes.length).toBeGreaterThanOrEqual(4);

    const methods = d.routes.map((rt: any) => rt.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('DELETE');
  });

  test('finds Express routes', async () => {
    write(tmpDir, 'src/routes.ts',
      'app.get("/users", handler);\napp.post("/users", handler);\napp.delete("/users/:id", handler);\n');

    const r = await exec(tool, { mode: 'api', projectRoot: tmpDir, framework: 'express' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.routes.length).toBeGreaterThanOrEqual(3);

    const methods = d.routes.map((rt: any) => rt.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('DELETE');
  });

  test('finds Hono routes', async () => {
    write(tmpDir, 'src/app.ts',
      'app.get("/health", (c) => c.json({ ok: true }));\napp.post("/items", (c) => c.json({}));\n');

    const r = await exec(tool, { mode: 'api', projectRoot: tmpDir, framework: 'hono' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    const methods = d.routes.map((rt: any) => rt.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
  });

  test('auto-detects nextjs from package.json', async () => {
    write(tmpDir, 'package.json', JSON.stringify({ dependencies: { next: '^14.0.0' } }));
    write(tmpDir, 'app/api/health/route.ts', 'export function GET() {}\n');

    const r = await exec(tool, { mode: 'api', projectRoot: tmpDir, framework: 'auto' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.routes.some((rt: any) => rt.method === 'GET')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// database mode
// ---------------------------------------------------------------------------

describe('inspect — database mode', () => {
  const PRISMA_SCHEMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String?
  posts     Post[]
  createdAt DateTime @default(now())
}

model Post {
  id       String @id @default(cuid())
  title    String
  content  String?
  authorId String
  author   User   @relation(fields: [authorId], references: [id])
}

enum Role {
  ADMIN
  USER
  GUEST
}
`;

  test('parses Prisma schema models', async () => {
    write(tmpDir, 'prisma/schema.prisma', PRISMA_SCHEMA);

    const r = await exec(tool, { mode: 'database', projectRoot: tmpDir });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.models).toHaveLength(2);

    const modelNames = d.models.map((m: any) => m.name);
    expect(modelNames).toContain('User');
    expect(modelNames).toContain('Post');
  });

  test('parses model fields', async () => {
    write(tmpDir, 'prisma/schema.prisma', PRISMA_SCHEMA);

    const r = await exec(tool, { mode: 'database', projectRoot: tmpDir });
    const d = r.data as any;
    const user = d.models.find((m: any) => m.name === 'User');
    expect(user).toBeDefined();
    const fieldNames = user.fields.map((f: any) => f.name);
    expect(fieldNames).toContain('id');
    expect(fieldNames).toContain('email');
  });

  test('parses enum definitions', async () => {
    write(tmpDir, 'prisma/schema.prisma', PRISMA_SCHEMA);

    const r = await exec(tool, { mode: 'database', projectRoot: tmpDir });
    const d = r.data as any;
    expect(d.enums).toHaveLength(1);
    expect(d.enums[0].name).toBe('Role');
    expect(d.enums[0].values).toContain('ADMIN');
    expect(d.enums[0].values).toContain('USER');
  });

  test('returns error when schema not found', async () => {
    const r = await exec(tool, { mode: 'database', projectRoot: tmpDir });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  test('accepts custom schemaPath', async () => {
    write(tmpDir, 'db/schema.prisma', PRISMA_SCHEMA);

    const r = await exec(tool, {
      mode: 'database',
      projectRoot: tmpDir,
      schemaPath: join(tmpDir, 'db/schema.prisma'),
    });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.models.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// components mode
// ---------------------------------------------------------------------------

describe('inspect — components mode', () => {
  test('finds React function components', async () => {
    write(tmpDir, 'src/Button.tsx', [
      'import React from "react";',
      '',
      'export function Button({ label, onClick }: { label: string; onClick: () => void }) {',
      '  return <button onClick={onClick}>{label}</button>;',
      '}',
      '',
      'export function IconButton({ icon }: { icon: string }) {',
      '  return <button><span>{icon}</span></button>;',
      '}',
    ].join('\n'));

    const r = await exec(tool, {
      mode: 'components',
      projectRoot: tmpDir,
      file: 'src/Button.tsx',
    });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.count).toBeGreaterThanOrEqual(2);
    const names = d.components.map((c: any) => c.name);
    expect(names).toContain('Button');
    expect(names).toContain('IconButton');
  });

  test('detects arrow function components', async () => {
    write(tmpDir, 'src/Card.tsx', [
      'import React from "react";',
      'export const Card = ({ title }: { title: string }) => {',
      '  return <div>{title}</div>;',
      '};',
    ].join('\n'));

    const r = await exec(tool, {
      mode: 'components',
      projectRoot: tmpDir,
      file: 'src/Card.tsx',
    });
    expect(r.success).toBe(true);
    const d = r.data as any;
    const names = d.components.map((c: any) => c.name);
    expect(names).toContain('Card');
    const card = d.components.find((c: any) => c.name === 'Card');
    expect(card.kind).toBe('arrow');
  });

  test('returns error when file is missing', async () => {
    const r = await exec(tool, {
      mode: 'components',
      projectRoot: tmpDir,
      file: 'src/NonExistent.tsx',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  test('returns error when file param is omitted', async () => {
    const r = await exec(tool, { mode: 'components', projectRoot: tmpDir });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/file is required/i);
  });
});

// ---------------------------------------------------------------------------
// accessibility mode
// ---------------------------------------------------------------------------

describe('inspect — accessibility mode', () => {
  test('detects missing alt text on img', async () => {
    write(tmpDir, 'src/Page.tsx', [
      'export function Page() {',
      '  return (',
      '    <div>',
      '      <img src="/logo.png" />',
      '    </div>',
      '  );',
      '}',
    ].join('\n'));

    const r = await exec(tool, {
      mode: 'accessibility',
      projectRoot: tmpDir,
      file: 'src/Page.tsx',
    });
    expect(r.success).toBe(true);
    const d = r.data as any;
    const altIssues = d.issues.filter((i: any) => i.code === 'img-alt');
    expect(altIssues.length).toBeGreaterThanOrEqual(1);
    expect(altIssues[0].wcag).toContain('1.1.1');
  });

  test('does not flag img with alt attribute', async () => {
    write(tmpDir, 'src/GoodImg.tsx', [
      'export function GoodImg() {',
      '  return <img src="/logo.png" alt="Company logo" />;',
      '}',
    ].join('\n'));

    const r = await exec(tool, {
      mode: 'accessibility',
      projectRoot: tmpDir,
      file: 'src/GoodImg.tsx',
    });
    expect(r.success).toBe(true);
    const d = r.data as any;
    const altIssues = d.issues.filter((i: any) => i.code === 'img-alt');
    expect(altIssues.length).toBe(0);
  });

  test('detects onClick on div without role', async () => {
    write(tmpDir, 'src/ClickDiv.tsx', [
      'export function ClickDiv() {',
      '  return <div onClick={() => console.log("click")}>click me</div>;',
      '}',
    ].join('\n'));

    const r = await exec(tool, {
      mode: 'accessibility',
      projectRoot: tmpDir,
      file: 'src/ClickDiv.tsx',
    });
    expect(r.success).toBe(true);
    const d = r.data as any;
    const roleIssues = d.issues.filter((i: any) => i.code === 'click-events-have-key-events');
    expect(roleIssues.length).toBeGreaterThanOrEqual(1);
  });

  test('does not flag div with role attribute', async () => {
    write(tmpDir, 'src/RoleDiv.tsx', [
      'export function RoleDiv() {',
      '  return <div role="button" onClick={() => {}}>click me</div>;',
      '}',
    ].join('\n'));

    const r = await exec(tool, {
      mode: 'accessibility',
      projectRoot: tmpDir,
      file: 'src/RoleDiv.tsx',
    });
    expect(r.success).toBe(true);
    const d = r.data as any;
    const roleIssues = d.issues.filter((i: any) => i.code === 'click-events-have-key-events');
    expect(roleIssues.length).toBe(0);
  });

  test('returns error when file is missing', async () => {
    const r = await exec(tool, {
      mode: 'accessibility',
      projectRoot: tmpDir,
      file: 'src/NonExistent.tsx',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// layout mode
// ---------------------------------------------------------------------------

describe('inspect — layout mode', () => {
  test('extracts Tailwind flex and grid classes', async () => {
    write(tmpDir, 'src/Layout.tsx', [
      'export function Layout() {',
      '  return (',
      '    <div className="flex flex-row items-center justify-between gap-4 w-full h-screen overflow-hidden">',
      '      <aside className="grid grid-cols-3 gap-2 min-w-64">sidebar</aside>',
      '      <main className="flex-1 overflow-auto">main</main>',
      '    </div>',
      '  );',
      '}',
    ].join('\n'));

    const r = await exec(tool, {
      mode: 'layout',
      projectRoot: tmpDir,
      file: 'src/Layout.tsx',
    });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.displays).toContain('flex');
    expect(d.grid.some((g: string) => g.startsWith('grid-cols'))).toBe(true);
    expect(d.sizing.some((s: string) => s.startsWith('w-') || s.startsWith('h-'))).toBe(true);
    expect(d.overflow.some((o: string) => o.includes('overflow'))).toBe(true);
  });

  test('returns error when file is missing', async () => {
    const r = await exec(tool, {
      mode: 'layout',
      projectRoot: tmpDir,
      file: 'src/Missing.tsx',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// scaffold mode
// ---------------------------------------------------------------------------

describe('inspect — scaffold mode', () => {
  test('dry run returns file plan without writing', async () => {
    const r = await exec(tool, {
      mode: 'scaffold',
      projectRoot: tmpDir,
      moduleName: 'payment',
      dryRun: true,
    });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.dryRun).toBe(true);
    expect(d.files.length).toBe(4);
    const paths = d.files.map((f: any) => f.path);
    expect(paths.some((p: string) => p.includes('index.ts'))).toBe(true);
    expect(paths.some((p: string) => p.includes('types.ts'))).toBe(true);
    expect(paths.some((p: string) => p.includes('.test.ts'))).toBe(true);

    // Files should NOT exist on disk
    for (const f of d.files) {
      expect(existsSync(join(tmpDir, f.path))).toBe(false);
    }
  });

  test('non-dry-run creates files on disk', async () => {
    const r = await exec(tool, {
      mode: 'scaffold',
      projectRoot: tmpDir,
      moduleName: 'widget',
      dryRun: false,
    });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.dryRun).toBe(false);

    // All files should exist on disk
    for (const f of d.files) {
      expect(existsSync(join(tmpDir, f.path))).toBe(true);
    }
  });

  test('dryRun defaults to true when not specified', async () => {
    const r = await exec(tool, {
      mode: 'scaffold',
      projectRoot: tmpDir,
      moduleName: 'feature',
    });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.dryRun).toBe(true);

    // No files written
    for (const f of d.files) {
      expect(existsSync(join(tmpDir, f.path))).toBe(false);
    }
  });

  test('returns error when moduleName is missing', async () => {
    const r = await exec(tool, { mode: 'scaffold', projectRoot: tmpDir });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/moduleName is required/i);
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('inspect — error cases', () => {
  test('invalid mode returns error', async () => {
    const r = await exec(tool, { mode: 'invalid-mode' as any });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/invalid mode/i);
  });

  test('missing mode returns error', async () => {
    const r = await exec(tool, {});
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/mode is required/i);
  });
});

  describe('security', () => {
    test('rejects path traversal via relative path', async () => {
      const result = await tool.execute({ mode: 'database', projectRoot: tmpDir, schemaPath: '../../../../etc/passwd' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside the project root');
    });

    test('rejects absolute path outside project root', async () => {
      const result = await tool.execute({ mode: 'database', projectRoot: tmpDir, schemaPath: '/etc/passwd' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside the project root');
    });
  });

// ---------------------------------------------------------------------------
// api_spec mode
// ---------------------------------------------------------------------------

describe('inspect — api_spec mode', () => {
  test('generates OpenAPI 3.0 spec from Next.js routes', async () => {
    write(tmpDir, 'app/users/route.ts',
      'export async function GET(req: Request) {}\nexport async function POST(req: Request) {}\n');
    write(tmpDir, 'app/users/[id]/route.ts',
      'export async function GET(req: Request) {}\nexport async function DELETE(req: Request) {}\n');

    const r = await exec(tool, { mode: 'api_spec', projectRoot: tmpDir, framework: 'nextjs' });
    expect(r.success).toBe(true);
    const spec = r.data as any;
    expect(spec.openapi).toBe('3.0.0');
    expect(spec.info).toBeDefined();
    expect(spec.paths).toBeDefined();

    // /users path should have get and post
    expect(spec.paths['/users']).toBeDefined();
    expect(spec.paths['/users']['get']).toBeDefined();
    expect(spec.paths['/users']['post']).toBeDefined();
  });

  test('converts path params from :id to {id} in OpenAPI format', async () => {
    write(tmpDir, 'app/posts/[id]/route.ts',
      'export async function GET(req: Request) {}\n');

    const r = await exec(tool, { mode: 'api_spec', projectRoot: tmpDir, framework: 'nextjs' });
    expect(r.success).toBe(true);
    const spec = r.data as any;

    // Should have {id} path, not :id
    const pathKeys = Object.keys(spec.paths);
    const paramPath = pathKeys.find((k) => k.includes('{id}'));
    expect(paramPath).toBeDefined();

    // Parameter should be defined in the operation
    const op = spec.paths[paramPath!]['get'];
    expect(op.parameters).toBeDefined();
    expect(op.parameters.some((p: any) => p.name === 'id' && p.in === 'path' && p.required === true)).toBe(true);
  });

  test('includes operationId on each operation', async () => {
    write(tmpDir, 'app/items/route.ts',
      'export async function POST(req: Request) {}\n');

    const r = await exec(tool, { mode: 'api_spec', projectRoot: tmpDir, framework: 'nextjs' });
    expect(r.success).toBe(true);
    const spec = r.data as any;
    const op = spec.paths['/items']?.['post'];
    expect(op).toBeDefined();
    expect(typeof op.operationId).toBe('string');
    expect(op.operationId.length).toBeGreaterThan(0);
  });

  test('generates spec from Express routes', async () => {
    write(tmpDir, 'src/routes.ts',
      'app.get("/health", handler);\napp.post("/items", handler);\napp.delete("/items/:id", handler);\n');

    const r = await exec(tool, { mode: 'api_spec', projectRoot: tmpDir, framework: 'express' });
    expect(r.success).toBe(true);
    const spec = r.data as any;
    expect(spec.openapi).toBe('3.0.0');
    expect(Object.keys(spec.paths).length).toBeGreaterThanOrEqual(2);
  });

  test('returns empty paths for project with no routes', async () => {
    write(tmpDir, 'package.json', JSON.stringify({ name: 'empty-project' }));

    const r = await exec(tool, { mode: 'api_spec', projectRoot: tmpDir, framework: 'nextjs' });
    expect(r.success).toBe(true);
    const spec = r.data as any;
    expect(spec.paths).toBeDefined();
    expect(Object.keys(spec.paths)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// api_validate mode
// ---------------------------------------------------------------------------

describe('inspect — api_validate mode', () => {
  test('reports valid when spec matches code routes', async () => {
    write(tmpDir, 'app/users/route.ts',
      'export async function GET(req: Request) {}\nexport async function POST(req: Request) {}\n');

    const specJson = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'API', version: '1.0.0' },
      paths: {
        '/users': {
          get: { operationId: 'get_users', responses: { '200': { description: 'OK' } } },
          post: { operationId: 'post_users', responses: { '200': { description: 'OK' } } },
        },
      },
    });
    write(tmpDir, 'openapi.json', specJson);

    const r = await exec(tool, {
      mode: 'api_validate',
      projectRoot: tmpDir,
      framework: 'nextjs',
      specPath: join(tmpDir, 'openapi.json'),
    });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.valid).toBe(true);
    expect(d.missing_from_spec).toHaveLength(0);
    expect(d.missing_from_code).toHaveLength(0);
  });

  test('detects routes in code missing from spec', async () => {
    write(tmpDir, 'app/users/route.ts',
      'export async function GET(req: Request) {}\nexport async function POST(req: Request) {}\n');
    write(tmpDir, 'app/posts/route.ts',
      'export async function GET(req: Request) {}\n');

    const specJson = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'API', version: '1.0.0' },
      paths: {
        '/users': {
          get: { operationId: 'get_users', responses: { '200': { description: 'OK' } } },
          post: { operationId: 'post_users', responses: { '200': { description: 'OK' } } },
        },
        // /posts intentionally missing
      },
    });
    write(tmpDir, 'openapi.json', specJson);

    const r = await exec(tool, {
      mode: 'api_validate',
      projectRoot: tmpDir,
      framework: 'nextjs',
      specPath: join(tmpDir, 'openapi.json'),
    });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.valid).toBe(false);
    expect(d.missing_from_spec.some((s: string) => s.includes('/posts'))).toBe(true);
  });

  test('detects routes in spec missing from code', async () => {
    write(tmpDir, 'app/users/route.ts',
      'export async function GET(req: Request) {}\n');

    const specJson = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'API', version: '1.0.0' },
      paths: {
        '/users': {
          get: { operationId: 'get_users', responses: { '200': { description: 'OK' } } },
        },
        '/admin': {
          delete: { operationId: 'delete_admin', responses: { '200': { description: 'OK' } } },
        },
      },
    });
    write(tmpDir, 'openapi.json', specJson);

    const r = await exec(tool, {
      mode: 'api_validate',
      projectRoot: tmpDir,
      framework: 'nextjs',
      specPath: join(tmpDir, 'openapi.json'),
    });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.valid).toBe(false);
    expect(d.missing_from_code.some((s: string) => s.includes('/admin'))).toBe(true);
  });

  test('returns error when specPath is not provided', async () => {
    const r = await exec(tool, { mode: 'api_validate', projectRoot: tmpDir });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/specPath is required/i);
  });

  test('returns error when spec file does not exist', async () => {
    const r = await exec(tool, {
      mode: 'api_validate',
      projectRoot: tmpDir,
      specPath: join(tmpDir, 'nonexistent.json'),
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  test('rejects path traversal in specPath', async () => {
    const r = await tool.execute({
      mode: 'api_validate',
      projectRoot: tmpDir,
      specPath: '../../../../etc/passwd',
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('outside the project root');
  });
});

// ---------------------------------------------------------------------------
// api_sync mode
// ---------------------------------------------------------------------------

describe('inspect — api_sync mode', () => {
  test('detects no drift when fetch calls match routes', async () => {
    write(tmpDir, 'app/users/route.ts',
      'export async function GET(req: Request) {}\n');
    write(tmpDir, 'app/page.tsx',
      'export default function Page() {\n  fetch("/users");\n  return null;\n}\n');

    const r = await exec(tool, { mode: 'api_sync', projectRoot: tmpDir, framework: 'nextjs' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.fetch_calls.length).toBeGreaterThanOrEqual(1);
    expect(d.fetch_calls.some((fc: any) => fc.url === '/users')).toBe(true);
    expect(d.drift_detected).toBe(false);
  });

  test('detects drift when fetch calls reference unknown routes', async () => {
    write(tmpDir, 'app/users/route.ts',
      'export async function GET(req: Request) {}\n');
    write(tmpDir, 'app/page.tsx',
      'export default function Page() {\n  fetch("/users");\n  fetch("/nonexistent-endpoint");\n  return null;\n}\n');

    const r = await exec(tool, { mode: 'api_sync', projectRoot: tmpDir, framework: 'nextjs' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.drift_detected).toBe(true);
    expect(d.unmatched_fetches.some((fc: any) => fc.url === '/nonexistent-endpoint')).toBe(true);
  });

  test('extracts fetch calls with file and line number', async () => {
    write(tmpDir, 'app/users/route.ts',
      'export async function GET(req: Request) {}\n');
    write(tmpDir, 'app/dashboard/page.tsx',
      'export default function Dashboard() {\n  const data = fetch("/users");\n  return null;\n}\n');

    const r = await exec(tool, { mode: 'api_sync', projectRoot: tmpDir, framework: 'nextjs' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    const call = d.fetch_calls.find((fc: any) => fc.url === '/users');
    expect(call).toBeDefined();
    expect(typeof call.file).toBe('string');
    expect(typeof call.line).toBe('number');
    expect(call.line).toBeGreaterThan(0);
  });

  test('returns empty results for project with no fetch calls', async () => {
    write(tmpDir, 'app/users/route.ts',
      'export async function GET(req: Request) {}\n');
    write(tmpDir, 'app/page.tsx',
      'export default function Page() { return null; }\n');

    const r = await exec(tool, { mode: 'api_sync', projectRoot: tmpDir, framework: 'nextjs' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.fetch_calls).toHaveLength(0);
    expect(d.drift_detected).toBe(false);
  });

  test('result has required shape fields', async () => {
    const r = await exec(tool, { mode: 'api_sync', projectRoot: tmpDir, framework: 'nextjs' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(Array.isArray(d.fetch_calls)).toBe(true);
    expect(Array.isArray(d.unmatched_fetches)).toBe(true);
    expect(Array.isArray(d.unmatched_routes)).toBe(true);
    expect(typeof d.drift_detected).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// component_state mode
// ---------------------------------------------------------------------------

describe('inspect — component_state mode', () => {
  test('finds useState calls and names state variables', async () => {
    write(tmpDir, 'MyComp.tsx', [
      "import React, { useState } from 'react';",
      'function MyComp() {',
      '  const [count, setCount] = useState(0);',
      '  const [name, setName] = useState(\'\');',
      '  return <div>{count}</div>;',
      '}',
    ].join('\n'));

    const r = await exec(tool, { mode: 'component_state', projectRoot: tmpDir, file: 'MyComp.tsx' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.count).toBe(2);
    expect(d.stateVars[0].kind).toBe('useState');
    expect(d.stateVars[0].name).toBe('count');
    expect(d.stateVars[1].name).toBe('name');
  });

  test('finds useReducer and useContext calls', async () => {
    write(tmpDir, 'Comp2.tsx', [
      "import React, { useReducer, useContext } from 'react';",
      'function Comp2() {',
      '  const [state, dispatch] = useReducer(reducer, {});',
      '  const theme = useContext(ThemeContext);',
      '  return <div />;',
      '}',
    ].join('\n'));

    const r = await exec(tool, { mode: 'component_state', projectRoot: tmpDir, file: 'Comp2.tsx' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.stateVars.some((v: any) => v.kind === 'useReducer')).toBe(true);
    expect(d.stateVars.some((v: any) => v.kind === 'useContext')).toBe(true);
  });

  test('returns empty for file with no state hooks', async () => {
    write(tmpDir, 'NoState.tsx', 'function Pure() { return <div>hello</div>; }');
    const r = await exec(tool, { mode: 'component_state', projectRoot: tmpDir, file: 'NoState.tsx' });
    expect(r.success).toBe(true);
    expect((r.data as any).count).toBe(0);
  });

  test('returns error when file param is missing', async () => {
    const r = await tool.execute({ mode: 'component_state', projectRoot: tmpDir });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/file is required/);
  });
});

// ---------------------------------------------------------------------------
// render_triggers mode
// ---------------------------------------------------------------------------

describe('inspect — render_triggers mode', () => {
  test('finds state setters and effect/memo/callback hooks', async () => {
    write(tmpDir, 'Triggers.tsx', [
      "import { useState, useEffect, useMemo, useCallback, memo } from 'react';",
      'const Comp = memo(() => {',
      '  const [x, setX] = useState(0);',
      '  useEffect(() => {}, [x]);',
      '  const val = useMemo(() => x * 2, [x]);',
      '  const cb = useCallback(() => setX(1), []);',
      '  return <div>{val}</div>;',
      '});',
    ].join('\n'));

    const r = await exec(tool, { mode: 'render_triggers', projectRoot: tmpDir, file: 'Triggers.tsx' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.triggers.some((t: any) => t.kind === 'state_setter')).toBe(true);
    expect(d.triggers.some((t: any) => t.kind === 'effect_dep')).toBe(true);
    expect(d.triggers.some((t: any) => t.kind === 'memo_dep')).toBe(true);
    expect(d.triggers.some((t: any) => t.kind === 'callback_dep')).toBe(true);
    expect(d.triggers.some((t: any) => t.kind === 'memo_boundary')).toBe(true);
  });

  test('returns empty triggers for plain component', async () => {
    write(tmpDir, 'Plain.tsx', 'function Plain({ x }: { x: number }) { return <span>{x}</span>; }');
    const r = await exec(tool, { mode: 'render_triggers', projectRoot: tmpDir, file: 'Plain.tsx' });
    expect(r.success).toBe(true);
    expect((r.data as any).count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// hooks mode
// ---------------------------------------------------------------------------

describe('inspect — hooks mode', () => {
  test('detects useEffect with dependency array', async () => {
    write(tmpDir, 'Hooks.tsx', [
      "import { useEffect } from 'react';",
      'function Comp({ id }: { id: number }) {',
      '  useEffect(() => { console.log(id); }, [id]);',
      '}',
    ].join('\n'));

    const r = await exec(tool, { mode: 'hooks', projectRoot: tmpDir, file: 'Hooks.tsx' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.hooks.length).toBeGreaterThan(0);
    expect(d.hooks[0].hookKind).toBe('useEffect');
    expect(d.hooks[0].deps).toContain('id');
  });

  test('returns empty hooks for file without hooks', async () => {
    write(tmpDir, 'NoHooks.tsx', 'function Pure() { return null; }');
    const r = await exec(tool, { mode: 'hooks', projectRoot: tmpDir, file: 'NoHooks.tsx' });
    expect(r.success).toBe(true);
    expect((r.data as any).hooks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// overflow mode
// ---------------------------------------------------------------------------

describe('inspect — overflow mode', () => {
  test('flags overflow-hidden without height', async () => {
    write(tmpDir, 'Overflow.tsx', [
      'function Card() {',
      '  return <div className="overflow-hidden p-4">content</div>;',
      '}',
    ].join('\n'));

    const r = await exec(tool, { mode: 'overflow', projectRoot: tmpDir, file: 'Overflow.tsx' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.count).toBeGreaterThan(0);
    expect(d.issues[0].kind).toBe('hidden_clip');
  });

  test('no issues when overflow-hidden has height class', async () => {
    write(tmpDir, 'OverflowOk.tsx', [
      'function Card() {',
      '  return <div className="overflow-hidden h-64 p-4">content</div>;',
      '}',
    ].join('\n'));

    const r = await exec(tool, { mode: 'overflow', projectRoot: tmpDir, file: 'OverflowOk.tsx' });
    expect(r.success).toBe(true);
    expect((r.data as any).count).toBe(0);
  });

  test('flags overflow-scroll without height', async () => {
    write(tmpDir, 'OverflowScroll.tsx', 'function L() { return <div className="overflow-scroll">x</div>; }');
    const r = await exec(tool, { mode: 'overflow', projectRoot: tmpDir, file: 'OverflowScroll.tsx' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.issues[0].kind).toBe('scroll_no_height');
  });
});

// ---------------------------------------------------------------------------
// sizing mode
// ---------------------------------------------------------------------------

describe('inspect — sizing mode', () => {
  test('detects tailwind fixed, flex, percentage and viewport sizing', async () => {
    write(tmpDir, 'Sizing.tsx', [
      'function Layout() {',
      '  return (',
      '    <div className="w-full h-screen flex-1">',
      '      <aside className="w-64">side</aside>',
      '      <main className="w-1/2">main</main>',
      '    </div>',
      '  );',
      '}',
    ].join('\n'));

    const r = await exec(tool, { mode: 'sizing', projectRoot: tmpDir, file: 'Sizing.tsx' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.items.some((i: any) => i.kind === 'percentage')).toBe(true);
    expect(d.items.some((i: any) => i.kind === 'flex')).toBe(true);
    expect(d.items.some((i: any) => i.kind === 'viewport')).toBe(true);
  });

  test('returns empty items for plain component', async () => {
    write(tmpDir, 'NoSizing.tsx', 'function X() { return <span>hi</span>; }');
    const r = await exec(tool, { mode: 'sizing', projectRoot: tmpDir, file: 'NoSizing.tsx' });
    expect(r.success).toBe(true);
    expect((r.data as any).items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// stacking mode
// ---------------------------------------------------------------------------

describe('inspect — stacking mode', () => {
  test('finds tailwind z-index classes', async () => {
    write(tmpDir, 'Stacking.tsx', [
      'function Modal() {',
      '  return (',
      '    <div className="z-50 fixed inset-0">',
      '      <div className="z-10 relative">content</div>',
      '    </div>',
      '  );',
      '}',
    ].join('\n'));

    const r = await exec(tool, { mode: 'stacking', projectRoot: tmpDir, file: 'Stacking.tsx' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.zIndexItems.length).toBeGreaterThan(0);
    expect(d.zIndexItems.some((z: any) => z.value.includes('z-50') || z.value === 'z-50')).toBe(true);
  });

  test('returns empty for file with no z-index', async () => {
    write(tmpDir, 'NoStack.tsx', 'function P() { return <div>flat</div>; }');
    const r = await exec(tool, { mode: 'stacking', projectRoot: tmpDir, file: 'NoStack.tsx' });
    expect(r.success).toBe(true);
    expect((r.data as any).zIndexItems).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// responsive mode
// ---------------------------------------------------------------------------

describe('inspect — responsive mode', () => {
  test('finds Tailwind responsive breakpoint classes', async () => {
    write(tmpDir, 'Responsive.tsx', [
      'function Hero() {',
      '  return <div className="text-sm sm:text-lg md:text-xl lg:text-2xl xl:text-3xl">title</div>;',
      '}',
    ].join('\n'));

    const r = await exec(tool, { mode: 'responsive', projectRoot: tmpDir, file: 'Responsive.tsx' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.breakpoints.length).toBeGreaterThan(0);
    expect(d.hasMobileFirst).toBe(true);
    const prefixes = d.breakpoints.map((b: any) => b.prefix);
    expect(prefixes).toContain('sm');
    expect(prefixes).toContain('lg');
  });

  test('returns no breakpoints for non-responsive file', async () => {
    write(tmpDir, 'NoResp.tsx', 'function X() { return <div className="text-xl">x</div>; }');
    const r = await exec(tool, { mode: 'responsive', projectRoot: tmpDir, file: 'NoResp.tsx' });
    expect(r.success).toBe(true);
    expect((r.data as any).breakpoints).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// events mode
// ---------------------------------------------------------------------------

describe('inspect — events mode', () => {
  test('finds onClick and onChange event handlers', async () => {
    write(tmpDir, 'Events.tsx', [
      'function Form() {',
      '  return (',
      '    <form onSubmit={handleSubmit}>',
      '      <input onChange={handleChange} />',
      '      <button onClick={handleClick}>submit</button>',
      '    </form>',
      '  );',
      '}',
    ].join('\n'));

    const r = await exec(tool, { mode: 'events', projectRoot: tmpDir, file: 'Events.tsx' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.count).toBeGreaterThan(0);
    expect(d.handlers.some((h: any) => h.event.toLowerCase().includes('click'))).toBe(true);
  });

  test('returns empty for component with no event handlers', async () => {
    write(tmpDir, 'NoEvents.tsx', 'function Static() { return <div>static</div>; }');
    const r = await exec(tool, { mode: 'events', projectRoot: tmpDir, file: 'NoEvents.tsx' });
    expect(r.success).toBe(true);
    expect((r.data as any).count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// tailwind mode
// ---------------------------------------------------------------------------

describe('inspect — tailwind mode', () => {
  test('detects conflicting display classes on same element', async () => {
    write(tmpDir, 'TwConflict.tsx', [
      'function X() {',
      '  return <div className="block flex">content</div>;',
      '}',
    ].join('\n'));

    const r = await exec(tool, { mode: 'tailwind', projectRoot: tmpDir, file: 'TwConflict.tsx' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.count).toBeGreaterThan(0);
    expect(d.conflicts[0].reason).toMatch(/display/i);
  });

  test('no conflicts for well-formed className', async () => {
    write(tmpDir, 'TwOk.tsx', 'function X() { return <div className="flex items-center p-4 text-sm">ok</div>; }');
    const r = await exec(tool, { mode: 'tailwind', projectRoot: tmpDir, file: 'TwOk.tsx' });
    expect(r.success).toBe(true);
    expect((r.data as any).count).toBe(0);
  });

  test('detects conflicting font-size classes', async () => {
    write(tmpDir, 'TwFontConflict.tsx', 'function X() { return <p className="text-sm text-xl">hi</p>; }');
    const r = await exec(tool, { mode: 'tailwind', projectRoot: tmpDir, file: 'TwFontConflict.tsx' });
    expect(r.success).toBe(true);
    expect((r.data as any).count).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// client_boundary mode
// ---------------------------------------------------------------------------

describe('inspect — client_boundary mode', () => {
  test("detects 'use client' directive", async () => {
    write(tmpDir, 'Client.tsx', [
      "'use client';",
      "import { useState } from 'react';",
      'export function Comp() { return <div />; }',
    ].join('\n'));

    const r = await exec(tool, { mode: 'client_boundary', projectRoot: tmpDir, file: 'Client.tsx' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.directive).toBe('use client');
    expect(d.importsServerOnly).toBe(false);
  });

  test("detects 'use server' directive", async () => {
    write(tmpDir, 'Server.tsx', [
      "'use server';",
      "import { headers } from 'next/headers';",
      'export async function action() {}',
    ].join('\n'));

    const r = await exec(tool, { mode: 'client_boundary', projectRoot: tmpDir, file: 'Server.tsx' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.directive).toBe('use server');
    expect(d.importsServerOnly).toBe(true);
    expect(d.serverOnlyImports).toContain('next/headers');
  });

  test('returns null directive for plain component', async () => {
    write(tmpDir, 'Plain.tsx', "import React from 'react';\nexport function X() { return null; }");
    const r = await exec(tool, { mode: 'client_boundary', projectRoot: tmpDir, file: 'Plain.tsx' });
    expect(r.success).toBe(true);
    expect((r.data as any).directive).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// error_boundary mode
// ---------------------------------------------------------------------------

describe('inspect — error_boundary mode', () => {
  test('finds ErrorBoundary component usage', async () => {
    write(tmpDir, 'App.tsx', [
      "import { ErrorBoundary } from 'react-error-boundary';",
      'export function App() {',
      '  return (',
      '    <ErrorBoundary fallback={<div>error</div>}>',
      '      <Main />',
      '    </ErrorBoundary>',
      '  );',
      '}',
    ].join('\n'));

    const r = await exec(tool, { mode: 'error_boundary', projectRoot: tmpDir, file: 'App.tsx' });
    expect(r.success).toBe(true);
    const d = r.data as any;
    expect(d.hasErrorBoundary).toBe(true);
    expect(d.boundaryComponents.some((c: string) => c.includes('ErrorBoundary'))).toBe(true);
  });

  test('returns hasErrorBoundary false for plain component', async () => {
    write(tmpDir, 'NoEB.tsx', 'function X() { return <div>no boundary</div>; }');
    const r = await exec(tool, { mode: 'error_boundary', projectRoot: tmpDir, file: 'NoEB.tsx' });
    expect(r.success).toBe(true);
    expect((r.data as any).hasErrorBoundary).toBe(false);
  });
});
