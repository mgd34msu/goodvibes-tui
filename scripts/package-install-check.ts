#!/usr/bin/env bun
/**
 * package-install-check.ts, static "as it would install" verification.
 *
 * The shared tarball path/size policy + bin-shim (present/executable/shebang)
 * checks are owned by @pellux/goodvibes-toolchain and driven by this repo's
 * toolchain.config.json (publish section). The TUI-specific bin-FALLBACK
 * verification (local-platform dist, local dist, vendored-binary, and Bun-source
 * fallbacks baked into bin/goodvibes*) stays in src/cli/package-verification.ts,
 * which is product source with its own unit test.
 */
import {
  loadToolchainConfig,
  runPackageInstallCheck,
} from '@pellux/goodvibes-toolchain';
import { verifyPackageCliInstall } from '../src/cli/package-verification.ts';

const root = process.cwd();
const config = loadToolchainConfig(root);
let failed = 0;

// Shared tarball + bin-shim policy (toolchain, config-driven).
if (config.publish) {
  const install = runPackageInstallCheck({
    cwd: root,
    config: config.publish,
    bins: [
      { name: 'goodvibes', path: 'bin/goodvibes', shebang: '#!/usr/bin/env bun' },
    ],
  });
  for (const issue of install.issues) console.error(`package-install-check: ${issue}`);
  if (!install.ok) failed += 1;
}

// TUI-specific bin-fallback verification.
const report = verifyPackageCliInstall(root);
if (report.issues.length > 0) {
  console.error(JSON.stringify(report, null, 2));
  failed += 1;
}

if (failed > 0) process.exit(1);
console.log(`package install check passed (${report.bins.length} bins, ${report.tarball.entryCount} packed files)`);
