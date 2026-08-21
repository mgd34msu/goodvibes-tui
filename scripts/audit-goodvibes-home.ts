#!/usr/bin/env bun
import {
  auditGoodVibesHome,
  renderGoodVibesHomeAuditMarkdown,
  writeAuditReportFiles,
} from '../src/config/goodvibes-home-audit.ts';
import { resolveGoodVibesTreeDirectory } from '@pellux/goodvibes-sdk/platform/config';

function readArgValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log([
    'Usage: bun run scripts/audit-goodvibes-home.ts [options]',
    '',
    'Options:',
    '  --home <path>     The .goodvibes directory to audit. Defaults to the tree under',
    '                    GOODVIBES_HOME, or ~/.goodvibes when that is unset.',
    '  --hash            Include sha256 hashes for files in the JSON report.',
    '  --json            Print JSON instead of Markdown.',
    '  --out <dir>       Write goodvibes-home-audit.{json,md} to a directory.',
    '  --help            Show this help.',
  ].join('\n'));
  process.exit(0);
}

// GOODVIBES_HOME names the tree ROOT, and the tree is derived from it, the
// one meaning the runtime uses. This script used to read the variable as the
// .goodvibes directory itself, so a redirected round audited a different place
// than the one it had just written to. `--home` still names a .goodvibes
// directory directly, for auditing a tree that sits under no home at all.
const homeDir = readArgValue(args, '--home') ?? resolveGoodVibesTreeDirectory();
const outputDir = readArgValue(args, '--out');
const audit = await auditGoodVibesHome({
  homeDir,
  includeHashes: args.includes('--hash'),
});

if (outputDir) {
  writeAuditReportFiles(audit, outputDir);
}

if (args.includes('--json')) {
  console.log(JSON.stringify(audit, null, 2));
} else {
  console.log(renderGoodVibesHomeAuditMarkdown(audit));
}
