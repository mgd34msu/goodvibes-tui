#!/usr/bin/env bun
/**
 * verify-release-tag-version.ts, the pushed/dispatched release tag must equal
 * `v${package.json version}`. Ported from goodvibes-daemon's script of the same
 * name so all three repos fail the same way on a mismatched tag.
 *
 * Usage: bun scripts/verify-release-tag-version.ts
 * Reads GITHUB_REF_NAME from the environment (set by GitHub Actions for both a
 * tag push and a workflow_dispatch running at a tag ref).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
const version = pkg.version;
if (typeof version !== 'string' || version.length === 0) {
  console.error('ERROR: could not read a version string from package.json.');
  process.exit(1);
}

const tagName = process.env.GITHUB_REF_NAME;
if (!tagName) {
  console.error('ERROR: GITHUB_REF_NAME is required for release tag verification.');
  process.exit(1);
}

const expectedTag = `v${version}`;
if (tagName !== expectedTag) {
  console.error(`ERROR: Git tag '${tagName}' does not match package.json version '${version}' (expected tag: '${expectedTag}').`);
  process.exit(1);
}

console.log(`Tag verification OK: ${tagName} == ${expectedTag}`);
