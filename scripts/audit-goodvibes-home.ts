#!/usr/bin/env bun
import {
  auditGoodVibesHome,
  renderGoodVibesHomeAuditMarkdown,
  writeAuditReportFiles,
} from '../src/config/goodvibes-home-audit.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
    '  --home <path>     GoodVibes home directory to audit. Defaults to ~/.goodvibes.',
    '  --hash            Include sha256 hashes for files in the JSON report.',
    '  --json            Print JSON instead of Markdown.',
    '  --out <dir>       Write goodvibes-home-audit.{json,md} to a directory.',
    '  --help            Show this help.',
  ].join('\n'));
  process.exit(0);
}

const homeDir = readArgValue(args, '--home') ?? process.env.GOODVIBES_HOME ?? join(homedir(), '.goodvibes');
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
