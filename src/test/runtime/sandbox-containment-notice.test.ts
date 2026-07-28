import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { createSandboxContainmentNotice } from '../../runtime/daemon-attach-notices.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let dir: string;

beforeEach(() => { dir = makeProjectTempDir('gv-sandbox-notice'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('createSandboxContainmentNotice', () => {
  test('the first contained run surfaces the once-only line; later runs are silent', () => {
    const notified: string[] = [];
    const announce = createSandboxContainmentNotice({
      configManager: { getControlPlaneConfigDir: () => dir },
      notify: (text) => notified.push(text),
    });

    announce();
    expect(notified).toEqual(['commands now run contained; escalations will ask']);

    announce();
    announce();
    // Announce-once: no further lines.
    expect(notified).toHaveLength(1);
  });
});
