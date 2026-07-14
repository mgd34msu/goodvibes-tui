import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read version from package.json at runtime (eliminates build-time sync issues).
// Fallback for compiled binaries where package.json may not be present.
// The prebuild script updates the fallback value before compilation.
// Uses import.meta.dir (Bun) to locate package.json relative to this file,
// which is correct regardless of the process working directory.
let _version = '1.18.0';
try {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf-8'));
  _version = pkg.version ?? _version;
} catch {
  // Compiled binary or missing package.json — use fallback
}

export const VERSION = _version;
