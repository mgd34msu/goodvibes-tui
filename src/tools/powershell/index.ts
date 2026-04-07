import { spawnSync } from 'node:child_process';
import type { Tool } from '../../types/tools.ts';
import { POWERSHELL_TOOL_SCHEMA, type PowershellToolInput } from './schema.ts';

function detectPowerShell(): { available: boolean; binary: string | null } {
  for (const binary of ['pwsh', 'powershell']) {
    const result = spawnSync(binary, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf-8',
      timeout: 1500,
    });
    if (!result.error && result.status === 0) {
      return { available: true, binary };
    }
  }
  return { available: false, binary: null };
}

export const powershellTool: Tool = {
  definition: {
    name: 'powershell',
    description: 'Inspect PowerShell availability and run a bounded PowerShell command when pwsh is installed.',
    parameters: POWERSHELL_TOOL_SCHEMA.parameters,
    sideEffects: ['exec', 'state'],
    concurrency: 'serial',
  },

  async execute(args: Record<string, unknown>) {
    if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
      return { success: false, error: 'Invalid args: mode is required.' };
    }
    const input = args as unknown as PowershellToolInput;
    const detected = detectPowerShell();

    if (input.mode === 'availability') {
      return {
        success: true,
        output: JSON.stringify({
          available: detected.available,
          binary: detected.binary,
          platform: process.platform,
        }),
      };
    }

    if (!detected.available || !detected.binary) {
      return { success: false, error: 'PowerShell is not installed on this host.' };
    }
    if (!input.command) {
      return { success: false, error: 'exec requires command.' };
    }
    const result = spawnSync(detected.binary, ['-NoLogo', '-NoProfile', '-Command', input.command], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (result.error) {
      return { success: false, error: String(result.error) };
    }
    if (result.status !== 0) {
      return { success: false, error: result.stderr?.trim() || `PowerShell exited with status ${result.status}` };
    }
    return { success: true, output: result.stdout.trim() };
  },
};
