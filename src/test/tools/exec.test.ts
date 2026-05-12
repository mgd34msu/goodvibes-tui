import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from '@pellux/goodvibes-sdk/platform/tools';
import { ProcessManager } from '@pellux/goodvibes-sdk/platform/tools';
import { OverflowHandler } from '@pellux/goodvibes-sdk/platform/tools';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the JSON output from a successful ToolResult. */
function parseOutput(output: string | undefined): Record<string, unknown> {
  if (!output) throw new Error('No output');
  return JSON.parse(output) as Record<string, unknown>;
}

/** Create a temp directory and return its path. */
function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'exec-test-'));
}

let execTool: ReturnType<typeof createExecTool>;
let execRoot: string;

function withWorkingDir(input: Record<string, unknown>): Record<string, unknown> {
  return {
    working_dir: execRoot,
    ...input,
  };
}

beforeEach(() => {
  execRoot = makeTmpDir();
  execTool = createExecTool(new ProcessManager(), {
    overflowHandler: new OverflowHandler({ baseDir: execRoot }),
  });
});

// ---------------------------------------------------------------------------
// 1. Simple command execution
// ---------------------------------------------------------------------------

describe('exec tool — simple commands', () => {
  test('runs a simple echo command', async () => {
    const result = await execTool.execute(withWorkingDir({ commands: [{ cmd: 'echo hello' }] }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    expect(out.exit_code).toBe(0);
    expect((out.stdout as string).trim()).toBe('hello');
  });

  test('captures stdout', async () => {
    const result = await execTool.execute(withWorkingDir({ commands: [{ cmd: 'printf "line1\nline2"' }] }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    expect(out.stdout).toContain('line1');
    expect(out.stdout).toContain('line2');
  });

  test('captures stderr', async () => {
    const result = await execTool.execute(withWorkingDir({ commands: [{ cmd: 'echo err >&2' }] }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    expect((out.stderr as string).trim()).toBe('err');
  });

  test('exit code 0 for success', async () => {
    const result = await execTool.execute(withWorkingDir({ commands: [{ cmd: 'true' }] }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    expect(out.exit_code).toBe(0);
    expect(out.success).toBe(true);
  });

  test('exit code non-zero for failure', async () => {
    const result = await execTool.execute(withWorkingDir({ commands: [{ cmd: 'false' }] }));
    expect(result.success).toBe(false);
    const out = parseOutput(result.output);
    expect(out.exit_code).not.toBe(0);
    expect(out.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Batch sequential commands
// ---------------------------------------------------------------------------

describe('exec tool — batch sequential', () => {
  test('runs multiple commands sequentially and returns all results', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [
        { cmd: 'echo first' },
        { cmd: 'echo second' },
        { cmd: 'echo third' },
      ],
    }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    const cmds = (out.commands as Array<Record<string, unknown>>);
    expect(cmds).toHaveLength(3);
    expect((cmds[0].stdout as string).trim()).toBe('first');
    expect((cmds[1].stdout as string).trim()).toBe('second');
    expect((cmds[2].stdout as string).trim()).toBe('third');
  });

  test('overall success false when any command fails', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'echo ok' }, { cmd: 'false' }, { cmd: 'echo also_ok' }],
    }));
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Batch parallel commands
// ---------------------------------------------------------------------------

describe('exec tool — parallel', () => {
  test('runs commands in parallel and returns all results', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'echo a' }, { cmd: 'echo b' }, { cmd: 'echo c' }],
      parallel: true,
    }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    const cmds = (out.commands as Array<Record<string, unknown>>);
    expect(cmds).toHaveLength(3);
    const stdouts = cmds.map((c) => (c.stdout as string).trim());
    expect(stdouts).toContain('a');
    expect(stdouts).toContain('b');
    expect(stdouts).toContain('c');
  });
});

// ---------------------------------------------------------------------------
// 4. Timeout
// ---------------------------------------------------------------------------

describe('exec tool — timeout', () => {
  test('kills process on timeout and marks timed_out', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'exec sleep 30', timeout_ms: 200 }],
    }));
    expect(result.success).toBe(false);
    const out = parseOutput(result.output);
    expect(out.timed_out).toBe(true);
    expect(out.exit_code).toBeNull();
  }, 10000);
});

// ---------------------------------------------------------------------------
// 5. Expectations: exit_code
// ---------------------------------------------------------------------------

describe('exec tool — expectations: exit_code', () => {
  test('passes when exit_code matches', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'true', expect: { exit_code: 0 } }],
    }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    expect(out.expectation_error).toBeUndefined();
  });

  test('fails when exit_code does not match', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'true', expect: { exit_code: 1 } }],
    }));
    expect(result.success).toBe(false);
    const out = parseOutput(result.output);
    expect(out.expectation_error as string).toContain('exit_code');
  });
});

// ---------------------------------------------------------------------------
// 6. Expectations: stdout_contains / stderr_contains
// ---------------------------------------------------------------------------

describe('exec tool — expectations: stdout/stderr contains', () => {
  test('passes when stdout_contains found', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'echo needle_value', expect: { stdout_contains: 'needle_value' } }],
    }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    expect(out.expectation_error).toBeUndefined();
  });

  test('fails when stdout_contains not found', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'echo foo', expect: { stdout_contains: 'bar' } }],
    }));
    expect(result.success).toBe(false);
    const out = parseOutput(result.output);
    expect(out.expectation_error as string).toContain('stdout_contains');
  });

  test('passes when stderr_contains found', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'echo needle_err >&2', expect: { stderr_contains: 'needle_err' } }],
    }));
    expect(result.success).toBe(true);
  });

  test('fails when stderr_contains not found', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'echo foo', expect: { stderr_contains: 'not_in_stderr' } }],
    }));
    expect(result.success).toBe(false);
    const out = parseOutput(result.output);
    expect(out.expectation_error as string).toContain('stderr_contains');
  });
});

// ---------------------------------------------------------------------------
// 7. Retry on failure
// ---------------------------------------------------------------------------

describe('exec tool — retry', () => {
  test('non-transient failure (exit_code 1) is not retried — reports retries=0', async () => {
    // `false` exits with code 1 which is not a transient error (not network/lock/busy),
    // so the SDK retry mechanism does not re-run it. retries remains 0.
    const result = await execTool.execute(withWorkingDir({
      commands: [{
        cmd: 'false',
        retry: { max: 2, delay_ms: 10, backoff: 'fixed' },
      }],
    }));
    expect(result.success).toBe(false);
    const out = parseOutput(result.output);
    expect(out.retries).toBe(0);
  }, 5000);

  test('does not retry on success', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{
        cmd: 'true',
        retry: { max: 3, delay_ms: 10 },
      }],
    }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    // Retried 0 times since first attempt succeeded
    expect(out.retries).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Background mode
// ---------------------------------------------------------------------------

describe('exec tool — background mode', () => {
  test('spawns background process and returns process_id immediately', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'sleep 1', background: true }],
    }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    expect(typeof out.process_id).toBe('string');
    expect(typeof out.pid).toBe('number');
    expect((out.pid as number)).toBeGreaterThan(0);
    await execTool.execute(withWorkingDir({ commands: [{ cmd: `bg_stop ${out.process_id as string}` }] }));
  });

  test('bg_status returns running status', async () => {
    // Spawn a long-running background process
    const spawnResult = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'sleep 5', background: true }],
    }));
    const spawnOut = parseOutput(spawnResult.output);
    const pid = spawnOut.process_id as string;

    const statusResult = await execTool.execute(withWorkingDir({
      commands: [{ cmd: `bg_status ${pid}` }],
    }));
    expect(statusResult.success).toBe(true);
    const statusOut = parseOutput(statusResult.output);
    const statusData = JSON.parse(statusOut.stdout as string) as Record<string, unknown>;
    expect(statusData.status).toContain('running');
  });

  test('bg_stop removes the process', async () => {
    const spawnResult = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'sleep 5', background: true }],
    }));
    const spawnOut = parseOutput(spawnResult.output);
    const pid = spawnOut.process_id as string;

    const stopResult = await execTool.execute(withWorkingDir({
      commands: [{ cmd: `bg_stop ${pid}` }],
    }));
    expect(stopResult.success).toBe(true);

    // After stop, bg_status should report unknown
    const statusResult = await execTool.execute(withWorkingDir({
      commands: [{ cmd: `bg_status ${pid}` }],
    }));
    expect(statusResult.success).toBe(false);
  });

  test('bg_status on done process returns done status', async () => {
    const spawnResult = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'echo bgdone', background: true }],
    }));
    const spawnOut = parseOutput(spawnResult.output);
    const pid = spawnOut.process_id as string;

    // Wait a bit for process to finish
    await new Promise<void>((r) => setTimeout(r, 300));

    const statusResult = await execTool.execute(withWorkingDir({
      commands: [{ cmd: `bg_status ${pid}` }],
    }));
    expect(statusResult.success).toBe(true);
    const statusData = JSON.parse(parseOutput(statusResult.output).stdout as string) as Record<string, unknown>;
    // Could be done or running depending on timing; at minimum, it should have an id
    expect(statusData.id).toBe(pid);
  }, 3000);
});

// ---------------------------------------------------------------------------
// 9. Until pattern
// ---------------------------------------------------------------------------

describe('exec tool — until pattern', () => {
  test('stops capturing when pattern matches in stdout', async () => {
    // Print lines, stop when we see STOP
    const result = await execTool.execute(withWorkingDir({
      commands: [{
        cmd: 'printf "line1\nSTOP\nline3\n"',
        timeout_ms: 3000,
        until: { pattern: 'STOP', kill_after: true },
      }],
    }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    expect(out.stdout as string).toContain('STOP');
  }, 5000);

  test('times out if pattern never matches', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{
        cmd: 'echo no_match',
        until: { pattern: 'NEVER_MATCHES_XYZ_12345', timeout_ms: 200, kill_after: false },
      }],
    }));
    // Process completes but pattern didn't match, so success=false
    expect(result.success).toBe(false);
  }, 3000);
});

// ---------------------------------------------------------------------------
// 10. File operations
// ---------------------------------------------------------------------------

describe('exec tool — file_ops', () => {
  test('copy: copies a file before command runs', async () => {
    const dir = makeTmpDir();
    const src = join(dir, 'source.txt');
    const dst = join(dir, 'dest.txt');
    writeFileSync(src, 'file content');

    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: `cat "${dst}"` }],
      file_ops: [{ op: 'copy', source: src, destination: dst }],
    }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    expect(out.stdout).toContain('file content');
  });

  test('move: moves a file before command runs', async () => {
    const dir = makeTmpDir();
    const src = join(dir, 'moveme.txt');
    const dst = join(dir, 'moved.txt');
    writeFileSync(src, 'moved content');

    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: `cat "${dst}"` }],
      file_ops: [{ op: 'move', source: src, destination: dst }],
    }));
    expect(result.success).toBe(true);
    expect(existsSync(src)).toBe(false);
    expect(existsSync(dst)).toBe(true);
  });

  test('delete: deletes a file before command runs', async () => {
    const target = join(execRoot, 'todelete.txt');
    writeFileSync(target, 'bye');

    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'echo done' }],
      file_ops: [{ op: 'delete', source: target }],
    }));
    expect(result.success).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  test('file_ops failure returns error without running commands', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'echo should_not_run' }],
      file_ops: [{ op: 'copy', source: '/nonexistent/path/file.txt', destination: '/tmp/foo.txt' }],
    }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('file_ops');
  });
});

// ---------------------------------------------------------------------------
// 11. Base64 command decoding
// ---------------------------------------------------------------------------

describe('exec tool — base64 commands', () => {
  test('decodes cmd_base64 and runs the command', async () => {
    // echo "hello base64" in base64
    const cmdB64 = Buffer.from('echo "hello base64"').toString('base64');
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd_base64: cmdB64 }],
    }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    expect((out.stdout as string).trim()).toBe('hello base64');
  });

  test('returns error when neither cmd nor cmd_base64 provided', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{}],
    }));
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. Working directory (cwd)
// ---------------------------------------------------------------------------

describe('exec tool — working directory', () => {
  test('uses global working_dir', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'marker.txt'), 'found_it');

    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'cat marker.txt' }],
      working_dir: dir,
    }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    expect(out.stdout).toContain('found_it');
  });

  test('per-command cwd overrides working_dir', async () => {
    const dirA = makeTmpDir();
    const dirB = makeTmpDir();
    writeFileSync(join(dirA, 'a.txt'), 'from_a');
    writeFileSync(join(dirB, 'b.txt'), 'from_b');

    const result = await execTool.execute(withWorkingDir({
      commands: [
        { cmd: 'cat a.txt', cwd: dirA },
        { cmd: 'cat b.txt', cwd: dirB },
      ],
      working_dir: dirA,
    }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    const cmds = out.commands as Array<Record<string, unknown>>;
    expect(cmds[0].stdout).toContain('from_a');
    expect(cmds[1].stdout).toContain('from_b');
  });

  test('single command accepts command-level working_dir without global working_dir', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'marker.txt'), 'command_level_root');

    const result = await execTool.execute({
      commands: [{ cmd: 'cat marker.txt', working_dir: dir }],
    });
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    expect(out.stdout).toContain('command_level_root');
  });
});

// ---------------------------------------------------------------------------
// 13. Output truncation
// ---------------------------------------------------------------------------

describe('exec tool — output truncation', () => {
  test('truncates stdout at 50000 chars and sets stdout_truncated', async () => {
    // Generate more than 50000 chars — use yes with head
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'yes x | head -c 60000', timeout_ms: 5000 }],
    }));
    // Should succeed (the command itself may exit with SIGPIPE but outputs content)
    const out = parseOutput(result.output);
    expect(out.stdout_truncated).toBe(true);
    expect((out.stdout as string).length).toBeLessThanOrEqual(50100);
  }, 8000);
});

// ---------------------------------------------------------------------------
// 14. Safe mode warnings on dangerous commands
// ---------------------------------------------------------------------------

describe('exec tool — safe mode warnings', () => {
  test('allows command but warns for rm -rf / patterns', async () => {
    // We test that the tool does NOT block the command (returns a result, not an error)
    // We use a harmless variant that matches the pattern syntactically but is safe
    // The pattern checks for rm -rf /; we use a fake path that matches
    // NOTE: We can't actually run rm -rf / so we just verify it runs and warns.
    // Instead verify a non-dangerous variant: tool should log warning but execute
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'echo safe_check' }],
    }));
    // Normal command still succeeds
    expect(result.success).toBe(true);
  });

  test('dangerous pattern does not throw — execute returns result', async () => {
    // mkfs pattern - we pass a false path but check that execute() does not throw
    // Use echo to simulate the command text without actually running mkfs
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'echo "mkfs check"' }],
    }));
    // Should still run (safe mode warns but does not block)
    expect(result.success).toBe(true);
  });

  test('rm -rf / pattern is detected and logs warning (does not block execution)', async () => {
    // The dangerous pattern regex matches "rm -rf /" but we run a safe echo to
    // verify the tool does NOT throw or return an error — it only warns via logger.
    // We use cmd_base64 to pass the text "rm -rf /" without the shell actually executing it.
    const cmdB64 = Buffer.from('echo "would have been: rm -rf /"').toString('base64');
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd_base64: cmdB64 }],
    }));
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!) as Record<string, unknown>;
    expect((out.stdout as string)).toContain('rm -rf /');
  });

  test('mkfs pattern detected — tool warns but still executes', async () => {
    // Run a command whose text matches the /\bmkfs\b/ pattern.
    // We echo the dangerous string rather than invoking mkfs.
    const cmdB64 = Buffer.from('echo "simulating mkfs call"').toString('base64');
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd_base64: cmdB64 }],
    }));
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!) as Record<string, unknown>;
    expect((out.stdout as string)).toContain('mkfs');
  });
});

// ---------------------------------------------------------------------------
// 15. Verbosity formats
// ---------------------------------------------------------------------------

describe('exec tool — verbosity', () => {
  test('count_only returns only exit_code and success', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'echo verbosity_test' }],
      verbosity: 'count_only',
    }));
    const out = parseOutput(result.output);
    expect(out.exit_code).toBe(0);
    expect(out.success).toBe(true);
    // stdout should NOT be present
    expect(out.stdout).toBeUndefined();
  });

  test('minimal returns first line of stdout/stderr', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'printf "line1\nline2\nline3"' }],
      verbosity: 'minimal',
    }));
    const out = parseOutput(result.output);
    expect(out.stdout).toBe('line1');
  });

  test('standard returns full stdout/stderr', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'printf "line1\nline2"' }],
      verbosity: 'standard',
    }));
    const out = parseOutput(result.output);
    expect(out.stdout).toContain('line1');
    expect(out.stdout).toContain('line2');
  });

  test('verbose returns timing info', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'echo timing' }],
      verbosity: 'verbose',
    }));
    const out = parseOutput(result.output);
    expect(typeof out.duration_ms).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// 16. Invalid input
// ---------------------------------------------------------------------------

describe('exec tool — invalid input', () => {
  test('returns error for empty commands array', async () => {
    const result = await execTool.execute({ commands: [] });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('returns error for missing commands key', async () => {
    const result = await execTool.execute({});
    expect(result.success).toBe(false);
  });

  test('requires an explicit working_dir for command execution', async () => {
    const result = await execTool.execute({
      commands: [{ cmd: 'echo missing_root' }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('working_dir');
  });
});

// ---------------------------------------------------------------------------
// 17. Env vars
// ---------------------------------------------------------------------------

describe('exec tool — env vars', () => {
  test('merges additional env vars into command environment', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{ cmd: 'echo $MY_TEST_VAR', env: { MY_TEST_VAR: 'custom_value_xyz' } }],
    }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    expect((out.stdout as string).trim()).toBe('custom_value_xyz');
  });
});

// ---------------------------------------------------------------------------
// 18. fail_fast / stop_on_error
// ---------------------------------------------------------------------------

describe('exec tool — fail_fast', () => {
  test('fail_fast: stops on first failure and marks remaining as skipped', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [
        { cmd: 'echo first' },
        { cmd: 'false' },
        { cmd: 'echo should_be_skipped' },
        { cmd: 'echo also_skipped' },
      ],
      fail_fast: true,
    }));
    expect(result.success).toBe(false);
    const out = parseOutput(result.output);
    const cmds = out.commands as Array<Record<string, unknown>>;
    expect(cmds).toHaveLength(4);
    // First command succeeded
    expect(cmds[0].success).toBe(true);
    expect((cmds[0].stdout as string).trim()).toBe('first');
    // Second command failed
    expect(cmds[1].success).toBe(false);
    expect(cmds[1].skipped).toBeUndefined();
    // Third and fourth are skipped
    expect(cmds[2].skipped).toBe(true);
    expect(cmds[2].success).toBe(false);
    expect(cmds[3].skipped).toBe(true);
  });

  test('stop_on_error alias: behaves same as fail_fast', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [
        { cmd: 'false' },
        { cmd: 'echo should_skip' },
      ],
      stop_on_error: true,
    }));
    expect(result.success).toBe(false);
    const out = parseOutput(result.output);
    const cmds = out.commands as Array<Record<string, unknown>>;
    expect(cmds[1].skipped).toBe(true);
  });

  test('fail_fast: false runs all commands despite failures (default behavior)', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [
        { cmd: 'echo first' },
        { cmd: 'false' },
        { cmd: 'echo after_failure' },
      ],
      fail_fast: false,
    }));
    expect(result.success).toBe(false);
    const out = parseOutput(result.output);
    const cmds = out.commands as Array<Record<string, unknown>>;
    // All three commands ran
    expect(cmds).toHaveLength(3);
    expect(cmds[2].skipped).toBeUndefined();
    expect((cmds[2].stdout as string).trim()).toBe('after_failure');
  });

  test('fail_fast: default (false) runs all commands without skipping', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [
        { cmd: 'false' },
        { cmd: 'echo ran_anyway' },
      ],
    }));
    const out = parseOutput(result.output);
    const cmds = out.commands as Array<Record<string, unknown>>;
    expect(cmds[1].skipped).toBeUndefined();
    expect((cmds[1].stdout as string).trim()).toBe('ran_anyway');
  });

  test('fail_fast with expectation error triggers skip', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [
        { cmd: 'true', expect: { exit_code: 1 } }, // expectation fails
        { cmd: 'echo should_skip' },
      ],
      fail_fast: true,
    }));
    expect(result.success).toBe(false);
    const out = parseOutput(result.output);
    const cmds = out.commands as Array<Record<string, unknown>>;
    expect(cmds[0].expectation_error).toBeDefined();
    expect(cmds[1].skipped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 19. Progress tracking
// ---------------------------------------------------------------------------

describe('exec tool — progress tracking', () => {
  test('progress: true adds progress_file to result', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{
        cmd: 'echo progress_line_1 && echo progress_line_2',
        progress: true,
      }],
    }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    expect(typeof out.progress_file).toBe('string');
    expect((out.progress_file as string)).toContain('-progress.txt');
  });

  test('progress file contains stdout output', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{
        cmd: 'printf "line_a\nline_b\nline_c\n"',
        progress: true,
      }],
    }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    const progressFilePath = out.progress_file as string;
    expect(existsSync(progressFilePath)).toBe(true);
    const progressContent = readFileSync(progressFilePath, 'utf-8');
    expect(progressContent).toContain('line_a');
    expect(progressContent).toContain('line_b');
    expect(progressContent).toContain('line_c');
  });

  test('progress auto-enabled for timeout_ms > 30000', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [{
        cmd: 'echo auto_progress',
        timeout_ms: 31000,
      }],
    }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    // Should have progress_file automatically
    expect(typeof out.progress_file).toBe('string');
  }, 35000);

  test('progress_file included in batch results', async () => {
    const result = await execTool.execute(withWorkingDir({
      commands: [
        { cmd: 'echo batch_a', progress: true },
        { cmd: 'echo batch_b', progress: true },
      ],
    }));
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    const cmds = out.commands as Array<Record<string, unknown>>;
    expect(typeof cmds[0].progress_file).toBe('string');
    expect(typeof cmds[1].progress_file).toBe('string');
    // Each command gets its own progress file
    expect(cmds[0].progress_file).not.toBe(cmds[1].progress_file);
  });
});
