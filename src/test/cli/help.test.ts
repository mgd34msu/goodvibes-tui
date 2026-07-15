import { describe, expect, test } from 'bun:test';
import { renderGoodVibesVersion, renderDaemonStartupBanner } from '../../cli/help.ts';
import { VERSION } from '../../version.ts';

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
