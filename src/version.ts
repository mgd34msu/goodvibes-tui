import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read version from package.json at runtime (eliminates build-time sync issues).
// Fallback for compiled binaries where package.json may not be present.
// The prebuild script updates the fallback value before compilation.
let _version = '0.9.10';
try {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
  _version = pkg.version ?? _version;
} catch {
  // Compiled binary or missing package.json — use fallback
}

export const VERSION = _version;
