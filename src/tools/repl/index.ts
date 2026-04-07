import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { configManager } from '../../config/index.ts';
import { getSandboxSessionRegistry } from '../../runtime/sandbox/session-registry.ts';
import { executeSandboxCommand } from '../../runtime/sandbox/backend.ts';
import type { SandboxLaunchPlan } from '../../runtime/sandbox/types.ts';
import type { Tool } from '../../types/tools.ts';
import { REPL_TOOL_SCHEMA, type ReplToolInput } from './schema.ts';

interface ReplHistoryEntry {
  readonly ts: number;
  readonly runtime: 'javascript' | 'typescript' | 'python' | 'sql' | 'graphql';
  readonly expression: string;
  readonly sessionId?: string;
  readonly backend?: string;
  readonly launchSummary?: string;
  readonly result?: string;
  readonly error?: string;
}

const HISTORY_PATH = join('.goodvibes', 'tui', 'repl-history.json');
const LOCAL_EXEC_PLAN: SandboxLaunchPlan = {
  backend: 'local',
  command: process.env.SHELL || 'bash',
  args: ['-lc', 'true'],
  workspaceRoot: process.cwd(),
  summary: 'local process exec',
};

function loadHistory(): ReplHistoryEntry[] {
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, 'utf-8')) as ReplHistoryEntry[];
  } catch {
    return [];
  }
}

function saveHistory(entries: readonly ReplHistoryEntry[]): void {
  mkdirSync(join('.goodvibes', 'tui'), { recursive: true });
  writeFileSync(HISTORY_PATH, `${JSON.stringify(entries, null, 2)}\n`, 'utf-8');
}

function mapRuntimeToSandboxProfile(runtime: NonNullable<ReplToolInput['runtime']>) {
  switch (runtime) {
    case 'javascript': return 'eval-js' as const;
    case 'typescript': return 'eval-ts' as const;
    case 'python': return 'eval-py' as const;
    case 'sql': return 'eval-sql' as const;
    case 'graphql': return 'eval-graphql' as const;
  }
}

async function evalJavaScript(expression: string, bindings: Record<string, unknown>): Promise<string> {
  return evalJavaScriptInSandbox(expression, bindings, LOCAL_EXEC_PLAN);
}

async function evalJavaScriptInSandbox(
  expression: string,
  bindings: Record<string, unknown>,
  launchPlan: SandboxLaunchPlan,
  sessionId?: string,
): Promise<string> {
  const payload = JSON.stringify({ expression, bindings });
  const runner = `
const payload = JSON.parse(process.env.GV_REPL_PAYLOAD ?? '{}');
const bindings = payload.bindings ?? {};
for (const [key, value] of Object.entries(bindings)) {
  globalThis[key] = value;
}
const value = eval(payload.expression);
process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
`;
  const result = sessionId
    ? getSandboxSessionRegistry().execute(sessionId, process.execPath, ['-e', runner], configManager, {
        timeoutMs: 1000,
        env: {
          ...process.env,
          GV_REPL_PAYLOAD: payload,
        },
      })
    : executeSandboxCommand(launchPlan, process.execPath, ['-e', runner], {
        timeoutMs: 1000,
        env: {
          ...process.env,
          GV_REPL_PAYLOAD: payload,
        },
      });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'JavaScript eval failed.').trim());
  }
  return result.stdout.trim();
}

async function evalTypeScript(
  expression: string,
  bindings: Record<string, unknown>,
  launchPlan: SandboxLaunchPlan = LOCAL_EXEC_PLAN,
  sessionId?: string,
): Promise<string> {
  const transpiled = ts.transpileModule(expression, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  }).outputText;
  return evalJavaScriptInSandbox(transpiled, bindings, launchPlan, sessionId);
}

function evalPython(expression: string, launchPlan: SandboxLaunchPlan = LOCAL_EXEC_PLAN, sessionId?: string): string {
  const tempRoot = mkdtempSync(join(tmpdir(), 'gv-repl-py-'));
  const venvPath = join(tempRoot, 'venv');
  const pythonLaunchPlan = launchPlan.backend === 'local' ? {
    ...LOCAL_EXEC_PLAN,
    workspaceRoot: tempRoot,
  } : launchPlan;
  const create = sessionId
    ? getSandboxSessionRegistry().execute(sessionId, 'python3', ['-m', 'venv', venvPath], configManager, { cwd: tempRoot })
    : executeSandboxCommand(pythonLaunchPlan, 'python3', ['-m', 'venv', venvPath], { cwd: tempRoot });
  if (create.status !== 0) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw new Error(create.stderr || create.stdout || 'Failed to create ephemeral Python venv.');
  }
  const pythonBin = join(venvPath, 'bin', 'python');
  const run = sessionId
    ? getSandboxSessionRegistry().execute(sessionId, pythonBin, ['-I', '-S', '-c', `import json\nresult = (${expression})\nprint(json.dumps(result))`], configManager, {
        cwd: tempRoot,
        timeoutMs: 5000,
      })
    : executeSandboxCommand(pythonLaunchPlan, pythonBin, ['-I', '-S', '-c', `import json\nresult = (${expression})\nprint(json.dumps(result))`], {
        cwd: tempRoot,
        timeoutMs: 5000,
      });
  rmSync(tempRoot, { recursive: true, force: true });
  if (run.status !== 0) {
    throw new Error((run.stderr || run.stdout || 'Python eval failed.').trim());
  }
  return run.stdout.trim();
}

async function evalSql(
  expression: string,
  launchPlan: SandboxLaunchPlan = LOCAL_EXEC_PLAN,
  sessionId?: string,
): Promise<string> {
  const payload = JSON.stringify({ expression });
  const script = `
import { Database } from 'bun:sqlite';
const payload = JSON.parse(process.env.GV_REPL_PAYLOAD ?? '{}');
const db = new Database(':memory:');
db.exec("CREATE TABLE sandbox_eval (id INTEGER PRIMARY KEY, value TEXT);");
db.exec("INSERT INTO sandbox_eval (value) VALUES ('alpha'), ('beta');");
const rows = db.query(payload.expression).all();
process.stdout.write(JSON.stringify(rows));
`;
  const result = sessionId
    ? getSandboxSessionRegistry().execute(sessionId, process.execPath, ['-e', script], configManager, {
        timeoutMs: 5000,
        env: {
          ...process.env,
          GV_REPL_PAYLOAD: payload,
        },
      })
    : executeSandboxCommand(launchPlan, process.execPath, ['-e', script], {
        timeoutMs: 5000,
        env: {
          ...process.env,
          GV_REPL_PAYLOAD: payload,
        },
      });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'SQL eval failed.').trim());
  }
  return result.stdout.trim();
}

function evalGraphql(expression: string, launchPlan: SandboxLaunchPlan = LOCAL_EXEC_PLAN, sessionId?: string): string {
  const payload = JSON.stringify({ expression });
  const script = `
const payload = JSON.parse(process.env.GV_REPL_PAYLOAD ?? '{}');
const normalized = String(payload.expression ?? '').replace(/\\s+/g, ' ').trim();
const opMatch = normalized.match(/^(query|mutation|subscription)\\s+([A-Za-z0-9_]+)?/i);
const fields = [...normalized.matchAll(/\\b([A-Za-z_][A-Za-z0-9_]*)\\b/g)].map((match) => match[1]).slice(0, 12);
process.stdout.write(JSON.stringify({
  operation: opMatch?.[1]?.toLowerCase() ?? 'query',
  name: opMatch?.[2] ?? null,
  fields,
  normalized,
}));
`;
  const result = sessionId
    ? getSandboxSessionRegistry().execute(sessionId, process.execPath, ['-e', script], configManager, {
        timeoutMs: 2000,
        env: {
          ...process.env,
          GV_REPL_PAYLOAD: payload,
        },
      })
    : executeSandboxCommand(launchPlan, process.execPath, ['-e', script], {
        timeoutMs: 2000,
        env: {
          ...process.env,
          GV_REPL_PAYLOAD: payload,
        },
      });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'GraphQL eval failed.').trim());
  }
  return result.stdout.trim();
}

export const replTool: Tool = {
  definition: {
    name: 'repl',
    description: 'Evaluate bounded JavaScript, TypeScript, Python, SQL, and GraphQL snippets through controlled sandbox profiles.',
    parameters: REPL_TOOL_SCHEMA.parameters,
    sideEffects: ['exec', 'state'],
    concurrency: 'serial',
  },

  async execute(args: Record<string, unknown>) {
    if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
      return { success: false, error: 'Invalid args: mode is required.' };
    }
    const input = args as unknown as ReplToolInput;
    const history = loadHistory();

    if (input.mode === 'history') {
      return { success: true, output: JSON.stringify({ count: history.length, history }) };
    }

    if (!input.expression) return { success: false, error: 'eval requires expression.' };
    const runtime = input.runtime ?? 'javascript';
    const sandboxSession = await getSandboxSessionRegistry().start(
      mapRuntimeToSandboxProfile(runtime),
      `repl:${runtime}`,
      configManager,
    );
    try {
      let rendered = '';
      switch (runtime) {
        case 'javascript':
          rendered = await evalJavaScriptInSandbox(input.expression, input.bindings ?? {}, sandboxSession.launchPlan ?? LOCAL_EXEC_PLAN, sandboxSession.id);
          break;
        case 'typescript':
          rendered = await evalTypeScript(input.expression, input.bindings ?? {}, sandboxSession.launchPlan ?? LOCAL_EXEC_PLAN, sandboxSession.id);
          break;
        case 'python':
          rendered = evalPython(input.expression, sandboxSession.launchPlan ?? LOCAL_EXEC_PLAN, sandboxSession.id);
          break;
        case 'sql':
          rendered = await evalSql(input.expression, sandboxSession.launchPlan ?? LOCAL_EXEC_PLAN, sandboxSession.id);
          break;
        case 'graphql':
          rendered = evalGraphql(input.expression, sandboxSession.launchPlan ?? LOCAL_EXEC_PLAN, sandboxSession.id);
          break;
      }
      saveHistory([...history, {
        ts: Date.now(),
        runtime,
        expression: input.expression,
        sessionId: sandboxSession.id,
        backend: sandboxSession.resolvedBackend ?? sandboxSession.backend,
        launchSummary: sandboxSession.launchPlan?.summary,
        result: rendered,
      }]);
      return { success: true, output: rendered };
    } catch (error) {
      saveHistory([...history, {
        ts: Date.now(),
        runtime,
        expression: input.expression,
        sessionId: sandboxSession.id,
        backend: sandboxSession.resolvedBackend ?? sandboxSession.backend,
        launchSummary: sandboxSession.launchPlan?.summary,
        error: String(error),
      }]);
      return { success: false, error: String(error) };
    }
  },
};
