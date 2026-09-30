/**
 * End-to-end harness: the BUILT goodvibes binary in a real terminal.
 *
 * Every test here drives the compiled artifact (`bun run build:linux-x64`, or
 * GOODVIBES_E2E_BINARY), never the source. The terminal is a tmux server this
 * harness owns (a private `-L` socket per session, killed on stop), which gives
 * a real pty, keystrokes, resizes, the rendered screen (capture-pane) and the
 * raw byte stream the program wrote (pipe-pane, where OSC sequences survive).
 *
 * Isolation: a fresh temp home per session (HOME and GOODVIBES_HOME both point
 * at it), a scratch git workspace, a PATH with nothing extra, no desktop bus,
 * and the daemon port pinned to an unused port so the process can never adopt
 * a daemon the machine is already running. The model is a scripted
 * OpenAI-compatible server in this test process (startStubModel).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

const ARTIFACT_BY_PLATFORM: Record<string, string> = {
  'linux-x64': 'goodvibes-linux-x64',
  'linux-arm64': 'goodvibes-linux-arm64',
  'darwin-x64': 'goodvibes-macos-x64',
  'darwin-arm64': 'goodvibes-macos-arm64',
};

/** The compiled binary under test. Fails loudly when it has not been built. */
export function resolveBinary(): string {
  const fromEnv = process.env['GOODVIBES_E2E_BINARY'];
  const candidate = fromEnv
    ? resolve(fromEnv)
    : join(REPO_ROOT, 'dist', ARTIFACT_BY_PLATFORM[`${process.platform}-${process.arch}`] ?? 'goodvibes-linux-x64');
  if (!existsSync(candidate)) {
    throw new Error(`E2E: no built binary at ${candidate}. Run \`bun run build:linux-x64\` first, or set GOODVIBES_E2E_BINARY.`);
  }
  return candidate;
}

function tmuxAvailable(): boolean {
  return spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
}

/** A TCP port nothing is listening on right now. */
export async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

export async function waitFor<T>(
  what: string,
  probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 30_000,
  intervalMs = 150,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`E2E: timed out after ${timeoutMs}ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`);
}

// ── the scripted model ──────────────────────────────────────────────────────

export interface ChatMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly tool_calls?: unknown;
}

export interface ModelRequest {
  readonly messages: readonly ChatMessage[];
  readonly stream: boolean;
  readonly tools: readonly unknown[];
}

/** One scripted answer: plain text, or tool calls the TUI should run. */
export type ModelReply =
  | { readonly text: string }
  | { readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly arguments: Record<string, unknown> }> };

export interface StubModel {
  readonly baseURL: string;
  readonly requests: ModelRequest[];
  stop(): void;
}

/** Text of a message's content, whether a string or content parts. */
export function messageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join('');
  }
  return '';
}

/** The first user message of a request (an agent's task, or the prompt that opened a conversation). */
export function firstUserText(request: ModelRequest): string {
  const first = request.messages.find((message) => message.role === 'user');
  return first ? messageText(first) : '';
}

/** The system prompt(s) plus the first user message: where an agent's role is stated. */
export function openingText(request: ModelRequest): string {
  return request.messages.filter((m) => m.role === 'system').map(messageText).join('\n') + '\n' + firstUserText(request);
}

/** True once the request carries a tool result: the agent already acted and should now report. */
export function hasToolResult(request: ModelRequest): boolean {
  return request.messages.some((message) => message.role === 'tool');
}

/** Names of the tools a request offers. */
export function offeredTools(request: ModelRequest): string[] {
  return request.tools.map((tool) => String((tool as { function?: { name?: unknown } }).function?.name ?? ''));
}

/** The last user message of a request. */
export function lastUserText(request: ModelRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    if (request.messages[i]!.role === 'user') return messageText(request.messages[i]!);
  }
  return '';
}

/**
 * An OpenAI-compatible chat-completions server on an ephemeral port. `answer`
 * decides every reply from the request; it answers the stream shape the
 * request asked for.
 */
export function startStubModel(answer: (request: ModelRequest, index: number) => ModelReply): StubModel {
  const requests: ModelRequest[] = [];
  let callId = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/models')) {
        return Response.json({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] });
      }
      if (!url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
      const body = await req.json().catch(() => ({})) as { messages?: ChatMessage[]; stream?: boolean; tools?: unknown[] };
      const request: ModelRequest = { messages: body.messages ?? [], stream: body.stream === true, tools: body.tools ?? [] };
      const index = requests.length;
      requests.push(request);
      const reply = answer(request, index);
      const created = Math.floor(Date.now() / 1000);
      const toolCalls = 'toolCalls' in reply
        ? reply.toolCalls.map((call, i) => ({
          index: i,
          id: `call_${++callId}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        }))
        : undefined;
      const content = 'text' in reply ? reply.text : '';
      const finish = toolCalls ? 'tool_calls' : 'stop';
      const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
      if (request.stream) {
        const chunk = (delta: Record<string, unknown>, finishReason: string | null, extra: Record<string, unknown> = {}): string => `data: ${JSON.stringify({
          id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created, model: 'stub-model',
          choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra,
        })}\n\n`;
        const first = toolCalls ? { role: 'assistant', content: null, tool_calls: toolCalls } : { role: 'assistant', content };
        const payload = chunk(first, null) + chunk({}, finish, { usage }) + 'data: [DONE]\n\n';
        return new Response(payload, { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({
        id: 'chatcmpl-e2e', object: 'chat.completion', created, model: 'stub-model',
        choices: [{ index: 0, message: { role: 'assistant', content: toolCalls ? null : content, tool_calls: toolCalls }, finish_reason: finish }],
        usage,
      });
    },
  });
  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => { void server.stop(true); },
  };
}

// ── the isolated home ───────────────────────────────────────────────────────

export interface E2EHome {
  readonly root: string;
  readonly home: string;
  readonly workspace: string;
  readonly daemonPort: number;
  /** Write a settings key (dot path) into the TUI's own settings file. */
  setTuiSetting(key: string, value: unknown): void;
}

function setDotted(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (!next || typeof next !== 'object') node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

function mergeJson(path: string, key: string, value: unknown): void {
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {};
  setDotted(current, key, value);
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
}

/**
 * A fresh home with the scripted model registered as a custom provider and
 * selected, and the daemon port pinned to an unused port.
 */
export async function makeHome(model: StubModel): Promise<E2EHome> {
  const root = mkdtempSync(join(tmpdir(), 'gv-e2e-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const tuiDir = join(home, '.goodvibes', 'tui');
  const daemonDir = join(home, '.goodvibes', 'daemon');
  mkdirSync(join(tuiDir, 'providers'), { recursive: true });
  mkdirSync(daemonDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  // A git identity in the isolated home: WRFC lands passed work as a commit.
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = E2E Owner\n\temail = e2e@example.test\n[init]\n\tdefaultBranch = main\n');
  const git = (...args: string[]) => spawnSync('git', args, { cwd: workspace, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home } });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(workspace, 'README.md'), '# e2e workspace\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  writeFileSync(join(tuiDir, 'providers', 'e2e-stub.json'), JSON.stringify({
    name: 'e2e-stub',
    displayName: 'E2E Stub',
    type: 'openai-compat',
    baseURL: model.baseURL,
    apiKey: 'e2e-not-a-secret',
    models: [{
      id: 'stub-model',
      displayName: 'Stub Model',
      contextWindow: 64_000,
      capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    }],
  }, null, 2));

  const daemonPort = await freePort();
  const settingsPath = join(tuiDir, 'settings.json');
  const e2eHome: E2EHome = {
    root, home, workspace, daemonPort,
    setTuiSetting: (key, value) => mergeJson(settingsPath, key, value),
  };
  e2eHome.setTuiSetting('provider.model', 'e2e-stub:stub-model');
  mergeJson(join(daemonDir, 'settings.json'), 'controlPlane.port', daemonPort);
  mergeJson(join(daemonDir, 'settings.json'), 'controlPlane.host', '127.0.0.1');
  return e2eHome;
}

/** The environment the binary runs in: the isolated home and nothing ambient. */
export function isolatedEnv(e2eHome: E2EHome, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: e2eHome.home,
    GOODVIBES_HOME: e2eHome.home,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TMPDIR: join(e2eHome.root, 'tmp'),
    ...extra,
  };
}

// ── the terminal ────────────────────────────────────────────────────────────

let sessionCounter = 0;

export interface TuiSession {
  /** The rendered screen, one string per row. */
  screen(): string;
  /** Everything the program wrote to the terminal so far, escape sequences included. */
  rawOutput(): string;
  type(text: string): void;
  key(name: string): void;
  resize(cols: number, rows: number): void;
  waitForScreen(what: string, predicate: (screen: string) => boolean, timeoutMs?: number): Promise<string>;
  /** True while the binary is still running in the pane. */
  alive(): boolean;
  stop(): void;
}

/** Launch the built binary in a private tmux server at `cols` x `rows`. */
export function launchTui(e2eHome: E2EHome, options: { cols?: number; rows?: number; env?: Record<string, string> } = {}): TuiSession {
  if (!tmuxAvailable()) throw new Error('E2E: tmux is required (apt-get install tmux)');
  const binary = resolveBinary();
  mkdirSync(join(e2eHome.root, 'tmp'), { recursive: true });
  const socket = `gv-e2e-${process.pid}-${++sessionCounter}`;
  const rawPath = join(e2eHome.root, `${socket}.raw`);
  const stderrPath = join(e2eHome.root, `${socket}.stderr`);
  writeFileSync(rawPath, '');
  const env = isolatedEnv(e2eHome, options.env);
  const envArgs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', env: { PATH: env.PATH!, HOME: e2eHome.home, TMUX_TMPDIR: '/tmp' } });

  // `env -i` so nothing from this process (NODE_ENV=test, a desktop bus, real
  // credentials) reaches the binary; `exec` so the pane's process IS the binary.
  const command = ['exec', 'env', '-i', ...envArgs.map(shellQuote), shellQuote(binary), `2>${shellQuote(stderrPath)}`].join(' ');
  const started = tmux('new-session', '-d', '-s', 'main', '-x', String(options.cols ?? 100), '-y', String(options.rows ?? 30), '-c', e2eHome.workspace, command);
  if (started.status !== 0) throw new Error(`E2E: tmux new-session failed: ${started.stderr}`);
  tmux('set-option', '-t', 'main', 'remain-on-exit', 'on');
  tmux('pipe-pane', '-o', '-t', 'main', `cat >> ${shellQuote(rawPath)}`);

  const session: TuiSession = {
    screen: () => tmux('capture-pane', '-p', '-t', 'main').stdout,
    rawOutput: () => readFileSync(rawPath, 'utf8'),
    type: (text) => { tmux('send-keys', '-t', 'main', '-l', '--', text); },
    key: (name) => { tmux('send-keys', '-t', 'main', name); },
    resize: (cols, rows) => {
      const out = tmux('resize-window', '-t', 'main', '-x', String(cols), '-y', String(rows));
      if (out.status !== 0) throw new Error(`E2E: resize failed: ${out.stderr}`);
    },
    waitForScreen: async (what, predicate, timeoutMs = 30_000) => {
      try {
        return await waitFor(what, () => {
          const screen = session.screen();
          return predicate(screen) ? screen : false;
        }, timeoutMs);
      } catch (error) {
        const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8').slice(-2000) : '';
        throw new Error(`${String(error)}\n--- screen ---\n${session.screen()}\n--- stderr ---\n${stderr}`);
      }
    },
    alive: () => tmux('display-message', '-p', '-t', 'main', '#{pane_dead}').stdout.trim() === '0',
    stop: () => {
      tmux('kill-server');
      // kill-server can leave the socket file behind; it is this session's own.
      rmSync(join('/tmp', `tmux-${process.getuid?.() ?? 0}`, socket), { force: true });
    },
  };
  return session;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The input area is on screen: its placeholder text and the composer bars. */
export function inputAreaVisible(screen: string): boolean {
  return screen.includes('Ask anything, or type / for commands');
}

/** Words of the screen joined across wraps, for assertions on text that may wrap. */
export function screenText(screen: string): string {
  return screen.split('\n').map((line) => line.trim()).join(' ').replace(/\s+/g, ' ');
}
