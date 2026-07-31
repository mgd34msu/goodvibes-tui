import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { parseGoodVibesCli } from '@pellux/goodvibes-terminal-shell';
import { buildControlPlaneStatusResult, formatControlPlaneStatus } from '../../cli/management-commands.ts';
import { buildListenerTestResult, formatListenerTestResult } from '../../cli/surface-command.ts';
import type { CliCommandRuntime } from '@pellux/goodvibes-terminal-shell';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * Mirrors the verifier's live probe: a daemon can be serving an endpoint
 * healthily (flag overrides at launch) while the STORED hostMode is an
 * unrecognized value — 'not probed' must therefore be its own tri-state on
 * every surface: text says not probed, JSON omits the field (undefined),
 * NEVER a definite `reachable: no` / `"reachable": false` for an endpoint a
 * daemon demonstrably answers.
 */
describe('endpoint display honesty — not-probed is a tri-state, never coerced to false', () => {
  const scratch = makeProjectTempDir('gv-display-honesty');
  // A real listener: the "daemon demonstrably answering" in the verifier's probe.
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data() { /* accept + ignore */ } },
  });

  afterAll(() => {
    listener.stop(true);
    rmSync(scratch, { recursive: true, force: true });
  });

  function fakeRuntime(values: Record<string, unknown>): CliCommandRuntime {
    return {
      cli: parseGoodVibesCli([], 'goodvibes'),
      configManager: { get: (key: string) => values[key] } as CliCommandRuntime['configManager'],
      workingDirectory: scratch,
      homeDirectory: scratch,
    };
  }

  test('control-plane status: unrecognized hostMode + live listener → reachable undefined, text "not probed", JSON never claims false', async () => {
    const runtime = fakeRuntime({
      'controlPlane.enabled': true,
      'controlPlane.hostMode': 'LAN', // set()-bypassing hand edit
      'controlPlane.host': '127.0.0.1',
      'controlPlane.port': listener.port,
    });

    const value = await buildControlPlaneStatusResult(runtime);
    expect(value.reachable).toBeUndefined();
    // JSON consumers never see a definite false for a not-probed endpoint.
    expect(JSON.stringify(value)).not.toContain('"reachable":false');

    const text = formatControlPlaneStatus(runtime, value);
    expect(text).toContain('reachable: not probed (unrecognized host mode)');
    expect(text).not.toMatch(/reachable: no\b/);
  });

  test('control-plane status control run: a RECOGNIZED mode probes the same listener and honestly reports yes', async () => {
    const runtime = fakeRuntime({
      'controlPlane.enabled': true,
      'controlPlane.hostMode': 'local',
      'controlPlane.host': '127.0.0.1',
      'controlPlane.port': listener.port,
    });

    const value = await buildControlPlaneStatusResult(runtime);
    expect(value.reachable).toBe(true);
    expect(formatControlPlaneStatus(runtime, value)).toContain('reachable: yes');
  });

  test('listener test: unrecognized hostMode + live listener → reachable undefined, text "not probed", JSON never claims false', async () => {
    const runtime = fakeRuntime({
      'danger.httpListener': true,
      'httpListener.hostMode': 'LAN',
      'httpListener.host': '127.0.0.1',
      'httpListener.port': listener.port,
    });

    const value = await buildListenerTestResult(runtime);
    expect(value.reachable).toBeUndefined();
    expect(JSON.stringify(value)).not.toContain('"reachable":false');

    const text = formatListenerTestResult(runtime, value);
    expect(text).toContain('reachable: not probed (unrecognized host mode)');
    expect(text).not.toMatch(/reachable: no\b/);
  });

  test('a disabled endpoint keeps the definite reachable: no (nothing should be listening — pre-existing semantics)', async () => {
    const runtime = fakeRuntime({
      'controlPlane.enabled': false,
      'controlPlane.hostMode': 'local',
      'controlPlane.port': listener.port,
    });

    const value = await buildControlPlaneStatusResult(runtime);
    expect(value.reachable).toBe(false);
    expect(formatControlPlaneStatus(runtime, value)).toContain('reachable: no');
  });
});
