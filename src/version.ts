import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read version from package.json at runtime (eliminates build-time sync issues).
// Fallback for compiled binaries where package.json may not be present.
// The prebuild script updates the fallback value before compilation.
// Uses import.meta.dir (Bun) to locate package.json relative to this file,
// which is correct regardless of the process working directory.
let _version = '1.20.0';
try {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf-8'));
  // Only trust a version read from OUR OWN package.json. A Bun single-file
  // compiled binary resolves import.meta.dir to a virtual root where the
  // `../package.json` path can land on a DIFFERENT package.json (a bundled
  // dependency's, or the embedded runtime's) that reports a placeholder like
  // "0.0.0" — exactly the wrong-version banner a bare daemon launch showed in
  // the field. Guarding on the package name means the prebuild-baked fallback
  // above wins in that case instead of a stray version.
  if (pkg?.name === '@pellux/goodvibes-tui' && typeof pkg.version === 'string' && pkg.version.length > 0) {
    _version = pkg.version;
  }
} catch {
  // Compiled binary or missing package.json — use fallback
}

export const VERSION = _version;
