#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildVerificationLedger,
  renderVerificationLedgerMarkdown,
} from '../src/verification/verification-ledger.ts';

function readArgValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log([
    'Usage: bun run scripts/verification-ledger.ts [options]',
    '',
    'Options:',
    '  --json       Print JSON instead of Markdown.',
    '  --out <dir>  Write verification-ledger.{json,md} to a directory.',
    '  --help       Show this help.',
  ].join('\n'));
  process.exit(0);
}

const projectRoot = resolve(join(import.meta.dir, '..'));
const ledger = buildVerificationLedger(projectRoot);
const outputDir = readArgValue(args, '--out');
if (outputDir) {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'verification-ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  writeFileSync(join(outputDir, 'verification-ledger.md'), renderVerificationLedgerMarkdown(ledger), 'utf8');
}

console.log(args.includes('--json')
  ? JSON.stringify(ledger, null, 2)
  : renderVerificationLedgerMarkdown(ledger));
