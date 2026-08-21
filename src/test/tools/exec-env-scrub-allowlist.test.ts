/**
 * Exercises the credentialEnvScrub seam createExecTool exposes (SDK 1.6.1
 * repack) end-to-end: an operator-configured allowlist name survives the
 * scrub while an unlisted credential-looking name is still withheld. This is
 * the runtime counterpart to settings-modal-sandbox-exec.test.ts, which only
 * covers the config-storage side (permissions.execEnvScrubAllowlist).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createExecTool } from '@pellux/goodvibes-sdk/platform/tools';
import { ProcessManager } from '@pellux/goodvibes-sdk/platform/tools';
import { OverflowHandler } from '@pellux/goodvibes-sdk/platform/tools';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function parseOutput(output: string | undefined): Record<string, unknown> {
  if (!output) throw new Error('No output');
  return JSON.parse(output) as Record<string, unknown>;
}

describe('exec tool: credentialEnvScrub allowlist wiring', () => {
  let execRoot: string;
  const ALLOWED_NAME = 'GV_TEST_SECRET_TOKEN';
  const UNLISTED_NAME = 'GV_TEST_OTHER_SECRET_TOKEN';

  beforeEach(() => {
    execRoot = makeProjectTempDir('exec-scrub-allowlist-test');
    process.env[ALLOWED_NAME] = 'allowed-value';
    process.env[UNLISTED_NAME] = 'other-value';
  });

  afterEach(() => {
    delete process.env[ALLOWED_NAME];
    delete process.env[UNLISTED_NAME];
  });

  test('an allowlisted name is kept in the spawned environment and never reported withheld', async () => {
    const execTool = createExecTool(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: execRoot }),
      credentialEnvScrub: { allowlist: [ALLOWED_NAME] },
    });
    const result = await execTool.execute({ working_dir: execRoot, commands: [{ cmd: `echo $${ALLOWED_NAME}` }] });
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    expect((out.stdout as string).trim()).toBe('allowed-value');
    const withheld = (out.withheld_env as string[] | undefined) ?? [];
    expect(withheld).not.toContain(ALLOWED_NAME);
  });

  test('a name NOT on the allowlist is still withheld by the default credential-name scrub', async () => {
    const execTool = createExecTool(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: execRoot }),
      credentialEnvScrub: { allowlist: [ALLOWED_NAME] },
    });
    const result = await execTool.execute({ working_dir: execRoot, commands: [{ cmd: `echo "[$${UNLISTED_NAME}]"` }] });
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    expect((out.stdout as string).trim()).toBe('[]');
    const withheld = (out.withheld_env as string[] | undefined) ?? [];
    expect(withheld).toContain(UNLISTED_NAME);
  });

  test('with no allowlist configured, the same name is withheld by the built-in default', async () => {
    const execTool = createExecTool(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: execRoot }),
    });
    const result = await execTool.execute({ working_dir: execRoot, commands: [{ cmd: `echo "[$${ALLOWED_NAME}]"` }] });
    expect(result.success).toBe(true);
    const out = parseOutput(result.output);
    expect((out.stdout as string).trim()).toBe('[]');
    const withheld = (out.withheld_env as string[] | undefined) ?? [];
    expect(withheld).toContain(ALLOWED_NAME);
  });
});
