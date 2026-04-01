/**
 * Shared validator infrastructure for write and edit tools.
 * Runs typecheck / lint / test / build and returns structured results.
 */

export type ValidatorName = 'typecheck' | 'lint' | 'test' | 'build';

/** Map validator name to shell command. */
const VALIDATOR_COMMANDS: Record<ValidatorName, string[]> = {
  typecheck: ['npx', 'tsc', '--noEmit'],
  lint: ['npx', 'eslint', '--no-error-on-unmatched-pattern'],
  test: ['bun', 'test'],
  build: ['bun', 'run', 'build'],
};

export interface ValidatorResult {
  validator: ValidatorName;
  passed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a single validator via Bun.spawn. Times out after 30 seconds.
 */
export async function runValidator(name: ValidatorName, cwd: string): Promise<ValidatorResult> {
  const cmd = VALIDATOR_COMMANDS[name];
  const TIMEOUT_MS = 30_000;

  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, TIMEOUT_MS);

  const [exitCode, stdoutBuf, stderrBuf] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  clearTimeout(timeoutHandle);

  if (timedOut) {
    return {
      validator: name,
      passed: false,
      stdout: '',
      stderr: `Validator '${name}' timed out after ${TIMEOUT_MS}ms`,
      exitCode: -1,
    };
  }

  return {
    validator: name,
    passed: exitCode === 0,
    stdout: stdoutBuf,
    stderr: stderrBuf,
    exitCode,
  };
}

/**
 * Run all validators in sequence. Returns array of all failures (or empty array if all pass).
 */
export async function runValidators(
  validators: ValidatorName[],
  cwd: string,
): Promise<ValidatorResult[]> {
  const failures: ValidatorResult[] = [];
  for (const name of validators) {
    const result = await runValidator(name, cwd);
    if (!result.passed) failures.push(result);
  }
  return failures;
}

/** Format a validator failure into a human-readable message. */
export function formatValidatorFailure(result: ValidatorResult): string {
  const parts = [`Validator '${result.validator}' failed (exit ${result.exitCode}):` ];
  if (result.stderr.trim()) parts.push(result.stderr.trim());
  if (result.stdout.trim()) parts.push(result.stdout.trim());
  return parts.join('\n');
}
