import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { summarizeError } from '../utils/error-display.ts';

export const WRFC_GATE_TIMEOUT_MS = 120_000;

export async function loadPackageScripts(cwd: string): Promise<Record<string, string>> {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return {};
  try {
    const pkgJson = JSON.parse(await Bun.file(pkgPath).text()) as { scripts?: Record<string, string> };
    return pkgJson.scripts ?? {};
  } catch {
    return {};
  }
}

export function getSkippedGateReason(
  gateName: string,
  cwd: string,
  pkgScripts: Record<string, string>,
): string | null {
  if (gateName === 'typecheck' && !existsSync(join(cwd, 'tsconfig.json'))) {
    return 'Skipped: no tsconfig.json found';
  }
  if (gateName === 'lint') {
    const lintConfigs = [
      'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
      '.eslintrc.json', '.eslintrc.js', '.eslintrc.yml', '.eslintrc.yaml', '.eslintrc',
    ];
    if (!lintConfigs.some((file) => existsSync(join(cwd, file)))) {
      return 'Skipped: no ESLint config found';
    }
  }
  if (gateName === 'test' && !pkgScripts.test) return 'Skipped: no test script in package.json';
  if (gateName === 'build' && !pkgScripts.build) return 'Skipped: no build script in package.json';
  return null;
}

export async function executeGateCommand(command: string): Promise<{ passed: boolean; output: string }> {
  try {
    const proc = Bun.spawn(['/bin/sh', '-c', command], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
    }, WRFC_GATE_TIMEOUT_MS);
    let exitCode: number;
    try {
      exitCode = await proc.exited;
      clearTimeout(timer);
    } catch (error) {
      clearTimeout(timer);
      try { proc.kill(); } catch {}
      throw error;
    }
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return {
      passed: exitCode === 0,
      output: [stdout, stderr].filter(Boolean).join('\n').trim(),
    };
  } catch (error) {
    return {
      passed: false,
      output: summarizeError(error),
    };
  }
}
