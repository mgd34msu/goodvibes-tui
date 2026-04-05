/**
 * Import graph for TypeScript/JavaScript files.
 *
 * Builds a reverse dependency index (dependents map) by scanning the project
 * tree for import/export/require statements. Caches the result and rebuilds
 * when a file is marked as modified.
 *
 * Usage:
 *   const graph = ImportGraph.getInstance();
 *   await graph.build(projectRoot);
 *   const affected = graph.findDependents('/abs/path/to/file.ts');
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Absolute path → set of absolute paths that import it */
export type DependentsMap = Map<string, Set<string>>;

/** Absolute path → set of absolute paths it imports */
export type ImportsMap = Map<string, Set<string>>;

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '.nuxt', '.cache', '__pycache__']);
const MAX_FILES = 5_000;

// ---------------------------------------------------------------------------
// Import extraction (line-by-line, no catastrophic backtracking)
// ---------------------------------------------------------------------------

const IMPORT_RE = /(?:import|export)\s.*?from\s+['"]([^'"]+)['"]/;
const REQUIRE_RE = /require\(['"]([^'"]+)['"]\)/;

/**
 * Extract all module specifiers (import/export/require) from a file's text.
 * Returns only relative specifiers (starting with '.').
 */
function extractRelativeSpecifiers(content: string): string[] {
  const specs: string[] = [];
  for (const line of content.split('\n')) {
    const im = IMPORT_RE.exec(line);
    if (im?.[1]?.startsWith('.')) specs.push(im[1]);
    const rq = REQUIRE_RE.exec(line);
    if (rq?.[1]?.startsWith('.')) specs.push(rq[1]);
  }
  return specs;
}

export const extractRelativeSpecifiersForTest = extractRelativeSpecifiers;

/**
 * Resolve a relative specifier from a source file to an absolute path.
 * Tries common extensions/index files if an exact match doesn't exist.
 */
function resolveSpecifierFromKnownFiles(
  fromFile: string,
  spec: string,
  fileExists: (candidate: string) => boolean,
): string | null {
  const base = resolve(dirname(fromFile), spec);

  // Already an exact file?
  if (fileExists(base)) return base;

  // Try extensions
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']) {
    const candidate = base + ext;
    if (fileExists(candidate)) return candidate;
  }

  // Try index files
  for (const index of ['index.ts', 'index.tsx', 'index.js', 'index.jsx']) {
    const candidate = join(base, index);
    if (fileExists(candidate)) return candidate;
  }

  return null;
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  return resolveSpecifierFromKnownFiles(
    fromFile,
    spec,
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
}

export function resolveSpecifierForTest(
  fromFile: string,
  spec: string,
  knownFiles: Iterable<string>,
): string | null {
  const fileSet = knownFiles instanceof Set ? knownFiles : new Set(knownFiles);
  return resolveSpecifierFromKnownFiles(fromFile, spec, (candidate) => fileSet.has(candidate));
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

function collectSourceFiles(dir: string, results: string[] = []): string[] {
  if (results.length >= MAX_FILES) return results;

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[];
  } catch (err) {
    logger.debug('[import-graph] Skipping unreadable directory', { dir, error: err instanceof Error ? err.message : String(err) });
    return results;
  }

  for (const entry of entries) {
    if (results.length >= MAX_FILES) break;
    if (SKIP_DIRS.has(entry.name)) continue;

    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, results);
    } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name))) {
      results.push(full);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// ImportGraph class
// ---------------------------------------------------------------------------

export class ImportGraph {
  private static _instance: ImportGraph | null = null;

  /** Forward map: file → files it imports */
  private imports: ImportsMap = new Map();

  /** Reverse map: file → files that import it */
  private dependents: DependentsMap = new Map();

  /** Root that was last scanned */
  private scannedRoot: string | null = null;

  /** Whether graph is stale and needs a rebuild */
  private dirty = true;

  constructor() {}

  static getInstance(): ImportGraph {
    if (!ImportGraph._instance) {
      ImportGraph._instance = new ImportGraph();
    }
    return ImportGraph._instance;
  }

  /**
   * Mark the graph as stale. Call this whenever a file has been modified
   * so the next findDependents() call triggers a rebuild.
   */
  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Build (or rebuild) the import graph by scanning all source files under
   * `projectRoot`. Idempotent when not dirty and root hasn't changed.
   */
  async build(projectRoot: string): Promise<void> {
    if (!this.dirty && this.scannedRoot === projectRoot) return;

    const files = collectSourceFiles(projectRoot);
    const imports: ImportsMap = new Map();
    const dependents: DependentsMap = new Map();

    // Ensure every file has an entry, even with no imports
    for (const f of files) {
      if (!imports.has(f)) imports.set(f, new Set());
      if (!dependents.has(f)) dependents.set(f, new Set());
    }

    for (const filePath of files) {
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch (err) {
        logger.debug('[import-graph] Skipping unreadable file', { file: filePath, error: err instanceof Error ? err.message : String(err) });
        continue;
      }

      const specs = extractRelativeSpecifiers(content);
      for (const spec of specs) {
        const resolved = resolveSpecifier(filePath, spec);
        if (!resolved) continue;

        // Forward
        let fwd = imports.get(filePath);
        if (!fwd) {
          fwd = new Set();
          imports.set(filePath, fwd);
        }
        fwd.add(resolved);

        // Reverse
        let rev = dependents.get(resolved);
        if (!rev) {
          rev = new Set();
          dependents.set(resolved, rev);
        }
        rev.add(filePath);
      }
    }

    this.imports = imports;
    this.dependents = dependents;
    this.scannedRoot = projectRoot;
    this.dirty = false;
  }

  /**
   * Build the graph from an in-memory file map for deterministic tests.
   * Keys must be absolute file paths.
   * @internal
   */
  buildFromFilesForTest(files: Record<string, string>): void {
    const knownFiles = new Set(Object.keys(files));
    const imports: ImportsMap = new Map();
    const dependents: DependentsMap = new Map();

    for (const filePath of knownFiles) {
      imports.set(filePath, new Set());
      dependents.set(filePath, new Set());
    }

    for (const [filePath, content] of Object.entries(files)) {
      const specs = extractRelativeSpecifiers(content);
      for (const spec of specs) {
        const resolved = resolveSpecifierFromKnownFiles(filePath, spec, (candidate) => knownFiles.has(candidate));
        if (!resolved) continue;

        imports.get(filePath)!.add(resolved);
        dependents.get(resolved)!.add(filePath);
      }
    }

    this.imports = imports;
    this.dependents = dependents;
    this.scannedRoot = null;
    this.dirty = false;
  }

  /**
   * Return all files that directly import `filePath`.
   * Returns an empty array if the graph hasn't been built or the file isn't known.
   */
  findDependents(filePath: string): string[] {
    return Array.from(this.dependents.get(filePath) ?? []);
  }

  /**
   * Return all files that transitively depend on `filePath`.
   * BFS from the direct dependents.
   */
  findTransitiveDependents(filePath: string): string[] {
    const visited = new Set<string>();
    const queue = [filePath];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const dep of this.dependents.get(current) ?? []) {
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push(dep);
        }
      }
    }

    return Array.from(visited);
  }

  /**
   * Return the set of files `filePath` directly imports.
   * @internal
   */
  findImports(filePath: string): string[] {
    return Array.from(this.imports.get(filePath) ?? []);
  }

  /**
   * Return graph statistics.
   * @internal
   */
  stats(): { files: number; edges: number; scannedRoot: string | null; dirty: boolean } {
    let edges = 0;
    for (const deps of this.imports.values()) {
      edges += deps.size;
    }
    return { files: this.imports.size, edges, scannedRoot: this.scannedRoot, dirty: this.dirty };
  }

  /**
   * Export as a plain object keyed by relative paths (relative to `projectRoot`).
   * Useful for serialization and the analyze tool's `dependencies` mode.
   * @internal
   */
  toRelativeGraph(projectRoot: string): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [file, deps] of this.imports) {
      const key = relative(projectRoot, file);
      result[key] = Array.from(deps).map((d) => relative(projectRoot, d));
    }
    return result;
  }
}
