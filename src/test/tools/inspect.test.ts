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
