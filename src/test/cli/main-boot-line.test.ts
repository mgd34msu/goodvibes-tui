/**
 * main-boot-line.test.ts, item 8: one honest pre-alt-screen "starting…" line.
 *
 * main() is the full application composition root (bootstraps every runtime
 * subsystem, enters raw/alt-screen terminal mode, and only returns when the
 * process exits), not something reasonably unit-testable end-to-end without
 * spawning a real interactive terminal loop. This pins the source shape
 * instead, the same convention src/test/cli/ensure-goodvibes-gitignore.test.ts
 * already uses for entrypoint wiring:
 *   - exactly one boot-line write exists.
 *   - it appears AFTER prepareShellCliRuntime() returns, so --help/--version/
 *     --completion (which exit from inside that call) stay byte-clean.
 *   - it appears BEFORE the alt-screen is entered, so it lands on the user's
 *     real shell prompt, not inside the TUI's own screen buffer.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mainSrc = readFileSync(join(import.meta.dir, '../../main.ts'), 'utf-8');

describe('main() boot line (item 8)', () => {
  test('prints exactly one honest "starting…" line naming the version', () => {
    const matches = mainSrc.match(/stdout\.write\(`goodvibes v\$\{VERSION\} starting…\\n`\)/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  test('the boot line appears after prepareShellCliRuntime returns (help/version/completion exit before it)', () => {
    const prepareCallIdx = mainSrc.indexOf('await prepareShellCliRuntime(');
    const bootLineIdx = mainSrc.indexOf('stdout.write(`goodvibes v${VERSION} starting…\\n`)');
    expect(prepareCallIdx).toBeGreaterThan(-1);
    expect(bootLineIdx).toBeGreaterThan(-1);
    expect(bootLineIdx).toBeGreaterThan(prepareCallIdx);
  });

  test('the boot line appears before the alt-screen is entered', () => {
    const bootLineIdx = mainSrc.indexOf('stdout.write(`goodvibes v${VERSION} starting…\\n`)');
    const altScreenEnterIdx = mainSrc.indexOf('ALT_SCREEN_ENTER');
    // ALT_SCREEN_ENTER is imported near the top; find its actual USE (the
    // stdout.write call that enters the alt screen), not the import line.
    const altScreenWriteIdx = mainSrc.indexOf('ALT_SCREEN_ENTER', altScreenEnterIdx + 1);
    expect(bootLineIdx).toBeGreaterThan(-1);
    expect(altScreenWriteIdx).toBeGreaterThan(-1);
    expect(bootLineIdx).toBeLessThan(altScreenWriteIdx);
  });

  test('VERSION is imported', () => {
    expect(mainSrc).toContain("import { VERSION } from './version.ts';");
  });
});
