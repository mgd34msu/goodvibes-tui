/**
 * Daemon update-artifact resolution (src/daemon/lifecycle.ts).
 *
 * The SDK DaemonServer facade now owns the self-update loop when handed a
 * DaemonUpdateArtifact ({version, execPath}); the facade does NOT gate on
 * install-kind, so resolveDaemonUpdateArtifact is the guard that hands it an
 * artifact ONLY for a compiled binary install — a dev/source or bun-global
 * package install resolves to `undefined` (host-managed, no swap loop).
 *
 * Versions here are injected fixtures — never the live build VERSION.
 */
import { describe, expect, test } from 'bun:test';
import { resolveDaemonUpdateArtifact } from '../../daemon/lifecycle.ts';

const FIXTURE_VERSION = '9.9.9-test';

describe('resolveDaemonUpdateArtifact', () => {
  test('a compiled binary install resolves to the host version + exec path', () => {
    const artifact = resolveDaemonUpdateArtifact({ execPath: '/usr/local/bin/goodvibes', version: FIXTURE_VERSION });
    expect(artifact).toEqual({ version: FIXTURE_VERSION, execPath: '/usr/local/bin/goodvibes' });
  });

  test('a dev/source run (bun interpreter) resolves to undefined — host-managed, no loop', () => {
    expect(resolveDaemonUpdateArtifact({ execPath: '/usr/bin/bun', version: FIXTURE_VERSION })).toBeUndefined();
  });

  test('a bun-global package install resolves to undefined — never swaps a package install', () => {
    expect(
      resolveDaemonUpdateArtifact({ execPath: '/home/u/.bun/install/global/node_modules/.bin/goodvibes', version: FIXTURE_VERSION }),
    ).toBeUndefined();
  });
});
