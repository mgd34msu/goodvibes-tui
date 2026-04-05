/**
 * Test infrastructure: mock providers and filesystem utilities.
 */
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LLMProvider, ChatRequest, ChatResponse } from '../providers/interface.ts';
import type { ToolCall } from '../types/tools.ts';
import { ConfigManager } from '../config/manager.ts';

// ---------------------------------------------------------------------------
// Mock LLM Provider
// ---------------------------------------------------------------------------

export interface MockResponse {
  content: string;
  toolCalls?: ToolCall[];
}

/**
 * MockLLMProvider returns pre-programmed canned responses in order.
 * Useful for testing the orchestrator agent loop.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';
  readonly models = ['mock-model'];

  private responses: MockResponse[];
  private callIndex = 0;
  public callLog: ChatRequest[] = [];

  constructor(responses: MockResponse[] = [{ content: 'Hello from mock' }]) {
    this.responses = responses;
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    this.callLog.push(params);
    const resp = this.responses[this.callIndex] ?? this.responses[this.responses.length - 1];
    this.callIndex++;

    return {
      content: resp.content,
      toolCalls: resp.toolCalls ?? [],
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: (resp.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end',
    };
  }

  reset(): void {
    this.callIndex = 0;
    this.callLog = [];
  }
}

// ---------------------------------------------------------------------------
// Config test isolation
// ---------------------------------------------------------------------------

/**
 * Redirect ConfigManager's config file to a temp directory for the duration
 * of a test suite. Returns a cleanup function that restores the default path.
 *
 * Usage in a test file:
 *   const cleanup = await setupConfigTestMode();
 *   afterAll(cleanup);
 */
export async function setupConfigTestMode(): Promise<() => Promise<void>> {
  const { dir, cleanup } = await makeTempDir();
  ConfigManager.setTestMode(dir);
  return async () => {
    ConfigManager.setTestMode(undefined);
    await cleanup();
  };
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory and return its path.
 * Also returns an async cleanup function.
 */
export async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const tmpBase = join(process.cwd(), 'tmp');
  await mkdir(tmpBase, { recursive: true });
  const dir = await mkdtemp(join(tmpBase, 'gv-test-'));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Write a file into a temp directory and return the full path.
 */
export async function writeTempFile(dir: string, name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await Bun.write(path, content);
  return path;
}

// ---------------------------------------------------------------------------
// Line helpers for renderer tests
// ---------------------------------------------------------------------------

/**
 * Extract plain text string from a Line (Cell[]).
 * Joins all cell characters, trims trailing spaces.
 */
export function lineToString(line: import('../types/grid.ts').Line): string {
  return line.map((c) => c.char).join('').trimEnd();
}

/**
 * Extract plain text from an array of Lines.
 */
export function linesToText(lines: import('../types/grid.ts').Line[]): string[] {
  return lines.map(lineToString);
}
