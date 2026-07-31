import { describe, expect, test } from 'bun:test';
import { renderGoodVibesVersion, renderDaemonStartupBanner } from '../../cli/help.ts';
import { resolveRuntimeEndpointBinding } from '../../cli/endpoints.ts';
import { resolveWebPort } from '@pellux/goodvibes-sdk/platform/daemon';
import { VERSION } from '../../version.ts';
import type { ConfigManager } from '../../config/index.ts';

describe('CLI help/version', () => {
  test('does not report the consuming project npm_package_version', () => {
    const previous = process.env.npm_package_version;
    // Sentinel that can never equal the real build version — the original
    // test used '1.0.0', which collided with reality at the v1.0.0 release
    // and failed the release validate job.
    const sentinel = '99.99.99-npm-env-sentinel';
    process.env.npm_package_version = sentinel;

    try {
      const rendered = renderGoodVibesVersion();
      expect(rendered).not.toBe(`goodvibes ${sentinel}`);
      expect(rendered).toBe(`goodvibes ${VERSION}`);
    } finally {
      if (previous === undefined) {
        delete process.env.npm_package_version;
      } else {
        process.env.npm_package_version = previous;
      }
    }
  });

  test('renderGoodVibesVersion never renders the 0.0.0 placeholder', () => {
    // The name-guard in getPackageVersion() means a stray package.json can never
    // leak "0.0.0" into the version string; the resolved value is the real
    // prebuild-baked VERSION.
    expect(renderGoodVibesVersion('goodvibes-daemon')).toBe(`goodvibes-daemon ${VERSION}`);
    expect(renderGoodVibesVersion('goodvibes-daemon')).not.toContain('0.0.0');
  });
});

describe('daemon startup banner', () => {
  // A sentinel version that can never equal the live build — the banner must
  // render exactly what it is handed, so the daemon's bare-launch path shows
  // the resolved version (not a placeholder) and its actual home/host/port.
  const SENTINEL = '42.42.42-daemon-banner-sentinel';

  test('renders the resolved version and the bound home/host/port', () => {
    const line = renderDaemonStartupBanner(SENTINEL, {
      homeDir: '/home/mike',
      host: '127.0.0.1',
      port: 3421,
    });
    expect(line).toBe(
      'goodvibes-daemon 42.42.42-daemon-banner-sentinel starting — ' +
        'home=/home/mike host=127.0.0.1 port=3421 ' +
        '(manage as a service: goodvibes-daemon install-service)',
    );
  });

  test('points a bare launch at the real service setup instead of a bare banner', () => {
    const line = renderDaemonStartupBanner(SENTINEL, { homeDir: '/h', host: '127.0.0.1', port: 8080 });
    expect(line).toContain('install-service');
    expect(line).toContain('42.42.42-daemon-banner-sentinel');
    // The version segment is exactly the sentinel — never a 0.0.0 placeholder.
    expect(line).toContain('goodvibes-daemon 42.42.42-daemon-banner-sentinel starting');
  });
});

/**
 * The banner's host/port come from resolveRuntimeEndpointBinding — the SAME
 * hostMode-aware resolution the SDK bind path (resolveHostBinding) uses. These
 * tests mirror the verifier's empirical probes: each case pins that what the
 * banner would display matches what the daemon actually binds.
 */
describe('daemon startup banner — binding honesty (mirrors the SDK bind path)', () => {
  function fakeConfig(values: Record<string, unknown>): Pick<ConfigManager, 'get'> {
    // Cast through unknown: the SDK's ConfigValue mapped type has grown into a
    // very large discriminated union, and asking the compiler to structurally
    // compare a generic `<K extends ConfigKey>(key: K) => ConfigValue<K>`
    // signature against ConfigManager['get'] here hits TS's "excessive stack
    // depth" recursion limit (TS2321) — a compiler limitation, not a real type
    // mismatch (this is the exact same generic signature ConfigManager.get
    // itself declares).
    const get = (key: string): unknown => values[key];
    return { get } as unknown as Pick<ConfigManager, 'get'>;
  }

  test("hostMode 'network' with host at its default 127.0.0.1 → banner says 0.0.0.0 (what the daemon binds), not 127.0.0.1", () => {
    // Verifier probe: settings.json hostMode=network, host default → daemon
    // binds 0.0.0.0:3421 while the old banner printed host=127.0.0.1.
    const binding = resolveRuntimeEndpointBinding(
      fakeConfig({ 'controlPlane.hostMode': 'network', 'controlPlane.host': '127.0.0.1', 'controlPlane.port': 3421 }),
      'controlPlane',
    );
    expect(binding.host).toBe('0.0.0.0');
    const line = renderDaemonStartupBanner('42.42.42-s', { homeDir: '/h', host: binding.host, port: binding.port });
    expect(line).toContain('host=0.0.0.0 port=3421');
  });

  test("hostMode 'local' (default) with controlPlane.host hand-set to 0.0.0.0 → banner says 127.0.0.1 (the actual bind)", () => {
    // Inverse verifier probe: --config controlPlane.host=0.0.0.0 with default
    // hostMode=local → daemon binds 127.0.0.1 while the old banner claimed 0.0.0.0.
    const binding = resolveRuntimeEndpointBinding(
      fakeConfig({ 'controlPlane.host': '0.0.0.0', 'controlPlane.port': 3421 }),
      'controlPlane',
    );
    expect(binding.host).toBe('127.0.0.1');
    const line = renderDaemonStartupBanner('42.42.42-s', { homeDir: '/h', host: binding.host, port: binding.port });
    expect(line).toContain('host=127.0.0.1 port=3421');
  });

  test("hostMode 'custom' honors the configured host", () => {
    const binding = resolveRuntimeEndpointBinding(
      fakeConfig({ 'controlPlane.hostMode': 'custom', 'controlPlane.host': '192.168.1.50', 'controlPlane.port': 3421 }),
      'controlPlane',
    );
    expect(binding.host).toBe('192.168.1.50');
  });

  test('port 0 falls back to 3421 exactly like the bind path — the banner never says port=0', () => {
    // Verifier probe: controlPlane.port: 0 → daemon serves 3421, old banner said port=0.
    const binding = resolveRuntimeEndpointBinding(
      fakeConfig({ 'controlPlane.port': 0 }),
      'controlPlane',
    );
    expect(binding.port).toBe(3421);
  });

  test('a non-numeric port falls back to 3421 exactly like the bind path — the banner never says port=NaN', () => {
    // Verifier probe: controlPlane.port: "abc" → daemon serves 3421, old banner said port=NaN.
    const binding = resolveRuntimeEndpointBinding(
      fakeConfig({ 'controlPlane.port': 'abc' }),
      'controlPlane',
    );
    expect(binding.port).toBe(3421);
  });

  test("unrecognized hostMode strings ('LAN', 'Network', '') are flagged recognized:false — the SDK bind path has no default case for them and the daemon cannot bind", () => {
    // Pins the verifier's fixture: the SDK's resolveHostBinding is a switch
    // with NO default case, so these values yield an undefined binding and the
    // daemon throws in its constructor. The display resolver must not present
    // its loopback fallback as a definite binding for a config the SDK cannot
    // bind at all — recognized:false is the signal callers warn on.
    for (const badMode of ['LAN', 'Network', '', 'local ']) {
      const binding = resolveRuntimeEndpointBinding(
        fakeConfig({ 'controlPlane.hostMode': badMode, 'controlPlane.port': 3421 }),
        'controlPlane',
      );
      expect(binding.recognized).toBe(false);
      expect(binding.hostMode).toBe(badMode);
    }
    // The three SDK-recognized modes are affirmatively recognized.
    for (const goodMode of ['local', 'network', 'custom']) {
      const binding = resolveRuntimeEndpointBinding(
        fakeConfig({ 'controlPlane.hostMode': goodMode }),
        'controlPlane',
      );
      expect(binding.recognized).toBe(true);
    }
    // Unset hostMode defaults to 'local' — recognized, exactly like the SDK's
    // own `?? 'local'`.
    expect(resolveRuntimeEndpointBinding(fakeConfig({}), 'controlPlane').recognized).toBe(true);
  });

  test("web port is the SDK's resolveWebPort, called rather than copied", () => {
    // This used to assert the copy's semantics — a bare `Number(raw ?? 3423)`,
    // so a stored 0 displayed as 0 and a non-numeric value as NaN — because
    // that was what the SDK's web machinery did and a display must not
    // disagree with the machinery. The SDK closed that gap: resolveWebBinding
    // validates, and surface announcements, channel account links and
    // tailscale-serve all anchor to it. So the assertion is the same one it
    // always was — agreement — against the function itself rather than against
    // a transcription of what it used to do.
    for (const stored of [0, 'abc', 8080, undefined]) {
      expect(resolveRuntimeEndpointBinding(fakeConfig(stored === undefined ? {} : { 'web.port': stored }), 'web').port)
        .toBe(resolveWebPort(stored));
    }
    expect(resolveRuntimeEndpointBinding(fakeConfig({}), 'web').port).toBe(3423);
    // controlPlane/httpListener keep the resolveHostBinding-anchored collapse.
    expect(resolveRuntimeEndpointBinding(fakeConfig({ 'controlPlane.port': 0 }), 'controlPlane').port).toBe(3421);
    expect(resolveRuntimeEndpointBinding(fakeConfig({ 'httpListener.port': 'abc' }), 'httpListener').port).toBe(3422);
  });

  test('GOODVIBES_DAEMON_HOST in the environment does not influence the displayed binding (the bind path never reads it)', () => {
    // Verifier probe: Environment=GOODVIBES_DAEMON_HOST=0.0.0.0 in the unit →
    // daemon binds per config (local → 127.0.0.1) while the old banner printed
    // the env value. The binding resolution reads config ONLY.
    const previous = process.env.GOODVIBES_DAEMON_HOST;
    process.env.GOODVIBES_DAEMON_HOST = '0.0.0.0';
    try {
      const binding = resolveRuntimeEndpointBinding(fakeConfig({}), 'controlPlane');
      expect(binding.host).toBe('127.0.0.1');
      expect(binding.port).toBe(3421);
    } finally {
      if (previous === undefined) delete process.env.GOODVIBES_DAEMON_HOST;
      else process.env.GOODVIBES_DAEMON_HOST = previous;
    }
  });
});
