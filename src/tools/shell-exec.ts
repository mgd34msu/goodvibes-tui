import type { Tool, ToolDefinition, ToolResult } from '../types/tools.ts';
import { ToolError } from '../types/errors.ts';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * ShellExecTool - Execute a shell command, capturing stdout/stderr/exitCode.
 * Permission category: execute (prompt user).
 */
export class ShellExecTool implements Tool {
  readonly definition: ToolDefinition = {
    name: 'shell_exec',
    description:
      'Execute a shell command. Captures stdout, stderr, and exit code. ' +
      'Times out after the specified duration (default 30s).',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command. Defaults to current directory.',
        },
        timeout: {
          type: 'integer',
          description: 'Timeout in milliseconds. Defaults to 30000.',
        },
      },
      required: ['command'],
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const command = args['command'];
    if (typeof command !== 'string' || !command) {
      return { callId: '', success: false, error: 'Missing required argument: command' };
    }

    const cwd = typeof args['cwd'] === 'string' ? args['cwd'] : process.cwd();
    const timeout =
      typeof args['timeout'] === 'number' ? args['timeout'] : DEFAULT_TIMEOUT_MS;

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(['sh', '-c', command], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (err) {
      throw new ToolError(
        `Failed to spawn process: ${err instanceof Error ? err.message : String(err)}`,
        'shell_exec',
      );
    }

    // Race between process completion and timeout
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Command timed out after ${timeout}ms`)), timeout),
    );

    try {
      const [stdout, stderr, exitCode] = await Promise.race([
        Promise.all([
          new Response(proc.stdout as ReadableStream).text(),
          new Response(proc.stderr as ReadableStream).text(),
          proc.exited,
        ]),
        timeoutPromise,
      ]);

      const output = [
        `Exit code: ${exitCode}`,
        stdout ? `--- stdout ---\n${stdout.trimEnd()}` : '',
        stderr ? `--- stderr ---\n${stderr.trimEnd()}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      return { callId: '', success: exitCode === 0, output };
    } catch (err) {
      // Kill on timeout
      try { proc.kill(); } catch { /* ignore */ }
      const message = err instanceof Error ? err.message : String(err);
      return { callId: '', success: false, error: message };
    }
  }
}
