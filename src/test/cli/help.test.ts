import { describe, expect, test } from 'bun:test';
import { renderGoodVibesVersion } from '../../cli/help.ts';
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
});
