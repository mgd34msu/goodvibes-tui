/**
 * GC-ARCH-001: Domain Import Boundary Contract
 *
 * Scans every domain slice in src/runtime/store/domains/ and verifies that
 * no file imports from a sibling domain unless the cross-domain read is
 * explicitly authorized in domain-read-matrix.ts.
 *
 * Failure indicates an unauthorized architectural coupling between domains.
 * Fix: either add the import to DOMAIN_READ_MATRIX (with rationale) or
 * refactor to use selectors instead of direct domain imports.
 */

import { describe, test, expect } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  DOMAINS,
  DOMAIN_READ_MATRIX,
  getAllowedReadsFor,
  type DomainName,
} from '../../runtime/store/domains/domain-read-matrix.ts';

const DOMAINS_DIR = resolve(
  import.meta.dir,
  '../../runtime/store/domains',
);

/** Extract all relative same-directory import paths from a TS source file. */
function extractLocalImports(source: string): string[] {
  // Match: import ... from './something' or import ... from './something.ts'
  const importRe = /from\s+['"](\.\/.+?)['"]/g;
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source)) !== null) {
    results.push(match[1]);
  }
  return results;
}

/** Resolve an import specifier like './daemon.ts' or './daemon' to a domain name. */
function specifierToDomain(specifier: string): DomainName | null {
  // Strip leading ./ and trailing .ts extension
  const base = specifier.replace(/^\.\//u, '').replace(/\.ts$/u, '');
  return (DOMAINS as readonly string[]).includes(base)
    ? (base as DomainName)
    : null;
}

describe('GC-ARCH-001 domain import boundary contract', () => {
  test('DOMAIN_READ_MATRIX covers only known domain names', () => {
    for (const entry of DOMAIN_READ_MATRIX) {
      expect(
        (DOMAINS as readonly string[]).includes(entry.reader),
        `Matrix reader '${entry.reader}' is not a known domain`,
      ).toBe(true);

      for (const dep of entry.reads) {
        expect(
          (DOMAINS as readonly string[]).includes(dep),
          `Matrix read target '${dep}' is not a known domain`,
        ).toBe(true);
      }
    }
  });

  test('DOMAINS array matches filesystem domain files', async () => {
    const dir = DOMAINS_DIR;
    const files = await readdir(dir);
    const domainFiles = files
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts' && f !== 'domain-read-matrix.ts')
      .map((f) => f.replace(/\.ts$/u, ''));

    // Every file in directory should be in DOMAINS
    for (const file of domainFiles) {
      expect(DOMAINS).toContain(file);
    }
    // Every entry in DOMAINS should have a file
    for (const domain of DOMAINS) {
      expect(domainFiles).toContain(domain);
    }
  });

  test('no unauthorized cross-domain imports exist in domain slice files', async () => {
    const files = await readdir(DOMAINS_DIR);
    const domainFiles = files.filter(
      (f) => f.endsWith('.ts') && f !== 'index.ts' && f !== 'domain-read-matrix.ts',
    );

    const violations: string[] = [];

    for (const file of domainFiles) {
      const domainName = file.replace(/\.ts$/u, '') as DomainName;

      // Skip files that are not in the canonical domain list
      if (!(DOMAINS as readonly string[]).includes(domainName)) {
        continue;
      }

      const source = await readFile(join(DOMAINS_DIR, file), 'utf8');
      const localImports = extractLocalImports(source);
      const allowedReads = getAllowedReadsFor(domainName);

      for (const specifier of localImports) {
        const importedDomain = specifierToDomain(specifier);

        // Not a domain import — skip (e.g. relative import to a non-domain file)
        if (importedDomain === null) continue;

        if (!allowedReads.has(importedDomain)) {
          violations.push(
            `UNAUTHORIZED: ${domainName}.ts imports from ${importedDomain}.ts ` +
            `(not listed in DOMAIN_READ_MATRIX)`,
          );
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Domain boundary violations found:\n` +
        violations.map((v) => `  • ${v}`).join('\n') +
        `\n\nFix: add authorized reads to domain-read-matrix.ts or refactor to use selectors.`,
      );
    }

    expect(violations).toHaveLength(0);
  });

  test('getAllowedReadsFor always includes the reader itself', () => {
    for (const domain of DOMAINS) {
      const allowed = getAllowedReadsFor(domain);
      expect(allowed.has(domain)).toBe(true);
    }
  });

  test('acp is authorized to read daemon (only current cross-domain import)', () => {
    const allowedForAcp = getAllowedReadsFor('acp');
    expect(allowedForAcp.has('daemon')).toBe(true);
  });

  test('domains with no matrix entry have no cross-domain read rights', () => {
    const matrixReaders = new Set(DOMAIN_READ_MATRIX.map((e) => e.reader));

    for (const domain of DOMAINS) {
      if (!matrixReaders.has(domain)) {
        const allowed = getAllowedReadsFor(domain);
        // Only self-import is allowed
        expect(allowed.size).toBe(1);
        expect(allowed.has(domain)).toBe(true);
      }
    }
  });
});
