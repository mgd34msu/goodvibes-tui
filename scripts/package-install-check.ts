#!/usr/bin/env bun
import { verifyPackageCliInstall } from '../src/cli/package-verification.ts';

const report = verifyPackageCliInstall(process.cwd());

if (report.issues.length > 0) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

console.log(`package install check passed (${report.bins.length} bins, ${report.tarball.entryCount} packed files)`);
