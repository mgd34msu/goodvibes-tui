import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Prebuild script — reads version from package.json and updates:
 *   1. src/version.ts (VERSION export used by splash, header, daemon)
 *   2. README.md (Version: **X.Y.Z** badge)
 *
 * package.json is the single source of truth for the version number.
 * Run via: bun run prebuild (automatically runs before bun run build)
 */
try {
  const root = process.cwd();
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const version = pkg.version;

  // 1. src/version.ts — update the fallback version for compiled binaries
  const versionTsPath = join(root, 'src/version.ts');
  try {
    let versionTs = readFileSync(versionTsPath, 'utf8');
    versionTs = versionTs.replace(/let _version = '[^']*'/, `let _version = '${version}'`);
    writeFileSync(versionTsPath, versionTs);
    console.log(`prebuild: src/version.ts fallback → ${version}`);
  } catch {
    console.log('prebuild: src/version.ts — not found, skipping');
  }

  // 2. README.md — update "Version: **X.Y.Z**" line
  const readmePath = join(root, 'README.md');
  try {
    let readme = readFileSync(readmePath, 'utf8');
    const versionRe = /Version: \*\*[^*]+\*\*/;
    if (versionRe.test(readme)) {
      readme = readme.replace(versionRe, `Version: **${version}**`);
      writeFileSync(readmePath, readme);
      console.log(`prebuild: README.md → ${version}`);
    } else {
      console.log('prebuild: README.md — no version badge found, skipping');
    }
  } catch {
    console.log('prebuild: README.md — not found, skipping');
  }

  console.log(`prebuild: done (v${version})`);
} catch (error) {
  console.error('prebuild: failed —', error);
  process.exit(1);
}
